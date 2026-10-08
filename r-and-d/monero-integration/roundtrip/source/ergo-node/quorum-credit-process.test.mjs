import assert from 'node:assert/strict';
import test,{mock} from 'node:test';
import path from 'node:path';
import {createECDH} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {MoneroCreditAssignment,committeeConfigDigest} from '../guard-service/src/db/moneroCreditAssignment.mjs';

const h=n=>n.toString(16).padStart(2,'0').repeat(32);
const keys=[1,2,3,4].map(n=>{const ecdh=createECDH('secp256k1');ecdh.setPrivateKey(Buffer.alloc(32,n));return ecdh.getPublicKey('hex','compressed');});
const configs=keys.map(guardKey=>({custodyDomain:'synthetic',guardKey,committeeKeys:keys,quorum:3,maxFaults:1,
  activationId:'synthetic',policyEpoch:'test',policyDigest:h(8),backingPolicy:'single-deposit-v2'}));
let ledgers=[];const calls={assert:[0,0,0,0],sign:[0,0,0,0],audit:[0,0,0,0]};
let failSign=false,failStats=false,assertDelay;
const request={binding:{obligationId:'monero:deposit:mainnet:'+h(10),creditTransactionDigest:h(1),
  sourceIntentDigest:h(11),triggerBoxId:h(12),policyDigest:configs[0].policyDigest,
  committeeDigest:committeeConfigDigest(configs[0])},outputs:[{sourceNetwork:'mainnet',publicKey:h(13)}],
  backing:{version:2,genesis:h(14),committeeDigest:h(15),vaultSpend:h(16),vaultAddress:'synthetic-vault',
    intentHash:h(11),txId:h(17),blockHash:h(18),blockHeight:4097,outputIndex:0,globalIndex:500,
    outputKey:h(13),keyImage:h(19),amountAtomic:'1000',destinationNetwork:'ergo-testnet',
    destinationAsset:h(20),recipient:'synthetic-recipient',creditedAtomic:'880'}};
const snapshot={digest:h(1),txId:h(3)};
function createClaims(t){
  const directory=mkdtempSync(path.join(tmpdir(),'monero-quorum-claims-'));
  const opened=configs.map((config,index)=>MoneroCreditAssignment.create(path.join(directory,`guard-${index}.sqlite`),config));
  ledgers=opened;t.after(()=>opened.forEach(ledger=>ledger.close()));
}

if(!process.execArgv.includes('--experimental-test-module-mocks')){
  test('process committee quorum orchestration requires module mock support',
    {skip:'run with --experimental-test-module-mocks'},()=>{});
}else{
mock.module(new URL('../tools/participant-config.mjs',import.meta.url),{namedExports:{
  pinParticipantConfig:file=>({file,sha256:h(9),verify(){}})
}});
mock.module(new URL('../tools/process-rpc.mjs',import.meta.url),{namedExports:{
  async launchProcessRpc({env}){
    const index=Number(path.basename(env.PARTICIPANT_CONFIG)),configuration=configs[index];let closed=false;
    return {pid:1000+index,ready:{index,pid:1000+index,guardKey:keys[index],configuration,configSha256:h(9),coordinatorIndex:0},
      get closed(){return closed;},async close(){closed=true;},async kill(){closed=true;},
      async request(method,value){
        if(closed)throw Error('actor closed');
        if(method==='assertAssigned'){
          calls.assert[index]++;if(index===3&&assertDelay)await assertDelay;
          return ledgers[index].assertAssigned(value);
        }
        if(method==='sign'){
          calls.sign[index]++;if(failSign)throw Error('synthetic source failure');
          return {signedHex:'aa',txId:value.snapshot.txId,stats:{counts:{commitments:1,partialSigns:1}}};
        }
        if(method==='audit'){calls.audit[index]++;return {status:'held'};}
        if(method==='stats'){if(failStats)throw Error('synthetic transport failure');return {status:'ready'};}
        throw Error('unexpected synthetic RPC '+method);
      }};
  }
}});
const {createGuardProcessCommittee}=await import('./guard-process-committee.mjs');

test('process committee refuses three signatures until all four exact claims exist',async t=>{
  createClaims(t);
  const guards=await createGuardProcessCommittee({configFiles:[0,1,2,3].map(String).map(i=>path.resolve('synthetic',i)),guardKeys:keys});
  t.after(()=>guards.close());for(let i=0;i<3;i++)assert.equal(ledgers[i].assign(request).status,'assigned');
  await assert.rejects(guards.authorizeQuorumCredit(request,snapshot,[0,1,2]),/assignment:missing/);
  await assert.rejects(guards.sign(snapshot,{indices:[0,1,2]}),/quorum credit authorization missing/);
  assert.deepEqual(calls.sign,[0,0,0,0]);
  assert.equal(ledgers[3].assign(request).status,'assigned');
  const changed=structuredClone(request);changed.binding.triggerBoxId=h(21);
  await assert.rejects(guards.authorizeQuorumCredit(changed,snapshot,[0,1,2]),/assignment:conflict/);
  await guards.authorizeQuorumCredit(request,snapshot,[0,1,2]);
  await assert.rejects(guards.sign({...snapshot,txId:h(5)},{indices:[0,1,2]}),/quorum credit authorization mismatch/);
  assert.deepEqual(calls.sign,[0,0,0,0]);
  await guards.kill(3);assert.equal((await guards.sign(snapshot,{indices:[0,1,2]})).txId,snapshot.txId);
  assert.deepEqual(calls.sign,[1,1,1,0]);
  await assert.rejects(guards.sign(snapshot,{indices:[0,1,2]}),/quorum credit authorization missing/);
});

test('audit and transport faults revoke the permit; a failed sign consumes it',async t=>{
  createClaims(t);for(const ledger of ledgers)assert.equal(ledger.assign(request).status,'assigned');
  const guards=await createGuardProcessCommittee({configFiles:[0,1,2,3].map(String).map(i=>path.resolve('synthetic',i)),guardKeys:keys});
  t.after(()=>guards.close());
  await guards.authorizeQuorumCredit(request,snapshot,[0,1,2]);await guards.auditBacking(snapshot,request);
  await assert.rejects(guards.sign(snapshot,{indices:[0,1,2]}),/quorum credit authorization missing/);
  await guards.authorizeQuorumCredit(request,snapshot,[0,1,2]);failStats=true;
  try{await assert.rejects(guards.stats(),/synthetic transport failure/);}finally{failStats=false;}
  await assert.rejects(guards.sign(snapshot,{indices:[0,1,2]}),/quorum credit authorization missing/);
  await guards.authorizeQuorumCredit(request,snapshot,[0,1,2]);failSign=true;
  try{await assert.rejects(guards.sign(snapshot,{indices:[0,1,2]}),/synthetic source failure/);}finally{failSign=false;}
  await guards.restartAll();
  await assert.rejects(guards.sign(snapshot,{indices:[0,1,2]}),/quorum credit authorization missing/);
});

test('an invalidated fourth claim cannot authorize three signers',async t=>{
  createClaims(t);for(const ledger of ledgers)assert.equal(ledger.assign(request).status,'assigned');
  assert.equal(ledgers[3].invalidate(request.binding.obligationId,'source-block-changed').status,'invalidated');
  const guards=await createGuardProcessCommittee({configFiles:[0,1,2,3].map(String).map(i=>path.resolve('synthetic',i)),guardKeys:keys});
  t.after(()=>guards.close());const before=[...calls.sign];
  await assert.rejects(guards.authorizeQuorumCredit(request,snapshot,[0,1,2]),/assignment:invalidated/);
  await assert.rejects(guards.sign(snapshot,{indices:[0,1,2]}),/quorum credit authorization missing/);
  assert.deepEqual(calls.sign,before);
});

test('a delayed fourth response cannot publish a permit after an audit begins',async t=>{
  createClaims(t);for(const ledger of ledgers)assert.equal(ledger.assign(request).status,'assigned');
  const guards=await createGuardProcessCommittee({configFiles:[0,1,2,3].map(String).map(i=>path.resolve('synthetic',i)),guardKeys:keys});
  t.after(()=>guards.close());let release;
  assertDelay=new Promise(resolve=>{release=resolve;});
  const pending=guards.authorizeQuorumCredit(request,snapshot,[0,1,2]);
  await assert.rejects(guards.auditBacking(snapshot,request),/Committee unavailable/);
  release();assertDelay=undefined;
  await assert.rejects(pending,/quorum credit authorization cancelled/);
  await assert.rejects(guards.sign(snapshot,{indices:[0,1,2]}),/quorum credit authorization missing/);
});
}
