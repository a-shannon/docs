import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {createReturnAuthorityVerifier} from './return-authority.mjs';
const {blake2b}=createRequire(import.meta.url)('blakejs');
const digest=value=>Buffer.from(blake2b(value,undefined,32)).toString('hex');
const id=n=>String(n).repeat(64),u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(n));return b;};
function setup(){
  const observation={sourceTxId:id(1),fromChain:'ergo',toChain:'monero',fromAddress:'recipient',toAddress:'monero-recipient',amount:'500000120',bridgeFee:'100',networkFee:'20',sourceChainTokenId:id(2),targetChainTokenId:'XMR',sourceBlockId:id(3),height:20,requestId:digest(Buffer.from(id(1)))};
  const wids=[id(4),id(5)],widHash=digest(Buffer.concat(wids.map(w=>Buffer.from(w,'hex'))));
  const commitments=wids.map((WID,i)=>{const c=digest(Buffer.concat([Buffer.from(observation.sourceTxId),Buffer.from('ergo'),Buffer.from('monero'),Buffer.from('recipient'),Buffer.from('monero-recipient'),u64(observation.amount),u64(100),u64(20),Buffer.from(id(2)),Buffer.from('XMR'),Buffer.from(id(3)),u64(20),Buffer.from(WID,'hex')]));return {WID,boxId:'commitment-'+i,commitment:c,rwtCount:'10',requestId:observation.requestId};});
  const commitmentTransactions=commitments.map((c,i)=>({id:'create-'+i,numConfirmations:1,blockId:id(6),inclusionHeight:21,inputs:[],outputs:[{boxId:c.boxId,transactionId:'create-'+i,ergoTree:'commitment-tree',assets:[{tokenId:'rwt',amount:10}],registers:{4:c.WID,5:c.requestId,6:c.commitment}}]}));
  const trigger={boxId:'trigger',transactionId:'reveal',ergoTree:'trigger-tree',assets:[{tokenId:'rwt',amount:20}],registers:{4:widHash}};
  const transaction={id:'reveal',numConfirmations:1,blockId:id(7),inclusionHeight:22,inputs:commitments.map(c=>({boxId:c.boxId})),outputs:[trigger]};
  const receipt={observation,watcherObservations:[structuredClone(observation),structuredClone(observation)],commitments,commitmentTransactions,trigger,transaction};
  const primary=new Map([...commitmentTransactions,transaction].map(t=>[t.id,structuredClone(t)]));
  const event={...observation,sourceChainHeight:observation.height,eventId:observation.requestId,WIDsCount:2,WIDsHash:widHash,txId:'reveal',identifier:'trigger'};
  // Trusted test transport and representation ports; production uses native WASM.
  const wasm={Transaction:{from_json:text=>({sigma_serialize_bytes:()=>{const raw=JSON.parse(text);delete raw.blockId;delete raw.inclusionHeight;delete raw.numConfirmations;return Buffer.from(JSON.stringify(raw));}})},ErgoBox:{from_json:text=>{const raw=JSON.parse(text);return {sigma_serialize_bytes:()=>Buffer.from(JSON.stringify(raw)),register_value:n=>({to_byte_array:()=>Buffer.from(raw.registers[n],'hex')})};}}};
  let reads=0,changeSource=false,missingUTXO=false,reorgTrigger=false,triggerReads=0;const extractor={extractBoxData:()=>structuredClone(event)};
  const verify=createReturnAuthorityVerifier({wasm,extractor,blake2b,rpc:async route=>{if(route.startsWith('/utxo')){if(missingUTXO)throw Error('404');return structuredClone(primary.get('reveal').outputs[0]);}const tx=primary.get(route.split('/').at(-1));if(!tx)throw Error('404');const found=structuredClone(tx);if(tx.id==='reveal' && ++triggerReads>1 && reorgTrigger)found.blockId=id(8);return found;},observeRedemption:async()=>{reads++;return changeSource&&reads>1?{...observation,amount:'500000121'}:structuredClone(observation);}});
  const input={returnReceipt:receipt,redemption:{},deployment:{tokens:{Asset:id(2),RWT:'rwt'},contracts:{EventTrigger:{tree:'trigger-tree'},Commitment:{tree:'commitment-tree'}},watchers:wids.map(WID=>({WID}))},terms:{}};
  return {input,verify,primary,event,setMissing:()=>missingUTXO=true,setSourceChange:()=>changeSource=true,setTriggerReorg:()=>reorgTrigger=true};
}
test('fresh primary trigger and both consumed commitments bind complete return source',async()=>{const f=setup(),result=await f.verify(f.input);assert.equal(result.event.height,22);assert.equal(result.event.sourceChainHeight,20);assert.equal(result.wids.length,2);});
test('forged, absent or spent primary trigger never reaches approval',async()=>{
  for(const mutate of [f=>f.input.returnReceipt.transaction.outputs[0].assets[0].amount=21,f=>f.primary.delete('reveal'),f=>f.setMissing(),f=>f.input.returnReceipt.commitments.pop(),f=>f.primary.get('reveal').inputs.pop()]){const f=setup();mutate(f);await assert.rejects(f.verify(f.input));}
});
test('every source event field and source-height/event-identity mapping is checked',async()=>{
  for(const field of ['sourceTxId','fromChain','toChain','fromAddress','toAddress','amount','bridgeFee','networkFee','sourceChainTokenId','targetChainTokenId','sourceBlockId','sourceChainHeight','eventId','txId','identifier','WIDsHash','WIDsCount']){const f=setup();f.event[field]='edited';await assert.rejects(f.verify(f.input));}
});
test('closing source observation detects an admission-time source change',async()=>{const f=setup();f.setSourceChange();await assert.rejects(f.verify(f.input),/source changed/);});
test('closing primary trigger block pin detects reorg despite identical transaction bytes',async()=>{const f=setup();f.setTriggerReorg();await assert.rejects(f.verify(f.input));});
