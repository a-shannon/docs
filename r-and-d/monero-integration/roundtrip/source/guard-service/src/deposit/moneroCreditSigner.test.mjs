import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createECDH} from 'node:crypto';
import * as wasm from 'ergo-lib-wasm-nodejs';
import {MoneroCreditAssignment,committeeConfigDigest} from '../db/moneroCreditAssignment.mjs';
import {createMoneroCreditSigner,snapshotCreditSigning} from './moneroCreditSigner.mjs';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/credit-signing.json',import.meta.url),'utf8'));
const keys=Array.from({length:4},(_,i)=>{const k=createECDH('secp256k1');k.setPrivateKey(Buffer.from((i+1).toString(16).padStart(64,'0'),'hex'));return k.getPublicKey('hex','compressed');});
const config={custodyDomain:'credit-test',guardKey:keys[0],committeeKeys:keys,quorum:3,maxFaults:1,activationId:'1',policyEpoch:'1',policyDigest:'12'.repeat(32)};
const sourceIntentDigest='13'.repeat(32),triggerBoxId='14'.repeat(32),output={sourceNetwork:'mainnet',publicKey:'15'.repeat(32)};
function inputs(){return [wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(fixture.txBytes,'hex')),3,
  fixture.inputBoxes.map(b=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(b,'hex'))),fixture.dataInputs.map(b=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(b,'hex')))];}
function request(digest,id='deposit-a'){return {binding:{obligationId:id,creditTransactionDigest:digest,sourceIntentDigest,triggerBoxId,policyDigest:config.policyDigest,committeeDigest:committeeConfigDigest(config)},outputs:[output]};}
function setup(t,verify){
  const directory=mkdtempSync(join(tmpdir(),'credit-sign-')),ledger=MoneroCreditAssignment.create(join(directory,'guard.sqlite'),config);
  let commits=0,shares=0,signs=0,finish;
  const prover={generate_commitments_for_reduced_transaction:()=>{commits++;},sign_reduced_transaction_multi:()=>{shares++;}};
  const participant={getProver:()=>prover,sign(tx){signs++;this.getProver().generate_commitments_for_reduced_transaction(tx);return new Promise(resolve=>{finish=()=>{this.getProver().sign_reduced_transaction_multi(tx);resolve('signed');};});},
    isInSign:()=>true,handleMessage(){},handleMyTurn(){},cleanup(){}};
  const gate=createMoneroCreditSigner({participant,assignment:ledger,verify:verify??(async snapshot=>({assignment:request(snapshot.digest),assertCurrent(){}}))});
  t.after(()=>{gate.close();ledger.close();});
  return {gate,ledger,participant,counts:()=>({commits,shares,signs}),finish:()=>finish()};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('exact mediator input reaches one assignment before commitment and one retained signing attempt',async t=>{
  const x=setup(t),args=inputs(),snapshot=snapshotCreditSigning(...args);
  assert.equal(snapshot.txId,fixture.txId);
  const signed=x.gate.sign(...args),retry=x.gate.sign(...args);assert.equal(retry,signed);await tick();
  assert.deepEqual(x.counts(),{commits:1,shares:0,signs:1});assert.equal(x.ledger.checkpoint().outputs,1);
  x.finish();assert.equal(await signed,'signed');assert.equal(await x.gate.sign(...args),'signed');
  assert.deepEqual(x.counts(),{commits:1,shares:1,signs:1});
});
test('failed source verification and edited verifier transaction binding never enter participant queue',async t=>{
  for(const verify of [async()=>{throw Error('source:invalid');},async()=>({assignment:request('ff'.repeat(32)),assertCurrent(){}})]){
    const x=setup(t,verify);await assert.rejects(x.gate.sign(...inputs()));assert.deepEqual(x.counts(),{commits:0,shares:0,signs:0});assert.equal(x.ledger.checkpoint().outputs,0);
  }
});
test('synchronous verifier retry observes the already retained signing promise',async t=>{
  let calls=0,retry,x;
  x=setup(t,async snapshot=>{
    calls++;if(calls===1)retry=x.gate.sign(...inputs());
    return {assignment:request(snapshot.digest),assertCurrent(){}};
  });
  const pending=x.gate.sign(...inputs());await tick();
  assert.equal(retry,pending);assert.equal(calls,1);assert.deepEqual(x.counts(),{commits:1,shares:0,signs:1});
  x.finish();assert.equal(await pending,'signed');
});
test('competing economic assignment refuses before commitment',async t=>{
  const x=setup(t);x.ledger.assign(request('ef'.repeat(32),'other-source-tx'));
  await assert.rejects(x.gate.sign(...inputs()),/assignment-conflict/);assert.equal(x.counts().commits,0);assert.equal(x.ledger.checkpoint().claims,1);
});
test('known invalidation after commitment preserves liability and blocks partial signature',async t=>{
  const x=setup(t);const pending=x.gate.sign(...inputs());pending.catch(()=>{});await tick();
  assert.equal(x.counts().commits,1);x.gate.invalidate('deposit-a','source-reorg');
  assert.throws(()=>x.finish(),/assignment-invalidated/);assert.equal(x.counts().shares,0);
  assert.equal(x.ledger.checkpoint().outputs,1);assert.equal(x.ledger.assign(request('fe'.repeat(32),'new-credit')).status,'conflict');
});
test('authority changing during verification refuses before commitment',async t=>{
  let current=true;const x=setup(t,async snapshot=>{await tick();return {assignment:request(snapshot.digest),assertCurrent(){assert(current,'context changed');}};});
  const pending=x.gate.sign(...inputs());current=false;await assert.rejects(pending,/context changed/);assert.equal(x.counts().commits,0);
});
test('quorum downgrade, missing or reordered boxes and raw unissued crypto calls refuse',async t=>{
  const x=setup(t);const [tx,q,boxes,data]=inputs();
  for(const args of [[tx,2,boxes,data],[tx,q,boxes.slice(1),data],[tx,q,[...boxes].reverse(),data],[tx,q,boxes,[]]])await assert.rejects(x.gate.sign(...args));
  assert.throws(()=>x.participant.getProver().generate_commitments_for_reduced_transaction(tx),/unissued/);
  assert.throws(()=>x.participant.getProver().sign_reduced_transaction_multi(tx),/unissued/);assert.equal(x.counts().commits,0);
});
