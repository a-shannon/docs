import test from 'node:test';
import assert from 'node:assert/strict';
import * as wasm from 'ergo-lib-wasm-nodejs';
import {isUnregisteredFundingBox,unregisteredFundingBoxes} from './funding-candidates.mjs';

const asset='11'.repeat(32),tree='0008cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const value=n=>wasm.BoxValue.from_i64(wasm.I64.from_str(String(n)));
function box(index,amount,registered=false,ergValue=10000000){
  const builder=new wasm.ErgoBoxCandidateBuilder(value(ergValue),wasm.Contract.new(wasm.ErgoTree.from_base16_bytes(tree)),100);
  if(amount)builder.add_token(wasm.TokenId.from_str(asset),wasm.TokenAmount.from_i64(wasm.I64.from_str(String(amount))));
  if(registered)builder.set_register_value(4,wasm.Constant.from_byte_array(Buffer.from('fee-state')));
  return wasm.ErgoBox.from_box_candidate(builder.build(),wasm.TxId.from_str(String(index+1).padStart(2,'0').repeat(32)),index);
}
function select(boxes,amount,ergValue=1000000){
  const available=wasm.ErgoBoxes.empty();boxes.forEach(candidate=>available.add(candidate));
  const target=new wasm.Tokens();target.add(new wasm.Token(wasm.TokenId.from_str(asset),wasm.TokenAmount.from_i64(wasm.I64.from_str(String(amount)))));
  return new wasm.SimpleBoxSelector().select(available,value(ergValue),target).boxes();
}
const raw=box=>JSON.parse(box.to_json());

test('registered fee state is removed before the actual selector can spend it',()=>{
  const fee=box(0,1,true),ordinaryTokenChange=box(1,9),ordinaryErg=box(2,0,false,30000000);
  const unsafe=select([fee,ordinaryTokenChange,ordinaryErg],9,20000000);
  assert(Array.from({length:unsafe.len()},(_,i)=>unsafe.get(i).box_id().to_str()).includes(fee.box_id().to_str()),'counterexample must spend the protected fee box');
  const selected=select(unregisteredFundingBoxes([raw(fee),raw(ordinaryTokenChange),raw(ordinaryErg)]).map(value=>wasm.ErgoBox.from_json(JSON.stringify(value))),9,20000000);
  assert(Array.from({length:selected.len()},(_,i)=>selected.get(i).box_id().to_str()).every(id=>id!==fee.box_id().to_str()));
});

test('ordinary funding remains usable and registered value cannot cover a shortage',()=>{
  const fee=box(0,1,true),enough=box(1,9),short=box(2,8),ordinaryErg=box(3,0,false,30000000);
  assert.doesNotThrow(()=>select(unregisteredFundingBoxes([raw(fee),raw(enough),raw(ordinaryErg)]).map(value=>wasm.ErgoBox.from_json(JSON.stringify(value))),9,20000000));
  assert.doesNotThrow(()=>select([fee,short,ordinaryErg],9,20000000),'unfiltered selector demonstrates the unsafe fallback');
  assert.throws(()=>select(unregisteredFundingBoxes([raw(fee),raw(short),raw(ordinaryErg)]).map(value=>wasm.ErgoBox.from_json(JSON.stringify(value))),9,20000000));
});

test('each possible additional register independently protects a funding box',()=>{
  assert.equal(isUnregisteredFundingBox({additionalRegisters:{}}),true);
  for(const box of [{},{additionalRegisters:null},{additionalRegisters:[]}])assert.equal(isUnregisteredFundingBox(box),false);
  for(let register=4;register<=9;register++)assert.equal(isUnregisteredFundingBox({additionalRegisters:{['R'+register]:'encoded'}}),false,'R'+register);
});
