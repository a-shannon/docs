import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createECDH} from 'node:crypto';
import * as wasm from 'ergo-lib-wasm-nodejs';
import {MoneroCreditAssignment,committeeConfigDigest} from '../db/moneroCreditAssignment.mjs';
import {createMoneroCreditSigner,snapshotCreditSigning} from './moneroCreditSigner.mjs';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/credit-signing.json',import.meta.url),'utf8'));
const keys=[1,2,3,4].map(n=>{const key=createECDH('secp256k1');key.setPrivateKey(Buffer.from(n.toString(16).padStart(64,'0'),'hex'));return key.getPublicKey('hex','compressed');});
const cfg={custodyDomain:'fresh-contribution-test',guardKey:keys[0],committeeKeys:keys,quorum:3,maxFaults:1,
  activationId:'1',policyEpoch:'1',policyDigest:'12'.repeat(32)};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function inputs(){return [wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(fixture.txBytes,'hex')),3,
  fixture.inputBoxes.map(h=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(h,'hex'))),fixture.dataInputs.map(h=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(h,'hex')))];}
function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'monero-fresh-sign-')),ledger=MoneroCreditAssignment.create(join(dir,'guard.sqlite'),cfg);
  const args=inputs(),snapshot=snapshotCreditSigning(...args);
  const request={binding:{obligationId:'deposit',creditTransactionDigest:snapshot.digest,sourceIntentDigest:'13'.repeat(32),triggerBoxId:'14'.repeat(32),
    policyDigest:cfg.policyDigest,committeeDigest:committeeConfigDigest(cfg)},outputs:[{sourceNetwork:'mainnet',publicKey:'15'.repeat(32)}]};
  const state={commits:0,shares:0,refreshes:0,valid:true,changeAssignment:false,beforeReturn:()=>{}};
  const prover={generate_commitments_for_reduced_transaction:()=>state.commits++,sign_reduced_transaction_multi:()=>state.shares++};
  let finish;
  const participant={contributionValidationVersion:1,getProver:()=>prover,
    sign:()=>new Promise(resolve=>{finish=resolve;}),isInSign:()=>true,handleMessage(){},handleMyTurn(){},cleanup(){}};
  const assertCurrent=()=>{};
  const gate=createMoneroCreditSigner({participant,assignment:ledger,requireFreshContribution:true,verify:async()=>({assignment:request,assertCurrent,
    async revalidate(){state.refreshes++;assert(state.valid,'fresh source refused');await tick();state.beforeReturn();
      const assignment=structuredClone(request);if(state.changeAssignment)assignment.binding.triggerBoxId='ff'.repeat(32);
      return {assignment,assertCurrent};}})});
  t.after(()=>{gate.close();ledger.close();});
  const hook=kind=>({txId:snapshot.txId,reducedHex:snapshot.reducedHex,kind});
  const native=kind=>participant.getProver()[kind==='commitment'?'generate_commitments_for_reduced_transaction':'sign_reduced_transaction_multi'](args[0]);
  const start=async()=>{const job=gate.sign(...args);job.catch(()=>{});await tick();return {job};};
  return {gate,ledger,args,snapshot,request,state,hook,native,start,finish:()=>finish('signed')};
}

test('fresh mode refuses an unhooked implementation before queueing',()=>{
  assert.throws(()=>createMoneroCreditSigner({participant:{getProver(){},sign(){}},assignment:{},verify:async()=>{},requireFreshContribution:true}),/contribution/);
});
test('each native contribution requires its own successful refresh permit',async t=>{
  const f=setup(t),{job}=await f.start();
  assert.throws(()=>f.native('commitment'),/fresh/);assert.equal(f.state.commits,0);
  await f.gate.refreshContribution(f.hook('commitment'));f.native('commitment');
  assert.throws(()=>f.native('commitment'),/fresh/);assert.equal(f.state.commits,1);
  await f.gate.refreshContribution(f.hook('peer-sign'));f.native('peer-sign');
  assert.throws(()=>f.native('peer-sign'),/fresh/);assert.equal(f.state.shares,1);assert.equal(f.state.refreshes,2);
  f.finish();assert.equal(await job,'signed');
});
test('proof removed after queueing refuses all new native contributions and retains assignment',async t=>{
  const f=setup(t);await f.start();f.state.valid=false;
  await assert.rejects(f.gate.refreshContribution(f.hook('commitment')));
  assert.throws(()=>f.native('commitment'));assert.equal(f.state.commits,0);assert.equal(f.state.shares,0);
  assert.equal(f.ledger.checkpoint().outputs,1);
});
test('proof removed after commitment refuses the later partial without erasing prior work',async t=>{
  const f=setup(t);await f.start();await f.gate.refreshContribution(f.hook('commitment'));f.native('commitment');
  f.state.valid=false;await assert.rejects(f.gate.refreshContribution(f.hook('coordinator-sign')));
  assert.throws(()=>f.native('coordinator-sign'));assert.equal(f.state.commits,1);assert.equal(f.state.shares,0);
});
test('changed assignment cannot replace a retained signing obligation',async t=>{
  const f=setup(t);await f.start();f.state.changeAssignment=true;
  await assert.rejects(f.gate.refreshContribution(f.hook('commitment')));assert.equal(f.state.commits,0);
  assert.equal(f.ledger.assertAssigned(f.request).status,'assigned');
});
test('local invalidation after async refresh still blocks the adjacent native call',async t=>{
  const f=setup(t);await f.start();await f.gate.refreshContribution(f.hook('commitment'));
  f.gate.invalidate('deposit','changed-source');assert.throws(()=>f.native('commitment'),/invalidated/);assert.equal(f.state.commits,0);
});
test('closed capability and wrong transaction or native-operation kind never contribute',async t=>{
  const f=setup(t);await f.start();
  await assert.rejects(f.gate.refreshContribution({...f.hook('commitment'),txId:'ff'.repeat(32)}));
  assert.equal(f.state.commits,0);
  const g=setup(t);await g.start();await g.gate.refreshContribution(g.hook('peer-sign'));
  assert.throws(()=>g.native('commitment'),/fresh/);assert.equal(g.state.commits,0);
  const h=setup(t);await h.start();h.state.beforeReturn=()=>h.gate.close();
  await assert.rejects(h.gate.refreshContribution(h.hook('commitment')));assert.equal(h.state.commits,0);
});
