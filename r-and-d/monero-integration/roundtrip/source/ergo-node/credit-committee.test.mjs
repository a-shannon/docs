import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createECDH} from 'node:crypto';
import * as wasm from 'ergo-lib-wasm-nodejs';
import {createCreditCommittee} from './credit-committee.mjs';
import {MoneroCreditAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';

// Public low-scalar fixture identities; these are never deployment credentials.
const guardSecrets=[1,2,3,4].map(n=>n.toString(16).padStart(64,'0'));
const guardPublicKeys=guardSecrets.map(s=>{const e=createECDH('secp256k1');e.setPrivateKey(Buffer.from(s,'hex'));return e.getPublicKey('hex','compressed');});
const defaults={deployment:{threshold:3,guardPublicKeys,guardSecrets},policyDigest:'12'.repeat(32),activationId:'fixed-1',custodyDomain:'public-fixture',getStateContext:()=>{throw Error('unused-context')},verifyForGuard:()=>{throw Error('source-refused')}};
const fixture=JSON.parse(readFileSync(new URL('../guard-service/src/deposit/fixtures/credit-signing.json',import.meta.url),'utf8'));
const inputs=()=>[wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(fixture.txBytes,'hex')),3,fixture.inputBoxes.map(b=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(b,'hex'))),fixture.dataInputs.map(b=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(b,'hex')))];
function setup(t){const directory=mkdtempSync(join(tmpdir(),'committee-test-')),committees=[];
  t.after(async()=>{for(const c of committees)await c.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,create:async(extra={})=>{const c=await createCreditCommittee({...defaults,directory,...extra});committees.push(c);return c;}};}
test('four installed guarded participants pin custody and reopen unchanged',async t=>{
  const f=setup(t),a=await f.create();const before=a.checkpoints();assert.equal(a.configurations().length,4);
  assert.equal(new Set(a.configurations().map(c=>c.guardKey)).size,4);assert.equal(a.counts.completedGuards,0);
  await a.close();const b=await f.create();assert.deepEqual(b.checkpoints(),before);
  await assert.rejects(f.create({activationId:'different'}),/bootstrap-drift/);
});
test('existing missing guard state cannot silently initialize',async t=>{
  const f=setup(t),a=await f.create();await a.close();
  renameSync(join(f.directory,'guard-2.sqlite'),join(f.directory,'guard-2.retained'));
  await assert.rejects(f.create(),/missing-ledger/);
});
test('source refusal prevents actual native commitments, retains failed retry',async t=>{
  const f=setup(t),c=await f.create(),args=inputs();const first=c.sign(...args),retry=c.sign(...args);
  assert.equal(retry,first);await assert.rejects(first,/source-refused/);assert.equal(c.sign(...args),first);
  assert.deepEqual(c.counts.guardCommitments,[0,0,0,0]);assert.deepEqual(c.counts.guardPartialSigns,[0,0,0,0]);
  assert.equal(c.counts.messagesSubmitted,0);assert(c.checkpoints().every(p=>p.outputs===0));
});
test('committee recovery checks every exact guard claim without creating or reauthorizing',async t=>{
  const f=setup(t),c=await f.create();
  const request={binding:{obligationId:'confirmed-credit',creditTransactionDigest:'bb'.repeat(32),sourceIntentDigest:'cc'.repeat(32),triggerBoxId:'dd'.repeat(32),policyDigest:defaults.policyDigest,committeeDigest:c.committeeDigest},outputs:[{sourceNetwork:'mainnet',publicKey:'ee'.repeat(32)}]};
  const empty=c.checkpoints();assert.throws(()=>c.assertAssigned(request),/assignment:missing/);assert.deepEqual(c.checkpoints(),empty);
  const configs=c.configurations();for(let i=0;i<4;i++){const l=MoneroCreditAssignment.open(join(f.directory,`guard-${i}.sqlite`),configs[i]);l.assign(request);l.close();}
  const before=c.checkpoints();assert(c.assertAssigned(request).every(r=>r.status==='assigned'));assert.deepEqual(c.checkpoints(),before);
  const edited=structuredClone(request);edited.binding.triggerBoxId='fe'.repeat(32);assert.throws(()=>c.assertAssigned(edited),/assignment:conflict/);assert.deepEqual(c.checkpoints(),before);
  const last=MoneroCreditAssignment.open(join(f.directory,'guard-3.sqlite'),configs[3]);last.invalidate('confirmed-credit','source-invalidated');last.close();
  const terminal=c.checkpoints();assert.throws(()=>c.assertAssigned(request),/assignment:invalidated/);
  assert.deepEqual(c.observeAssignment(request).map(r=>r.status),['assigned','assigned','assigned','invalidated']);
  assert.deepEqual(c.checkpoints(),terminal);assert.equal(c.counts.messagesSubmitted,0);assert.deepEqual(c.counts.guardPartialSigns,[0,0,0,0]);
});
