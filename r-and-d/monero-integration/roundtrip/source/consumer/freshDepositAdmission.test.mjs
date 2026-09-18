import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFreshDepositAdmission} from './freshDepositAdmission.mjs';
import {encodeDepositMemo,encodeDepositEnvelope} from './depositDelivery.mjs';
import {encodeIntent} from '../packages/monero-deposit/lib/intentCodec.ts';
import {NATIVE_SOURCE_PIN} from '../packages/monero-deposit/lib/evidence.ts';

// Deterministic boundary tests; mocked ports do not establish native proof,
// daemon consensus, destination validity, or backing-ledger qualification.
const h=n=>n.toString(16).padStart(64,'0');
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'monero-fresh-admission-'));
  const configuration={genesis:h(1),committeeDigest:h(2),vaultSpend:h(3),vaultAddress:'4'.repeat(95),vaultEpoch:'1',
    destinationAsset:h(4),bridgeFee:'100',networkFee:'20',minConfirmations:10,maxObservationAge:100};
  const candidate={id:1,txId:h(5),sourceBlockId:h(6),sourceHeight:4097,transactionHex:'aabb',scope:''};
  const intent={version:2,domain:'rosen-monero-deposit',source_network:'mainnet',vault_epoch:'1',vault_address:configuration.vaultAddress,
    destination_network:'ergo-testnet',destination_asset:h(4),bridge_fee:'100',network_fee:'20',txid:h(5),to_address:'test-recipient',
    amount:'10000',expiry_height:4198n,outputs:[{output_index:1n,output_public_key:h(7),amount:'10000'}]};
  const memo=encodeDepositMemo({genesis:h(1),vaultSpend:h(3),sourceNetwork:'mainnet',destinationNetwork:'ergo-testnet',vaultEpoch:'1',
    destinationAsset:h(4),amount:'10000',bridgeFee:'100',networkFee:'20',expiryHeight:'4198',recipient:'test-recipient'}).toString('hex');
  const output={version:1,committeeDigest:h(2),sourceBinding:h(8),genesis:h(1),vaultAddress:configuration.vaultAddress,txId:h(5),
    blockHash:h(6),blockHeight:4097,outputIndex:1,globalIndex:8888,outputKey:h(7),commitment:h(9),amountAtomic:'10000',keyImage:h(10),depositData:[memo]};
  const packet={blockHex:'bb',blockHash:h(6),height:4097,miner:{txId:h(11),transactionHex:'aa',outputIndices:[8886]},
    transactions:[{txId:h(5),transactionHex:'aabb',outputIndices:[8887,8888]}]};
  const state={tip:4106,spent:0,unlocked:true,sourceHash:h(6),tipHash:h(12),proofGood:true,proofCalls:0,nativeCalls:0,
    outputPatch:{},nativePatch:{},beforeProof:()=>{}};
  const network={
    getBlockPacket:async()=>structuredClone(packet),getCurrentHeight:async()=>state.tip,
    getBlockAtHeight:async height=>({height,hash:height===4097?state.sourceHash:state.tipHash}),
    getOutput:async index=>({index,key:h(7),mask:h(9),txId:h(5),height:4097,unlocked:state.unlocked,...state.outputPatch}),
    getKeyImageStatus:async()=>state.spent,
  };
  const observer={async observe(received,certificate,txId,index,signal){state.nativeCalls++;signal.throwIfAborted();assert.deepEqual(received,packet);
    assert.equal(certificate,'test-certificate\n');assert.equal(txId,h(5));assert.equal(index,1);return {...output,...state.nativePatch};}};
  const options={network,observer,configuration,deliveryDirectory:dir,certificateDirectory:dir,
    async verifyProof(request){state.proofCalls++;await state.beforeProof();return {...request,sourcePin:NATIVE_SOURCE_PIN,good:state.proofGood,received:'10000'};},
    async validateRecipient(recipient){assert.equal(recipient,'test-recipient');}};
  const adapter=createFreshDepositAdmission(options);candidate.scope=adapter.scope;
  const proofFile=join(dir,h(5)+'.proof');
  const valid=encodeDepositEnvelope({intentBytes:encodeIntent(intent),proof:'OutProofV2'+'1'.repeat(132)});
  writeFileSync(proofFile,valid);writeFileSync(join(dir,h(5)+'.1.certificate'),'test-certificate\n');
  const inspect=()=>adapter.inspect(candidate,new AbortController().signal);
  const verify=()=>adapter.verify(candidate,new AbortController().signal);
  return {adapter,candidate,state,output,packet,options,configuration,proofFile,valid,intent,inspect,verify};
}

test('accepts the complete joined input at ten confirmations and preserves output identity',async()=>{
  const f=fixture(),result=await f.inspect();assert.equal(result.status,'accepted');
  assert.equal(result.backing.outputIndex,1);assert.equal(result.backing.globalIndex,8888);assert.equal(result.backing.creditedAtomic,'9880');
  assert.match(result.observation.fromAddress,/^rosen-monero-output:v2:[0-9a-f]{64}$/);
  assert.equal(result.observation.sourceBlockId,h(6));assert.equal(f.state.proofCalls,1);assert.equal(f.state.nativeCalls,1);
});
test('late delivery and ordinary growth rebuild authority while keeping the event descriptor stable',async()=>{
  const f=fixture();writeFileSync(f.proofFile,'malformed');assert.deepEqual(await f.verify(),{status:'pending'});
  writeFileSync(f.proofFile,f.valid);const first=await f.inspect();f.state.tip+=3;const second=await f.inspect();
  assert.equal(first.observation.fromAddress,second.observation.fromAddress);assert.notEqual(first.decision.checkedAtHeight,second.decision.checkedAtHeight);
  assert.equal(f.state.nativeCalls,2);assert.equal(f.state.proofCalls,2);
});
test('ordinary chain growth while proof verification runs remains admissible',async()=>{
  const f=fixture();f.state.beforeProof=()=>{f.state.tip++;};assert.equal((await f.inspect()).status,'accepted');
});
test('a later valid proof is not poisoned by the first invalid proof',async()=>{
  const f=fixture();f.state.proofGood=false;assert.deepEqual(await f.verify(),{status:'pending'});
  f.state.proofGood=true;assert.equal((await f.verify()).status,'accepted');assert.equal(f.state.proofCalls,2);
});
for(const [name,mutate] of [
  ['captured bytes',f=>f.candidate.transactionHex='cc'],
  ['scope',f=>f.candidate.scope=h(88)],
  ['confirmations',f=>f.state.tip=4105],
  ['native genesis',f=>f.state.nativePatch={genesis:h(88)}],
  ['native committee',f=>f.state.nativePatch={committeeDigest:h(88)}],
  ['native amount',f=>f.state.nativePatch={amountAtomic:'10001'}],
  ['native selected key',f=>f.state.nativePatch={outputKey:h(88)}],
  ['daemon key',f=>f.state.outputPatch={key:h(88)}],
  ['daemon commitment',f=>f.state.outputPatch={mask:h(88)}],
  ['daemon transaction',f=>f.state.outputPatch={txId:h(88)}],
  ['daemon height',f=>f.state.outputPatch={height:4098}],
  ['daemon global index',f=>f.state.outputPatch={index:8887}],
  ['daemon unlock',f=>f.state.unlocked=false],
  ['spent on chain',f=>f.state.spent=1],
  ['spent in pool',f=>f.state.spent=2],
  ['source rollback during proof',f=>f.state.beforeProof=()=>{f.state.sourceHash=h(88);}],
  ['snapshot rollback during proof',f=>f.state.beforeProof=()=>{f.state.tipHash=h(88);}],
  ['spent during proof',f=>f.state.beforeProof=()=>{f.state.spent=1;}],
  ['expiry during proof',f=>f.state.beforeProof=()=>{f.state.tip=4198;}],
])test('refuses '+name+' as retryable evidence',async()=>{const f=fixture();mutate(f);assert.deepEqual(await f.verify(),{status:'pending'});});
test('canonical source expiry is retained and does not invoke proof verification',async()=>{
  const f=fixture();f.state.tip=4198;assert.deepEqual(await f.verify(),{status:'expired'});assert.equal(f.state.proofCalls,0);
});
test('delivery destination mutation is refused before native proof checking',async()=>{
  const f=fixture();writeFileSync(f.proofFile,encodeDepositEnvelope({intentBytes:encodeIntent({...f.intent,to_address:'different'}),proof:'OutProofV2'+'1'.repeat(132)}));
  assert.deepEqual(await f.verify(),{status:'pending'});assert.equal(f.state.proofCalls,0);
});
test('abort and changed configuration cannot mint an observation',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  assert.deepEqual(await f.adapter.verify(f.candidate,controller.signal),{status:'pending'});assert.equal(f.state.nativeCalls,0);
  f.configuration.vaultSpend=h(88);assert.equal((await f.inspect()).status,'accepted');
});
