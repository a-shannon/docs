import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFreshDepositAdmission} from './freshDepositAdmission.mjs';
import {encodeDepositMemo,encodeDepositEnvelope} from './depositDelivery.mjs';
import {encodeIntent,intentHash} from '../packages/monero-deposit/lib/intentCodec.ts';
import {NATIVE_SOURCE_PIN} from '../packages/monero-deposit/lib/evidence.ts';

// Source-boundary tests only. The caller must establish an exact assigned ledger
// claim; doubles do not establish native proof, daemon consensus or custody.
const h=n=>n.toString(16).padStart(64,'0');
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'monero-retained-backing-'));
  const configuration={genesis:h(1),committeeDigest:h(2),vaultSpend:h(3),vaultAddress:'4'.repeat(95),vaultEpoch:'1',
    destinationAsset:h(4),bridgeFee:'100',networkFee:'20',minConfirmations:10,maxObservationAge:100};
  const candidate={txId:h(5),sourceBlockId:h(6),sourceHeight:4097,transactionHex:'aabb',scope:''};
  const intent={version:2,domain:'rosen-monero-deposit',source_network:'mainnet',vault_epoch:'1',vault_address:configuration.vaultAddress,
    destination_network:'ergo-testnet',destination_asset:h(4),bridge_fee:'100',network_fee:'20',txid:h(5),to_address:'test-recipient',
    amount:'10000',expiry_height:4198n,outputs:[{output_index:1n,output_public_key:h(7),amount:'10000'}]};
  const memo={genesis:h(1),vaultSpend:h(3),sourceNetwork:'mainnet',destinationNetwork:'ergo-testnet',vaultEpoch:'1',
    destinationAsset:h(4),amount:'10000',bridgeFee:'100',networkFee:'20',expiryHeight:'4198',recipient:'test-recipient'};
  const output={version:1,committeeDigest:h(2),sourceBinding:h(8),genesis:h(1),vaultAddress:configuration.vaultAddress,txId:h(5),
    blockHash:h(6),blockHeight:4097,outputIndex:1,globalIndex:8888,outputKey:h(7),commitment:h(9),amountAtomic:'10000',keyImage:h(10),
    depositData:[encodeDepositMemo(memo).toString('hex')]};
  const packet={blockHex:'bb',blockHash:h(6),height:4097,miner:{txId:h(11),transactionHex:'aa',outputIndices:[8886]},
    transactions:[{txId:h(5),transactionHex:'aabb',outputIndices:[8887,8888]}]};
  const state={tip:4106,spent:0,sourceHash:h(6),tipHash:h(12),proofGood:true,proofReceived:'10000',proofCalls:0,nativeCalls:0,
    outputPatch:{},nativePatch:{},proofPatch:{},beforeProof:()=>{},recipientCalls:0,imageReads:[]};
  const network={getBlockPacket:async()=>structuredClone(packet),getCurrentHeight:async()=>state.tip,
    getBlockAtHeight:async height=>({height,hash:height===4097?state.sourceHash:state.tipHash}),
    getOutput:async index=>({index,key:h(7),mask:h(9),txId:h(5),height:4097,unlocked:true,...state.outputPatch}),
    getKeyImageStatus:async image=>{state.imageReads.push(image);return state.spent;}};
  const observer={async observe(received,certificate,txId,index,signal){state.nativeCalls++;signal.throwIfAborted();
    assert.deepEqual(received,packet);assert.equal(certificate,'test-certificate\n');assert.equal(txId,h(5));assert.equal(index,1);
    return {...output,...state.nativePatch};}};
  const options={network,observer,configuration,deliveryDirectory:dir,certificateDirectory:dir,
    async verifyProof(request){state.proofCalls++;await state.beforeProof();return {...request,sourcePin:NATIVE_SOURCE_PIN,
      good:state.proofGood,received:state.proofReceived,...state.proofPatch};},
    async validateRecipient(value){state.recipientCalls++;assert.equal(value,'test-recipient');}};
  const adapter=createFreshDepositAdmission(options);candidate.scope=adapter.scope;
  const proofFile=join(dir,h(5)+'.proof');
  const deliver=()=>writeFileSync(proofFile,encodeDepositEnvelope({intentBytes:encodeIntent(intent),proof:'OutProofV2'+'1'.repeat(132)}));
  deliver();writeFileSync(join(dir,h(5)+'.1.certificate'),'test-certificate\n');
  const backing={version:2,genesis:h(1),committeeDigest:h(2),vaultSpend:h(3),vaultAddress:configuration.vaultAddress,
    intentHash:intentHash(encodeIntent(intent)),txId:h(5),blockHash:h(6),blockHeight:4097,outputIndex:1,globalIndex:8888,
    outputKey:h(7),keyImage:h(10),amountAtomic:'10000',destinationNetwork:'ergo-testnet',destinationAsset:h(4),
    recipient:'test-recipient',creditedAtomic:'9880'};
  const read=()=>adapter.readRetainedBacking(candidate,backing,new AbortController().signal);
  return {adapter,candidate,backing,state,intent,memo,output,packet,options,deliver,read};
}

test('expired new admission remains refused while retained backing is reconstructed without an admission verdict',async()=>{
  const f=fixture();f.state.tip=4300;
  assert.deepEqual(await f.adapter.inspect(f.candidate,new AbortController().signal),{status:'expired'});
  assert.equal(f.state.proofCalls,0);
  const result=await f.read();assert.deepEqual(result,{backing:f.backing});
  assert(Object.isFrozen(result));assert(Object.isFrozen(result.backing));
  assert.equal(f.state.proofCalls,1);assert.equal(f.state.recipientCalls,1);assert.equal(f.state.nativeCalls,2);
  assert(f.state.imageReads.length>=2);assert(f.state.imageReads.every(image=>image===f.backing.keyImage));
});
test('retained currentness permits growth across original expiry during proof verification',async()=>{
  const f=fixture();f.state.beforeProof=()=>{f.state.tip=4300;};
  assert.deepEqual(await f.read(),{backing:f.backing});
});
test('fresh and retained entry points reconstruct the same full descriptor',async()=>{
  const f=fixture(),fresh=await f.adapter.inspect(f.candidate,new AbortController().signal);
  assert.deepEqual(fresh.backing,f.backing);assert.deepEqual((await f.read()).backing,fresh.backing);
});
for(const field of ['version','genesis','committeeDigest','vaultSpend','vaultAddress','intentHash','txId','blockHash',
  'blockHeight','outputIndex','globalIndex','outputKey','keyImage','amountAtomic','destinationNetwork','destinationAsset',
  'recipient','creditedAtomic'])test('retained equality binds '+field,async()=>{
  const f=fixture(),value=f.backing[field];f.backing[field]=typeof value==='number'?value+1:value.length===64?h(90):value+'x';
  await assert.rejects(f.read(),/Retained backing descriptor/);
});
for(const [name,mutate,reason] of [
  ['extra descriptor field',f=>f.backing.extra=true,/Retained backing descriptor/],
  ['missing descriptor field',f=>delete f.backing.keyImage,/Retained backing descriptor/],
  ['too few confirmations',f=>f.state.tip=4105,/Admission confirmations/],
  ['spent on chain',f=>f.state.spent=1,/Admission spent output/],
  ['spent in pool',f=>f.state.spent=2,/Admission spent output/],
  ['unavailable image status',f=>f.state.spent=undefined,/Admission spent output/],
  ['spent during proof',f=>f.state.beforeProof=()=>{f.state.spent=1;},/Admission spent output/],
  ['invalid proof',f=>f.state.proofGood=false,/Retained backing proof/],
  ['inflated proof amount',f=>f.state.proofReceived='20000',/Retained backing proof/],
  ['proof source pin',f=>f.state.proofPatch={sourcePin:h(80)},/Assertion/],
  ['proof message substitution',f=>f.state.proofPatch={messageHex:'ab'},/Assertion/],
  ['native genesis',f=>f.state.nativePatch={genesis:h(80)},/Admission native/],
  ['native committee',f=>f.state.nativePatch={committeeDigest:h(80)},/Admission native/],
  ['native output amount',f=>f.state.nativePatch={amountAtomic:'10001'},/Assertion/],
  ['native key image',f=>f.state.nativePatch={keyImage:h(80)},/Retained backing descriptor/],
  ['different output occurrence',f=>f.state.outputPatch={txId:h(80)},/Admission output consensus/],
  ['different global index',f=>f.state.outputPatch={index:8887},/Admission output consensus/],
  ['different output commitment',f=>f.state.outputPatch={mask:h(80)},/Admission output consensus/],
  ['locked output',f=>f.state.outputPatch={unlocked:false},/Admission output consensus/],
  ['replaced source anchor',f=>f.state.sourceHash=h(80),/Admission source rollback/],
  ['replaced source anchor during proof',f=>f.state.beforeProof=()=>{f.state.sourceHash=h(80);},/Admission source rollback/],
  ['replaced snapshot during proof',f=>f.state.beforeProof=()=>{f.state.tipHash=h(80);},/Admission snapshot rollback/],
  ['chain regression during proof',f=>f.state.beforeProof=()=>{f.state.tip--;},/Admission chain regression/],
  ['changed delivery destination',f=>{f.intent.to_address='different';f.deliver();},/Memo intent to_address/],
])test('retained source refuses '+name,async()=>{const f=fixture();mutate(f);await assert.rejects(f.read(),reason);});
for(const [name,value,memoField] of [
  ['source_network','testnet','sourceNetwork'],['vault_epoch','2','vaultEpoch'],
  ['destination_asset',h(90),'destinationAsset'],['bridge_fee','101','bridgeFee'],['network_fee','21','networkFee'],
])test('retained source enforces configured '+name+' despite coordinated intent and memo changes',async()=>{
  const f=fixture();f.intent[name]=value;f.memo[memoField]=value;
  f.output.depositData=[encodeDepositMemo(f.memo).toString('hex')];f.deliver();
  f.backing.intentHash=intentHash(encodeIntent(f.intent));
  await assert.rejects(f.read(),/Retained backing configuration/);
});
test('retained destination is independently parsed even with matching memo, proof and expected descriptor',async()=>{
  const f=fixture();f.intent.to_address='different';f.memo.recipient='different';
  f.output.depositData=[encodeDepositMemo(f.memo).toString('hex')];f.deliver();
  f.backing.intentHash=intentHash(encodeIntent(f.intent));f.backing.recipient='different';
  await assert.rejects(f.read(),/Assertion/);assert.equal(f.state.recipientCalls,1);
});
test('retained read snapshots the expected descriptor before asynchronous evidence reads',async()=>{
  const f=fixture(),expected=structuredClone(f.backing);f.state.beforeProof=()=>{f.backing.recipient='changed';};
  assert.deepEqual(await f.read(),{backing:expected});
});
test('retained source aborts without interpreting unavailable evidence as current',async()=>{
  const f=fixture(),abort=new AbortController();abort.abort();
  await assert.rejects(f.adapter.readRetainedBacking(f.candidate,f.backing,abort.signal),/abort/i);
  assert.equal(f.state.nativeCalls,0);
});
