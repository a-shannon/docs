import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createECDH} from 'node:crypto';
import {MoneroCreditAssignment,committeeConfigDigest} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {auditCreditBacking} from './credit-backing-audit.mjs';

const h=n=>n.toString(16).padStart(64,'0');
const keys=[1,2,3,4].map(n=>{const key=createECDH('secp256k1');key.setPrivateKey(Buffer.from(h(n),'hex'));return key.getPublicKey('hex','compressed');});
function fixture(t){
  const config={custodyDomain:'audit-fixture',guardKey:keys[0],committeeKeys:keys,quorum:3,maxFaults:1,
    activationId:'fixed-committee',policyEpoch:'1',policyDigest:h(8),backingPolicy:'single-deposit-v2'};
  const assignment={binding:{obligationId:'deposit',creditTransactionDigest:h(10),sourceIntentDigest:h(11),triggerBoxId:h(12),
    policyDigest:config.policyDigest,committeeDigest:committeeConfigDigest(config)},outputs:[{sourceNetwork:'mainnet',publicKey:h(13)}],
    backing:{version:2,genesis:h(14),committeeDigest:h(15),vaultSpend:h(16),vaultAddress:'vault',intentHash:h(11),
      txId:h(17),blockHash:h(18),blockHeight:90,outputIndex:0,globalIndex:105,outputKey:h(13),keyImage:h(19),
      amountAtomic:'1000',destinationNetwork:'ergo-testnet',destinationAsset:h(20),recipient:'recipient',creditedAtomic:'880'}};
  const file=join(mkdtempSync(join(tmpdir(),'backing-audit-')),'ledger.sqlite'),ledger=MoneroCreditAssignment.create(file,config);
  t.after(()=>ledger.close());ledger.assign(assignment);
  const args={assignment,ledger,readAnchor:async height=>({height,hash:h(18)}),readBacking:async()=>({backing:structuredClone(assignment.backing)}),assertCurrent:()=>{}};
  return {args,assignment,ledger,file,config};
}
test('audit preserves claim and reports checked without providing signing authority',async t=>{
  const f=fixture(t),before=f.ledger.checkpoint(),row=await auditCreditBacking(f.args);
  assert.equal(row.status,'checked');assert.equal(row.claim.status,'assigned');assert.deepEqual(f.ledger.checkpoint(),before);
});
test('agreed replacement invalidates durably and never releases the output or image',async t=>{
  const f=fixture(t),before=f.ledger.checkpoint();f.args.readAnchor=async height=>({height,hash:h(99)});
  f.args.readBacking=async()=>{throw Error('must not read proof for replaced anchor');};
  assert.equal((await auditCreditBacking(f.args)).status,'quarantined');
  assert.throws(()=>f.ledger.assertAssigned(f.assignment),/invalidated/);
  const after=f.ledger.checkpoint();assert.equal(after.revision,before.revision+1);
  assert.equal(after.claims,1);assert.equal(after.outputs,1);assert.equal(after.nullifiers,1);assert.equal(after.settlements,0);
  f.ledger.close();const reopened=MoneroCreditAssignment.open(f.file,f.config);t.after(()=>reopened.close());
  f.args.ledger=reopened;f.args.readAnchor=async()=>{throw Error('terminal claim must remain terminal');};
  assert.equal((await auditCreditBacking(f.args)).status,'quarantined');assert.deepEqual(reopened.checkpoint(),after);
  assert.equal(reopened.assign(f.assignment).status,'invalidated');
  const duplicate=structuredClone(f.assignment);duplicate.binding.obligationId='replacement';
  assert.equal(reopened.assign(duplicate).status,'conflict');
});
for(const [name,change,reason] of [
  ['endpoint disagreement',a=>{a.readAnchor=async()=>{throw Error('Monero endpoints disagree');};},'source-unavailable'],
  ['wrong anchor height',a=>{a.readAnchor=async()=>({height:91,hash:h(99)});},'source-unavailable'],
  ['malformed anchor hash',a=>{a.readAnchor=async()=>({height:90,hash:'invalid'});},'source-unavailable'],
  ['missing proof',a=>{a.readBacking=async()=>{throw Error('ENOENT');};},'backing-unavailable'],
  ['changed image',a=>{a.readBacking=async()=>({backing:{...a.assignment.backing,keyImage:h(99)}});},'backing-unavailable'],
])test(name+' holds without releasing or invalidating claims',async t=>{
  const f=fixture(t),before=f.ledger.checkpoint();change(f.args);const row=await auditCreditBacking(f.args);
  assert.equal(row.status,'held');assert.equal(row.reason,reason);assert.equal(row.claim.status,'assigned');assert.deepEqual(f.ledger.checkpoint(),before);
});
test('missing or conflicting claim fails before source access',async t=>{
  const f=fixture(t),before=f.ledger.checkpoint();let calls=0;f.args.readAnchor=async()=>{calls++;};
  f.assignment.binding.creditTransactionDigest=h(99);await assert.rejects(()=>auditCreditBacking(f.args),/conflict/);
  f.assignment.binding.obligationId='missing';f.assignment.outputs[0].publicKey=h(98);f.assignment.backing.outputKey=h(98);f.assignment.backing.keyImage=h(97);
  await assert.rejects(()=>auditCreditBacking(f.args),/missing/);assert.equal(calls,0);assert.deepEqual(f.ledger.checkpoint(),before);
});
for(const phase of ['readAnchor','readBacking'])test('invalidation during '+phase+' cannot return checked',async t=>{
  const f=fixture(t),original=f.args[phase];f.args[phase]=async(...args)=>{f.ledger.invalidate('deposit','concurrent');return original(...args);};
  assert.equal((await auditCreditBacking(f.args)).status,'quarantined');assert.equal(f.ledger.observeAssignment(f.assignment).reason,'concurrent');
});
test('captures caller assignment and refuses closed authority after awaited read',async t=>{
  const f=fixture(t),original=f.args.readAnchor;f.args.readAnchor=async height=>{f.assignment.binding.obligationId='changed';return original(height);};
  assert.equal((await auditCreditBacking(f.args)).status,'checked');
  f.assignment.binding.obligationId='deposit';let closed=false;f.args.assertCurrent=()=>assert(!closed,'Closed authority');
  f.args.readAnchor=async height=>{closed=true;return original(height);};
  await assert.rejects(()=>auditCreditBacking(f.args),/Closed authority/);
});
test('custody failure during source failure is not downgraded to an availability hold',async t=>{
  const f=fixture(t);f.args.readBacking=async()=>{f.ledger.close();throw Error('proof missing');};
  await assert.rejects(()=>auditCreditBacking(f.args),/custody:closed/);
});
test('result status and claim come from one final ledger observation',async t=>{
  const f=fixture(t);let final=false;
  f.args.readBacking=async()=>{final=true;return {backing:structuredClone(f.assignment.backing)};};
  f.args.ledger={observeAssignment(request){const observed=f.ledger.observeAssignment(request);
    if(final)f.ledger.invalidate('deposit','another-custody-handle');return observed;}};
  const row=await auditCreditBacking(f.args);
  assert.equal(row.status==='quarantined',row.claim.status==='invalidated');
  assert.equal(f.ledger.observeAssignment(f.assignment).status,'invalidated');
});
