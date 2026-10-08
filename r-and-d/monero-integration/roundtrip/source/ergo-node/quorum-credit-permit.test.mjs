import assert from 'node:assert/strict';
import test from 'node:test';
import {createQuorumCreditPermit} from './quorum-credit-permit.mjs';

const h=n=>n.toString(16).padStart(2,'0').repeat(32);
const request=()=>({binding:{creditTransactionDigest:h(1)},outputs:[{publicKey:h(2)}]});
const snapshot=()=>({digest:h(1),txId:h(3)});
const selected=[0,1,2];

test('three signers require an exact four-claim read and one local authorization',async()=>{
  const permit=createQuorumCreditPermit();let reads=0;
  assert.throws(()=>permit.consume(snapshot(),selected),/quorum credit authorization missing/);
  await assert.rejects(permit.authorize(request(),snapshot(),selected,async()=>{reads++;throw Error('fourth claim missing');}),/fourth claim missing/);
  assert.equal(reads,1);assert.throws(()=>permit.consume(snapshot(),selected),/quorum credit authorization missing/);
  await permit.authorize(request(),snapshot(),selected,async seen=>{reads++;assert.deepEqual(seen,request());});
  assert.throws(()=>permit.consume({...snapshot(),txId:h(4)},selected),/quorum credit authorization mismatch/);
  assert.throws(()=>permit.consume(snapshot(),[0,1,3]),/quorum credit authorization mismatch/);
  permit.preserveOnlyForKill(3);permit.consume(snapshot(),selected);
  assert.throws(()=>permit.consume(snapshot(),selected),/quorum credit authorization missing/);
  assert.equal(reads,2);
});

test('authorization binds request digest and cannot survive a conflicting operation',async()=>{
  const permit=createQuorumCreditPermit();
  await assert.rejects(permit.authorize({...request(),binding:{creditTransactionDigest:h(4)}},snapshot(),selected,async()=>{}),/quorum credit digest/);
  await assert.rejects(permit.authorize(request(),snapshot(),[0,0,1],async()=>{}),/quorum credit indices/);
  await permit.authorize(request(),snapshot(),selected,async()=>{});
  permit.preserveOnlyForKill(2);
  assert.throws(()=>permit.consume(snapshot(),selected),/quorum credit authorization missing/);
  await permit.authorize(request(),snapshot(),selected,async()=>{});
  permit.clear();
  assert.throws(()=>permit.consume(snapshot(),selected),/quorum credit authorization missing/);
});

test('authorization rejects a concurrent operation and a delayed response after cancellation',async()=>{
  const permit=createQuorumCreditPermit();let reply;
  const pending=permit.authorize(request(),snapshot(),selected,()=>new Promise(resolve=>{reply=resolve;}));
  assert.equal(permit.authorizing,true);
  assert.throws(()=>permit.consume(snapshot(),selected),/quorum credit authorization in progress/);
  await assert.rejects(permit.authorize(request(),snapshot(),selected,async()=>{}),/quorum credit authorization in progress/);
  permit.clear();reply();
  await assert.rejects(pending,/quorum credit authorization cancelled/);
  assert.equal(permit.authorizing,false);
  assert.throws(()=>permit.consume(snapshot(),selected),/quorum credit authorization missing/);
});
