import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createECDH} from 'node:crypto';
import {retainCreditRecord,recoverCredit} from './credit-recovery.mjs';
import {MoneroCreditAssignment,committeeConfigDigest} from '../guard-service/src/db/moneroCreditAssignment.mjs';

const keys=[1,2,3,4].map(i=>{const k=createECDH('secp256k1');k.setPrivateKey(Buffer.from(i.toString(16).padStart(64,'0'),'hex'));return k.getPublicKey('hex','compressed');});
const configs=keys.map(guardKey=>({custodyDomain:'recovery-public-fixture',guardKey,committeeKeys:keys,quorum:3,maxFaults:1,activationId:'1',policyEpoch:'1',policyDigest:'aa'.repeat(32)}));
const request={binding:{obligationId:'deposit-a',creditTransactionDigest:'bb'.repeat(32),sourceIntentDigest:'cc'.repeat(32),triggerBoxId:'dd'.repeat(32),policyDigest:configs[0].policyDigest,committeeDigest:committeeConfigDigest(configs[0])},outputs:[{sourceNetwork:'mainnet',publicKey:'ee'.repeat(32)}]};
function setup(t,{assigned=true,confirmed=false}={}){
  const directory=mkdtempSync(join(tmpdir(),'credit-recovery-')),ledgers=configs.map((c,i)=>MoneroCreditAssignment.create(join(directory,`guard-${i}.sqlite`),c));
  t.after(()=>{ledgers.forEach(l=>l.close());rmSync(directory,{recursive:true,force:true});});
  if(assigned)ledgers.forEach(l=>l.assign(request));
  const effects={fresh:0,submit:0,wait:0,validated:0};
  const snapshot={txId:'ff'.repeat(32)},transaction={id:snapshot.txId,proof:'caller-validated-fixture'},record={txId:snapshot.txId,policyDigest:configs[0].policyDigest,transaction};
  // Crypto/unsigned parity belongs to the caller; these tests isolate recovery
  // authority and ordering with real permanent custody, never generate proofs.
  const args={record,snapshot,policyDigest:configs[0].policyDigest,request,committee:{observeAssignment:r=>ledgers.map(l=>l.observeAssignment(r)),assertAssigned:r=>ledgers.map(l=>l.assertAssigned(r))},
    validateSigned(row,expected){effects.validated++;assert.equal(row.transaction.id,expected.txId);assert.equal(row.transaction.proof,'caller-validated-fixture');},
    lookupConfirmed:async()=>confirmed?transaction:undefined,verifyFresh:async()=>{effects.fresh++;},submit:async()=>{effects.submit++;},waitConfirmed:async()=>{effects.wait++;return transaction;}};
  return {directory,ledgers,effects,args,transaction,checkpoints:()=>ledgers.map(l=>l.checkpoint())};
}
function noSubmission(x,before){assert.equal(x.effects.submit,0);assert.equal(x.effects.wait,0);assert.deepEqual(x.checkpoints(),before);}
test('durable record is exclusive and reads exact bytes without replacing prior custody',t=>{
  const x=setup(t),file=join(x.directory,'candidate.json'),body=Buffer.from('{"retained":"candidate"}\n');
  retainCreditRecord(file,body);assert.deepEqual(readFileSync(file),body);assert.throws(()=>retainCreditRecord(file,'replacement'),/EEXIST/);assert.deepEqual(readFileSync(file),body);
  const original=join(x.directory,'existing.json');writeFileSync(original,'prior');assert.throws(()=>retainCreditRecord(original,'new'),/EEXIST/);assert.equal(readFileSync(original,'utf8'),'prior');
  const absent=join(x.directory,'missing','record');assert.throws(()=>retainCreditRecord(absent,body));assert.equal(existsSync(absent),false);
});
test('assigned recovery revalidates source, submits once and preserves all custody',async t=>{
  const x=setup(t),before=x.checkpoints(),result=await recoverCredit(x.args);assert.equal(result.status,'confirmed');assert.equal(x.effects.fresh,1);assert.equal(x.effects.submit,1);assert.equal(x.effects.wait,1);assert.deepEqual(x.checkpoints(),before);
});
test('confirmed exact recovery observes without fresh source, signing or submission',async t=>{
  const x=setup(t,{confirmed:true}),before=x.checkpoints();assert.equal((await recoverCredit(x.args)).status,'confirmed');assert.equal(x.effects.fresh,0);noSubmission(x,before);
});
test('wrong retained candidate and caller-rejected signed transaction have no submission effects',async t=>{
  for(const edit of [a=>a.snapshot={txId:'01'.repeat(32)},a=>a.record={...a.record,policyDigest:'01'.repeat(32)},a=>a.record={...a.record,transaction:{...a.record.transaction,proof:'wrong'}}]){
    const x=setup(t),before=x.checkpoints();edit(x.args);await assert.rejects(recoverCredit(x.args));assert.equal(x.effects.fresh,0);noSubmission(x,before);
  }
});
test('a missing or conflicting permanent guard claim cannot authorize recovery',async t=>{
  const missing=setup(t,{assigned:false}),before=missing.checkpoints();await assert.rejects(recoverCredit(missing.args),/assignment:missing/);noSubmission(missing,before);
  const conflict=setup(t,{assigned:false}),edited=structuredClone(request);edited.binding.sourceIntentDigest='01'.repeat(32);conflict.ledgers.forEach(l=>l.assign(edited));const assigned=conflict.checkpoints();await assert.rejects(recoverCredit(conflict.args),/assignment:conflict/);noSubmission(conflict,assigned);
});
test('known invalidation before recovery blocks unconfirmed submission and retains output liability',async t=>{
  const x=setup(t);x.ledgers[2].invalidate(request.binding.obligationId,'controlled-source-reorg');const before=x.checkpoints();await assert.rejects(recoverCredit(x.args),/assignment:invalidated/);noSubmission(x,before);assert(before.every(p=>p.outputs===1));
});
test('invalidation during fresh await is rechecked immediately before submission',async t=>{
  const x=setup(t);x.args.verifyFresh=async()=>{x.effects.fresh++;await Promise.resolve();x.ledgers[1].invalidate(request.binding.obligationId,'controlled-await-invalidation');};
  await assert.rejects(recoverCredit(x.args),/assignment:invalidated/);assert.equal(x.effects.submit,0);assert.equal(x.effects.wait,0);assert(x.checkpoints().every(p=>p.outputs===1));
});
test('confirmed invalidated recovery is quarantined without submitting or changing liability',async t=>{
  const x=setup(t,{confirmed:true});x.ledgers[3].invalidate(request.binding.obligationId,'controlled-post-credit-reorg');const before=x.checkpoints();assert.equal((await recoverCredit(x.args)).status,'quarantined');assert.equal(x.effects.fresh,0);noSubmission(x,before);
});
test('fresh source refusal stops before submission without mutating assignments',async t=>{
  const x=setup(t),before=x.checkpoints();x.args.verifyFresh=async()=>{throw Error('controlled-source-refused');};await assert.rejects(recoverCredit(x.args),/controlled-source-refused/);noSubmission(x,before);
});
test('confirmed lookup observes invalidation that occurs during its await',async t=>{
  const x=setup(t,{confirmed:true});
  x.args.lookupConfirmed=async()=>{await Promise.resolve();x.ledgers[0].invalidate(request.binding.obligationId,'controlled-confirmation-lookup-reorg');return x.transaction;};
  assert.equal((await recoverCredit(x.args)).status,'quarantined');assert.equal(x.effects.submit,0);assert.equal(x.effects.wait,0);assert(x.checkpoints().every(p=>p.outputs===1));
});
test('post-submission confirmation observes invalidation during confirmation wait',async t=>{
  const x=setup(t);
  x.args.waitConfirmed=async()=>{x.effects.wait++;await Promise.resolve();x.ledgers[0].invalidate(request.binding.obligationId,'controlled-confirmation-wait-reorg');return x.transaction;};
  assert.equal((await recoverCredit(x.args)).status,'quarantined');assert.equal(x.effects.submit,1);assert.equal(x.effects.wait,1);assert(x.checkpoints().every(p=>p.outputs===1));
});
