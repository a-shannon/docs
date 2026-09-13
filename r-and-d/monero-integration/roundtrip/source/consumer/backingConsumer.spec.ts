import {test} from 'vitest';
import assert from 'node:assert/strict';
import {createHash,createECDH} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {config} from '../tools/config.mjs';
import {DataSource} from '@rosen-bridge/extended-typeorm';
import {Migration1789499200000} from '../guard-service/src/db/migrations/moneroWithdrawal/sqlite/1789499200000-migration';
import {Migration1789499300000} from '../guard-service/src/db/migrations/moneroWithdrawal/sqlite/1789499300000-migration';
import {WithdrawalJournal,type WithdrawalJournalAnchor} from './withdrawalJournal';
import {recoverDistributedWithdrawal} from './distributedIssuer';
import {createCreditCommittee} from '../ergo-node/credit-committee.mjs';
import {MoneroCreditAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {issueBackingClaim,captureBackingClaim,reserveBackingSettlement} from './backingClaim.mjs';

const h=(n:number)=>n.toString(16).padStart(2,'0').repeat(32);
// Durable-state fixtures issue no live backing, signing, or network authority.
async function fixture(t:any,selectionBytes='journal-only-selection'){
  const directory=mkdtempSync(join(config.runtimeDirectory,'backing-consumer-')),database=join(directory,'reservation.sqlite');
  const db=new DataSource({type:'sqlite',database,synchronize:false,logging:false,migrations:[Migration1789499200000,Migration1789499300000]});
  await db.initialize();await db.runMigrations();
  const receipt={status:'unapproved-native-intent' as const,signing:'prohibited' as const,eventId:h(3),instructionDigest:h(4),requestDigest:h(1),network:'testnet',address:'fixture-recipient',amount:'17',maxMinerFeeAtomic:'9',necessaryFeeAtomic:'5',inputCount:2};
  const reservation={sourceNetwork:'testnet',network:'testnet',vaultSpend:h(5),vaultView:h(6),reservationId:h(2),reservationHash:h(7),requestJson:JSON.stringify({requestDigest:h(1)}),selectionBytes,eventId:h(3),state:'completed' as const,owner:h(8),generation:'1',leaseUntil:'1000000',receipt,receiptHash:createHash('sha256').update(JSON.stringify(receipt)).digest('hex')};
  await db.query('INSERT INTO monero_withdrawal_identity VALUES(1,?,?,?,?,?)',[reservation.sourceNetwork,reservation.network,reservation.vaultSpend,reservation.vaultView,'1000']);
  await db.query('INSERT INTO monero_withdrawal_reservation VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[reservation.reservationId,reservation.reservationHash,reservation.requestJson,reservation.selectionBytes,reservation.eventId,reservation.sourceNetwork,reservation.network,reservation.vaultSpend,reservation.vaultView,reservation.state,reservation.owner,reservation.generation,reservation.leaseUntil,JSON.stringify(receipt),reservation.receiptHash]);
  const anchor:WithdrawalJournalAnchor={reservation,requestDigest:h(1),nativeDirectory:directory,descriptorDigest:h(10),bindingDigest:h(11),expectationDigest:h(12),hostGeneration:'1',reservationGeneration:'1'};
  const journal=await WithdrawalJournal.open(database);
  t.onTestFinished(async()=>{await journal.close();await db.destroy();});
  return {database,journal,anchor};
}

const backing={version:1,genesis:h(41),vaultSpend:h(5),vaultAddress:'fixture-standard-vault',intentHash:h(42),txid:h(43),outputIndex:'1',globalIndex:'23',publicKey:h(44),keyImage:h(45),amountAtomic:'500000240',destinationNetwork:'ergo-testnet',destinationAsset:h(46),recipient:'fixture-recipient',creditedAtomic:'500000120'};
function selection(txid=backing.txid){
  const input=(tx:string,index:string,global:string,key:string,amount:string)=>[tx,index,global,key,amount,h(50),'16','0',[global,...Array(15).fill('1')].join(','),...Array(16).fill(`${key}:${h(50)}`)];
  return ['WMNS2','testnet',h(5),h(6),'2',...input(h(47),'0','1',h(48),'1000000000000'),...input(txid,backing.outputIndex,backing.globalIndex,backing.publicKey,backing.amountAtomic),'1','1',''].join('\n');
}
async function retainedClaim(t:any,directory:string){
  const guardSecrets=[1,2,3,4].map(n=>n.toString(16).padStart(64,'0'));
  const guardPublicKeys=guardSecrets.map(secret=>{const key=createECDH('secp256k1');key.setPrivateKey(Buffer.from(secret,'hex'));return key.getPublicKey('hex','compressed');});
  const committee=await createCreditCommittee({directory:join(directory,'committee'),deployment:{threshold:3,guardPublicKeys,guardSecrets},policyDigest:h(51),activationId:'consumer-fixture',custodyDomain:'consumer-test',backingPolicy:'single-deposit-v1',getStateContext:()=>{throw Error('unused');},verifyForGuard:()=>{throw Error('unused');}});
  t.onTestFinished(()=>committee.close());
  const request={binding:{obligationId:'consumer-deposit',creditTransactionDigest:h(52),sourceIntentDigest:backing.intentHash,triggerBoxId:h(53),policyDigest:h(51),committeeDigest:committee.committeeDigest},outputs:[{sourceNetwork:'mainnet',publicKey:backing.publicKey}],backing};
  for(let i=0;i<4;i++){const ledger=MoneroCreditAssignment.open(join(directory,'committee',`guard-${i}.sqlite`),committee.configurations()[i]);try{ledger.assign(request);}finally{ledger.close();}}
  return {committee,request,claim:issueBackingClaim(committee,request)};
}

test('backing digest is an exact optional journal field, retained across reopen',async t=>{
  const f=await fixture(t),backed={...f.anchor,backingDigest:h(20)};
  for(const value of [undefined,null,'',h(171).toUpperCase(),'00'])assert.throws(()=>f.journal.prepare({...f.anchor,backingDigest:value} as any));
  assert.throws(()=>f.journal.prepare({...backed,backingClaim:{}} as any),/anchor-schema/);
  await f.journal.prepare(backed);await f.journal.markSigning(f.anchor.reservation.reservationId);await f.journal.close();
  const reopened=await WithdrawalJournal.open(f.database);
  try{assert.deepEqual((await reopened.read(f.anchor.reservation.reservationId)).anchor,backed);}
  finally{await reopened.close();}
});

test('backed recovery rejects a missing capability before touching the native executable',async t=>{
  const f=await fixture(t);await f.journal.prepare({...f.anchor,backingDigest:h(20)});await f.journal.markSigning(f.anchor.reservation.reservationId);
  await assert.rejects(recoverDistributedWithdrawal(f.database,f.anchor.reservation.reservationId,'must-not-open-native',h(30)),/recovery-backing-required/);
  assert.equal((await f.journal.read(f.anchor.reservation.reservationId)).state,'signing');
});

test('legacy recovery rejects an extra backing capability before native recovery',async t=>{
  const f=await fixture(t);await f.journal.prepare(f.anchor);await f.journal.markSigning(f.anchor.reservation.reservationId);
  await assert.rejects(recoverDistributedWithdrawal(f.database,f.anchor.reservation.reservationId,'must-not-open-native',h(30),{}),/recovery-backing-required/);
  assert.equal((await f.journal.read(f.anchor.reservation.reservationId)).state,'signing');
});

test('JSON or caller methods cannot replace a branded recovery capability',async t=>{
  const f=await fixture(t);await f.journal.prepare({...f.anchor,backingDigest:h(20)});await f.journal.markSigning(f.anchor.reservation.reservationId);
  for(const claim of [{},{digest:h(20)},{assertAssigned:()=>true,assertSettlement:()=>true}])
    await assert.rejects(recoverDistributedWithdrawal(f.database,f.anchor.reservation.reservationId,'must-not-open-native',h(30),claim),/backing:unissued/);
  assert.equal((await f.journal.read(f.anchor.reservation.reservationId)).state,'signing');
});

test('actual retained four-guard claim cannot recover an unreserved or invalidated settlement',async t=>{
  const f=await fixture(t,selection()),held=await retainedClaim(t,f.anchor.nativeDirectory);
  const anchor={...f.anchor,backingDigest:captureBackingClaim(held.claim).digest};
  await f.journal.prepare(anchor);await f.journal.markSigning(anchor.reservation.reservationId);
  await assert.rejects(recoverDistributedWithdrawal(f.database,anchor.reservation.reservationId,'must-not-open-native',h(30),held.claim),/settlement:missing/);
  reserveBackingSettlement(held.claim,anchor);held.committee.invalidate(held.request.binding.obligationId,'source-reorganized');
  await assert.rejects(recoverDistributedWithdrawal(f.database,anchor.reservation.reservationId,'must-not-open-native',h(30),held.claim),/assignment:invalidated/);
  assert.equal((await f.journal.read(anchor.reservation.reservationId)).state,'signing');
  assert.deepEqual(held.committee.checkpoints().map((r:any)=>[r.outputs,r.nullifiers,r.settlements]),[[1,1,1],[1,1,1],[1,1,1],[1,1,1]]);
});

test('recovery decodes the stored occurrence and rejects a different transaction before native recovery',async t=>{
  const f=await fixture(t,selection(h(54))),held=await retainedClaim(t,f.anchor.nativeDirectory);
  const anchor={...f.anchor,backingDigest:captureBackingClaim(held.claim).digest};
  reserveBackingSettlement(held.claim,anchor);await f.journal.prepare(anchor);await f.journal.markSigning(anchor.reservation.reservationId);
  await assert.rejects(recoverDistributedWithdrawal(f.database,anchor.reservation.reservationId,'must-not-open-native',h(30),held.claim),/selection-txid/);
  assert.equal((await f.journal.read(anchor.reservation.reservationId)).state,'signing');
});
