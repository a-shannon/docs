import test from 'node:test';import assert from 'node:assert/strict';
import {validateReturnTerms,verifyReturnShape,projectUnsignedReturn} from './authority-return.mjs';
import {readFileSync} from 'node:fs';
import * as wasm from 'ergo-lib-wasm-nodejs';
const terms={toAddress:'controlled-recipient',bridgeFee:'100',networkFee:'20',moneroTokenId:'XMR'};
const creditBox={boxId:'credit',ergoTree:'recipient-tree',value:10000000,assets:[{tokenId:'asset',amount:500000120}]};
const deployment={tokens:{Asset:'asset'},contracts:{Lock:{tree:'lock-tree'}}};
const transaction={inputs:[{boxId:'credit'}],dataInputs:[],outputs:[{ergoTree:'lock-tree',value:8900000,assets:[{tokenId:'asset',amount:500000120}],additionalRegisters:{R4:'bound-register'}},{ergoTree:'miner-tree',value:1100000,assets:[],additionalRegisters:{}}]};
const verify=tx=>verifyReturnShape({transaction:tx,creditBox,deployment,terms,recipientAddress:'recipient',recipientTree:'recipient-tree',feeTree:'miner-tree',registerR4:'bound-register'});
test('return preserves exact input/token quantity and bound recipient register',()=>assert.equal(verify(transaction),500000120n));
test('single-fault transaction mutations refuse',()=>{
  for(const mutate of [t=>t.inputs[0].boxId='other',t=>t.inputs.push({boxId:'extra'}),t=>t.dataInputs.push({boxId:'other'}),t=>t.outputs[0].assets[0].amount--,t=>t.outputs[0].value--,t=>t.outputs[0].ergoTree='other',t=>t.outputs[0].additionalRegisters.R4='other',t=>t.outputs[1].ergoTree='other',t=>t.outputs[1].assets.push({tokenId:'asset',amount:1}),t=>t.outputs.push({...t.outputs[1]})]){
    const t=structuredClone(transaction);mutate(t);assert.throws(()=>verify(t));
  }
});
test('noncanonical fees, unsupported token and unbounded terms refuse',()=>{
  for(const patch of [{bridgeFee:'01'},{networkFee:'-1'},{bridgeFee:String(1n<<64n)},{moneroTokenId:'other'},{toAddress:'contains space'},{extra:'field'}])assert.throws(()=>validateReturnTerms({...terms,...patch}));
});
test('native pre-sign policy projection consumes only its unsigned clone',()=>{
  const fixture=JSON.parse(readFileSync(new URL('../guard-service/src/deposit/fixtures/credit-signing.json',import.meta.url),'utf8'));
  const unsigned=wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(fixture.txBytes,'hex')).unsigned_tx();
  const json=unsigned.to_json(),id=unsigned.id().to_str();
  assert.equal(projectUnsignedReturn(wasm,unsigned).id,id);
  // These native accesses previously failed after the policy projection moved
  // the same Rust-owned unsigned transaction into from_unsigned_tx.
  assert.equal(unsigned.to_json(),json);assert.equal(unsigned.id().to_str(),id);
  assert.equal(unsigned.inputs().len(),JSON.parse(json).inputs.length);
  unsigned.free();
});
