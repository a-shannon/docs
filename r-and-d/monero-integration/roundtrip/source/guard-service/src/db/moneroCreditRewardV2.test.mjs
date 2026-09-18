import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, ECDH, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {MoneroCreditAssignment as Ledger, canonicalAssignment, committeeConfigDigest} from './moneroCreditAssignment.mjs';

const h=n=>n.toString(16).padStart(2,'0').repeat(32);
const hash=value=>createHash('sha256').update(value).digest('hex');
const keys=[1,2,3,4].map(n=>{const key=ECDH('secp256k1');key.setPrivateKey(Buffer.from(n.toString(16).padStart(64,'0'),'hex'));return key.getPublicKey('hex','compressed');});
const config={custodyDomain:'reward-v2-test',guardKey:keys[0],committeeKeys:keys,quorum:3,maxFaults:1,
  activationId:'reward-activation-1',policyEpoch:'1',policyDigest:h(10),backingPolicy:'single-deposit-v2'};
const original=(obligationId='deposit')=>({binding:{obligationId,creditTransactionDigest:h(11),sourceIntentDigest:h(12),
  triggerBoxId:h(13),policyDigest:config.policyDigest,committeeDigest:committeeConfigDigest(config)},
  outputs:[{sourceNetwork:'mainnet',publicKey:h(14)}],backing:{version:2,genesis:h(1),committeeDigest:h(2),vaultSpend:h(3),
    vaultAddress:'configured-vault',intentHash:h(12),txId:h(4),blockHash:h(5),blockHeight:4097,outputIndex:1,globalIndex:5000,
    outputKey:h(14),keyImage:h(6),amountAtomic:'1000',destinationNetwork:'ergo-testnet',destinationAsset:h(7),
    recipient:'configured-recipient',creditedAtomic:'880'}});
const settlement=()=>Object.fromEntries(['reservationId','reservationHash','requestDigest','selectionDigest','bindingDigest','expectationDigest']
  .map((key,index)=>[key,h(20+index)]));
const reward=(request=original(),tuple=settlement())=>({binding:{creditTransactionDigest:h(30)},domain:'rosen-monero-reward-assignment-v1',
  creditAssignmentDigest:hash(canonicalAssignment(request)),settlement:structuredClone(tuple),paymentTxId:h(31),paymentByteDigest:h(32),
  rewardTransactionId:h(33),rewardPolicyDigest:h(34)});
function fixture(t){
  const file=join(tmpdir(),'monero-credit-reward-v2-'+randomUUID()+'.sqlite'),handles=[];
  t.after(()=>{for(const handle of handles)handle.close();for(const suffix of ['','-wal','-shm'])if(existsSync(file+suffix))unlinkSync(file+suffix);});
  return {file,create:()=>{const value=Ledger.create(file,config);handles.push(value);return value;},
    open:()=>{const value=Ledger.open(file,config);handles.push(value);return value;},
    read:()=>{const value=Ledger.openReadOnly(file,config);handles.push(value);return value;}};
}
function assigned(t){const f=fixture(t),request=original(),tuple=settlement(),ledger=f.create();ledger.assign(request);ledger.reserveSettlement(request,tuple);return {f,ledger,request,tuple,assignment:reward(request,tuple)};}

test('one canonical reward assignment is durable across exact retry and rejects conflict',t=>{
  const f=assigned(t),before=f.ledger.checkpoint();
  assert.deepEqual(f.ledger.observeReward(f.request,f.tuple),{status:'unassigned'});
  assert.deepEqual(f.ledger.reserveReward(f.request,f.tuple,f.assignment),{status:'assigned'});
  const observed=f.ledger.observeReward(f.request,f.tuple);assert.deepEqual(observed,{status:'assigned',assignment:f.assignment});
  observed.assignment.paymentTxId=h(90);assert.deepEqual(f.ledger.observeReward(f.request,f.tuple),{status:'assigned',assignment:f.assignment});
  assert.deepEqual(f.ledger.reserveReward(structuredClone(f.request),structuredClone(f.tuple),structuredClone(f.assignment)),{status:'existing'});
  assert.deepEqual(f.ledger.assertReward(f.request,f.tuple,f.assignment),{status:'assigned',assignment:f.assignment});
  const retained=f.ledger.checkpoint();
  for(const field of ['binding.creditTransactionDigest','paymentTxId','paymentByteDigest','rewardTransactionId','rewardPolicyDigest']){
    const changed=structuredClone(f.assignment);
    if(field.startsWith('binding.'))changed.binding.creditTransactionDigest=h(91);else changed[field]=h(91);
    assert.throws(()=>f.ledger.reserveReward(f.request,f.tuple,changed),/reward:conflict/,field);
    assert.throws(()=>f.ledger.assertReward(f.request,f.tuple,changed),/reward:conflict/,field);
    assert.deepEqual(f.ledger.checkpoint(),retained,field);
  }
  assert.equal(f.ledger.checkpoint().rewards,1);assert.equal(f.ledger.checkpoint().revision,before.revision+1);
});

test('reward custody requires the exact assigned claim and retained settlement',t=>{
  const f=fixture(t),ledger=f.create(),request=original(),tuple=settlement(),assignment=reward(request,tuple),empty=ledger.checkpoint();
  assert.throws(()=>ledger.observeReward(request,tuple),/assignment:missing/);assert.deepEqual(ledger.checkpoint(),empty);
  ledger.assign(request);assert.throws(()=>ledger.observeReward(request,tuple),/settlement:missing/);
  ledger.reserveSettlement(request,tuple);assert.throws(()=>ledger.assertReward(request,tuple,assignment),/reward:missing/);
  const changedTuple={...tuple,reservationId:h(90)};
  assert.throws(()=>ledger.observeReward(request,changedTuple),/settlement:conflict/);
  const changedRequest=structuredClone(request);changedRequest.binding.creditTransactionDigest=h(91);
  assert.throws(()=>ledger.reserveReward(changedRequest,tuple,{...assignment,creditAssignmentDigest:hash(canonicalAssignment(changedRequest))}),/assignment:conflict/);
});

test('reward schema is closed and binds the original claim and exact settlement',t=>{
  const f=assigned(t),before=f.ledger.checkpoint(),reject=value=>{assert.throws(()=>f.ledger.reserveReward(f.request,f.tuple,value));assert.deepEqual(f.ledger.checkpoint(),before);};
  for(const key of Object.keys(f.assignment)){const value=structuredClone(f.assignment);delete value[key];reject(value);}
  reject({...f.assignment,extra:true});reject({...f.assignment,domain:'other'});reject({...f.assignment,creditAssignmentDigest:h(90)});
  reject({...f.assignment,settlement:{...f.tuple,reservationHash:h(90)}});reject({...f.assignment,binding:{creditTransactionDigest:'AB'.repeat(32)}});
});

test('invalidation preserves observation but blocks reserve and assertion authority',t=>{
  const f=assigned(t);f.ledger.reserveReward(f.request,f.tuple,f.assignment);f.ledger.invalidate(f.request.binding.obligationId,'source-reorganized');
  assert.deepEqual(f.ledger.observeReward(f.request,f.tuple),{status:'assigned',assignment:f.assignment});
  assert.throws(()=>f.ledger.reserveReward(f.request,f.tuple,f.assignment),/assignment:invalidated/);
  assert.throws(()=>f.ledger.assertReward(f.request,f.tuple,f.assignment),/assignment:invalidated/);
});

test('reward observation and assertion are read-only across restart',t=>{
  const f=assigned(t);f.ledger.reserveReward(f.request,f.tuple,f.assignment);const checkpoint=f.ledger.checkpoint();f.ledger.close();
  const reader=f.f.read();assert.deepEqual(reader.observeReward(f.request,f.tuple),{status:'assigned',assignment:f.assignment});
  assert.deepEqual(reader.assertReward(f.request,f.tuple,f.assignment),{status:'assigned',assignment:f.assignment});
  assert.throws(()=>reader.reserveReward(f.request,f.tuple,f.assignment),/custody:read-only/);assert.deepEqual(reader.checkpoint(),checkpoint);
  reader.close();const reopened=f.f.open();assert.deepEqual(reopened.assertReward(f.request,f.tuple,f.assignment),{status:'assigned',assignment:f.assignment});
  assert.deepEqual(reopened.checkpoint(),checkpoint);
});

test('reward reservation is atomic when its settlement marker cannot be written',t=>{
  const f=assigned(t),db=new DatabaseSync(f.f.file);db.exec("CREATE TRIGGER fail_reward_marker BEFORE UPDATE OF rewardDigest ON settlements BEGIN SELECT RAISE(ABORT,'reward-marker-fault'); END");
  const before=f.ledger.checkpoint();assert.throws(()=>f.ledger.reserveReward(f.request,f.tuple,f.assignment),/reward-marker-fault/);
  assert.deepEqual(f.ledger.checkpoint(),before);assert.deepEqual(f.ledger.observeReward(f.request,f.tuple),{status:'unassigned'});
  db.exec('DROP TRIGGER fail_reward_marker');db.close();assert.deepEqual(f.ledger.reserveReward(f.request,f.tuple,f.assignment),{status:'assigned'});
});

test('deleting the reward row cannot make an assigned settlement reusable',t=>{
  const f=assigned(t);f.ledger.reserveReward(f.request,f.tuple,f.assignment);const db=new DatabaseSync(f.f.file);db.exec('DELETE FROM rewards');db.close();
  assert.throws(()=>f.ledger.observeReward(f.request,f.tuple),/custody:reward-integrity/);
  assert.throws(()=>f.ledger.checkpoint(),/custody:reward-integrity/);f.ledger.close();
  assert.throws(()=>f.f.open(),/custody:reward-integrity/);
});

test('schema version two is rejected without implicit migration',t=>{
  const f=fixture(t),ledger=f.create();ledger.close();const db=new DatabaseSync(f.file);db.exec('UPDATE metadata SET version=2');db.close();
  assert.throws(()=>f.open(),/custody:version-unsupported/);
});
