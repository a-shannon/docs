import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as wasm from 'ergo-lib-wasm-nodejs';
import {verifyCreditOutputs} from './credit-output-policy.mjs';

const fixture=JSON.parse(readFileSync(new URL('../guard-service/src/deposit/fixtures/credit-signing.json',import.meta.url),'utf8'));
const assetId='11'.repeat(32),rwt='22'.repeat(32),foreign='33'.repeat(32);
const lockTree='0008cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const paymentTree='0008cd02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const feeTree='1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a701730073011001020402d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304';
const address=tree=>wasm.Address.recreate_from_ergo_tree(wasm.ErgoTree.from_base16_bytes(tree)).to_base58(wasm.NetworkPrefix.Testnet);
const order=[...['aa','bb'].map(extra=>({address:address(paymentTree),assets:{nativeToken:1000000n,tokens:[{id:rwt,value:10n}]},extra})),
  {address:address(paymentTree),assets:{nativeToken:10000000n,tokens:[{id:assetId,value:80n}]}},
  {address:address(paymentTree),assets:{nativeToken:1000000n,tokens:[{id:assetId,value:20n}]},extra:''}];
function candidate({tree,value,tokens=[],registers=[]}){
  const builder=new wasm.ErgoBoxCandidateBuilder(wasm.BoxValue.from_i64(wasm.I64.from_str(String(value))),wasm.Contract.new(wasm.ErgoTree.from_base16_bytes(tree)),100);
  for(const [id,amount] of tokens)builder.add_token(wasm.TokenId.from_str(id),wasm.TokenAmount.from_i64(wasm.I64.from_str(String(amount))));
  for(const [id,bytes] of registers)builder.set_register_value(id,wasm.Constant.from_byte_array(Buffer.from(bytes,'hex')));
  return builder.build();
}
function make(edit=()=>{}){
  const rows=[...order.map(p=>({tree:paymentTree,value:p.assets.nativeToken,tokens:p.assets.tokens.map(t=>[t.id,t.value]),registers:p.extra===undefined?[]:[[4,p.extra]]})),
    {tree:lockTree,value:2000000n,tokens:[[assetId,200n]]},{tree:lockTree,value:3000000n},{tree:feeTree,value:1100000n}];
  edit(rows);
  const outputs=wasm.ErgoBoxCandidates.empty();for(const row of rows)outputs.add(candidate(row));
  const original=wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(fixture.txBytes,'hex')).unsigned_tx();
  const unsigned=new wasm.UnsignedTransaction(original.inputs(),original.data_inputs(),outputs);
  const input=wasm.ErgoBox.from_box_candidate(candidate({tree:lockTree,value:19100000n,tokens:[[assetId,300n],[rwt,20n]]}),wasm.TxId.from_str('44'.repeat(32)),0);
  return {unsigned,inputs:[input],order,lockTree,feeTree,assetId};
}
test('native unsigned transaction permits exact payment, two changes and one fee',()=>assert.equal(verifyCreditOutputs(make()),true));
const negatives=[
  ['second miner output',r=>r.push({tree:feeTree,value:1100000n}),/complete output count/],
  ['assets on miner output',r=>r.at(-1).tokens=[[assetId,1n]],/miner assets/],
  ['Asset destruction',r=>r[4].tokens[0][1]--,/conservation/],
  ['unknown change token',r=>r[4].tokens=[[foreign,200n]],/change assets/],
  ['change register',r=>r[4].registers=[[4,'01']],/change registers/],
  ['fee register',r=>r.at(-1).registers=[[4,'01']],/miner registers/],
  ['excess miner ERG',r=>r.at(-1).value++,/miner amount/],
  ['ERG deficit',r=>r[5].value--,/conservation/],
  ['edited recipient tokens',r=>r[2].tokens[0][1]++,/payment tokens/],
  ['edited payment register',r=>r[0].registers[0][1]='cc',/payment registers/],
];
for(const [name,edit,reason] of negatives)test('native unsigned rejects '+name,()=>assert.throws(()=>verifyCreditOutputs(make(edit)),reason));
