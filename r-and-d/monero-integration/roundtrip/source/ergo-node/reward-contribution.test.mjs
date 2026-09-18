import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,ECDH} from 'node:crypto';
import {openRewardContribution,rewardSettlement} from './reward-contribution.mjs';
import {MoneroCreditAssignment as Ledger,committeeConfigDigest} from '../guard-service/src/db/moneroCreditAssignment.mjs';
const h=n=>n.toString(16).padStart(64,'0');
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(t,useRealLedger=false){
  const source={genesis:h(1),configuration:{vaultSpend:h(2),vaultAddress:'vault'}},deployment={tokens:{Asset:h(3)}};
  const selected={source,deployment,directory:fs.mkdtempSync(path.join(os.tmpdir(),'reward-contribution-check-'))};
  const request={requestDigest:h(7),canonicalRequest:JSON.stringify({eventId:h(16)})};
  const original={binding:{creditTransactionDigest:h(4)}},anchor={reservation:{reservationId:h(5),reservationHash:h(6),selectionBytes:'selection',requestJson:JSON.stringify(request)},requestDigest:h(7),bindingDigest:h(8),expectationDigest:h(9)};
  const input={anchor,evidence:{},paymentTxId:h(10),context:{assignment:original,deployment,returnReceipt:{eventId:h(16)},sourceContext:{genesis:h(1),vaultSpend:h(2),vaultAddress:'vault',nativeNetwork:'testnet',sourceNetwork:'testnet',maxMinerFeeAtomic:'1000000000000'}}};
  const state={assigned:true,settled:true,reads:0,withdrawalReads:0,checks:0,live:true,reward:undefined,afterPayment:()=>{}},snapshot={digest:h(11),txId:h(12)};
  let ledger={assertAssigned:r=>{assert.deepEqual(r,original);assert(state.assigned,'missing assigned backing');},assertSettlement:()=>assert(state.settled,'missing retained settlement'),
    observeReward:()=>state.reward?{status:'assigned',assignment:structuredClone(state.reward)}:{status:'unassigned'},
    reserveReward:(r,s,reward)=>{if(state.reward){assert.deepEqual(reward,state.reward,'Reward retained assignment conflict');return {status:'existing'};}state.reward=structuredClone(reward);return {status:'assigned'};},
    assertReward:(r,s,reward)=>assert.deepEqual(reward,state.reward,'Reward retained assignment conflict')};
  let restart;
  if(useRealLedger){
    const keys=[1,2,3,4].map(n=>{const key=ECDH('secp256k1');key.setPrivateKey(Buffer.from(h(n),'hex'));return key.getPublicKey('hex','compressed');});
    const cfg={custodyDomain:'reward-contribution-tests',guardKey:keys[0],committeeKeys:keys,quorum:3,maxFaults:1,
      activationId:'reward-fixture',policyEpoch:'1',policyDigest:h(30),backingPolicy:'single-deposit-v2'};
    Object.assign(original,{binding:{...original.binding,obligationId:'original-deposit',sourceIntentDigest:h(31),triggerBoxId:h(32),
      policyDigest:cfg.policyDigest,committeeDigest:committeeConfigDigest(cfg)},outputs:[{sourceNetwork:'mainnet',publicKey:h(33)}],
      backing:{version:2,genesis:h(1),committeeDigest:h(34),vaultSpend:h(2),vaultAddress:'vault',intentHash:h(31),txId:h(35),
        blockHash:h(36),blockHeight:100,outputIndex:0,globalIndex:1,outputKey:h(33),keyImage:h(37),amountAtomic:'1000',
        destinationNetwork:'ergo-testnet',destinationAsset:h(3),recipient:'recipient',creditedAtomic:'880'}});
    const file=path.join(selected.directory,'credit.sqlite'),handles=[];
    ledger=Ledger.create(file,cfg);handles.push(ledger);ledger.assign(original);ledger.reserveSettlement(original,rewardSettlement(anchor));
    restart=()=>{ledger.close();ledger=Ledger.open(file,cfg);handles.push(ledger);};
    t.after(()=>handles.forEach(handle=>handle.close()));
  }
  const ports={verifyWithdrawal:async value=>{state.reads++;state.withdrawalReads++;
      assert.deepEqual(value.request,request,'Retained withdrawal request');assert.equal(value.selection,anchor.reservation.selectionBytes,'Retained withdrawal selection');
      assert.equal(value.returnReceipt.eventId,JSON.parse(request.canonicalRequest).eventId,'Withdrawal event differs');
      return {requestDigest:request.requestDigest,selectionDigest:hash(value.selection)};},verifyPayment:async()=>{state.afterPayment();return {byteDigest:h(13)};},
    openVerifier:async()=>({policyDigest:h(14),verifyRaw:async()=>{state.checks++;}})};
  return {input,selected,state,snapshot,ports,restart,open:()=>openRewardContribution({input,selected,configuration:{nativeBinary:'fixture',nativeSha256:h(15)},ledger,current:()=>assert(state.live,'retired')},ports)};
}
test('retains one exact reward assignment and revalidates payment/order before each contribution',async()=>{
  const f=fixture(),owner=await f.open(),checked=await owner.verify(f.snapshot);assert.equal(owner.assign(checked.assignment).status,'assigned');
  assert.equal(owner.assign(checked.assignment).status,'existing');await checked.revalidate();assert.equal(f.state.checks,2);assert.equal(f.state.reads,2);
  const reopened=await f.open();assert.equal(reopened.assign((await reopened.verify(f.snapshot)).assignment).status,'existing');
});
test('refuses a different reward transaction after retained assignment',async()=>{
  const f=fixture(),owner=await f.open();owner.assign((await owner.verify(f.snapshot)).assignment);
  const reopened=await f.open();await assert.rejects(reopened.verify({...f.snapshot,digest:h(98),txId:h(99)}),/Reward retained assignment conflict/);
});
test('checks assigned backing and retained withdrawal after asynchronous payment verification',async()=>{
  const f=fixture(),owner=await f.open();f.state.afterPayment=()=>{f.state.settled=false;};await assert.rejects(owner.verify(f.snapshot),/missing retained settlement/);
});
test('synchronous contribution fence sees assignment invalidation',async()=>{
  const f=fixture(),owner=await f.open(),checked=await owner.verify(f.snapshot);owner.assign(checked.assignment);f.state.assigned=false;
  assert.throws(checked.assertCurrent,/missing assigned backing/);assert.throws(()=>owner.assign(checked.assignment),/missing assigned backing/);
});
test('caller deployment and source configuration cannot replace guard-owned policy',async()=>{
  const f=fixture();f.input.context.deployment={tokens:{Asset:h(99)}};await assert.rejects(f.open(),/Reward configured deployment/);
  const g=fixture();g.input.context.sourceContext.maxMinerFeeAtomic='1';await assert.rejects(g.open(),/Reward configured source/);
});
test('binds the complete return context to the retained native request and selection',async()=>{
  const f=fixture(),owner=await f.open();await owner.verify(f.snapshot);assert.equal(f.state.withdrawalReads,1);
});
test('rejects payment from withdrawal A combined with return event B before reward checks',async()=>{
  const f=fixture();f.input.context.returnReceipt.eventId=h(99);const owner=await f.open();
  await assert.rejects(owner.verify(f.snapshot),/Withdrawal event differs/);assert.equal(f.state.checks,0);assert.equal(f.state.reward,undefined);
});
test('rejects verified request and selection identities that differ from retained settlement',async()=>{
  for(const field of ['requestDigest','selectionDigest']){const f=fixture();f.ports.verifyWithdrawal=async()=>({requestDigest:h(7),selectionDigest:hash('selection'),[field]:h(99)});
    const owner=await f.open();await assert.rejects(owner.verify(f.snapshot),/Reward withdrawal/);assert.equal(f.state.checks,0);}
});
test('restart cannot forget the ledger assignment when the old optional reward file is absent',async()=>{
  const f=fixture(),owner=await f.open();owner.assign((await owner.verify(f.snapshot)).assignment);
  const obsolete=path.join(f.selected.directory,'reward-'+f.input.anchor.reservation.reservationId+'.json');
  if(fs.existsSync(obsolete))fs.renameSync(obsolete,obsolete+'.removed');
  const reopened=await f.open();await assert.rejects(reopened.verify({...f.snapshot,digest:h(98),txId:h(99)}),/Reward retained assignment conflict/);
  const exact=await f.open();assert.equal(exact.assign((await exact.verify(f.snapshot)).assignment).status,'existing');
});
test('actual custody ledger retains reward identity across process-owner and database reopening',async t=>{
  const f=fixture(t,true),owner=await f.open(),checked=await owner.verify(f.snapshot);
  assert.equal(owner.assign(checked.assignment).status,'assigned');
  assert.equal(fs.existsSync(path.join(f.selected.directory,'reward-'+f.input.anchor.reservation.reservationId+'.json')),false);
  f.restart();const changed=await f.open();
  await assert.rejects(changed.verify({...f.snapshot,digest:h(98),txId:h(99)}),/Reward retained assignment conflict/);
  const recovered=await f.open();assert.equal(recovered.assign((await recovered.verify(f.snapshot)).assignment).status,'existing');
});
