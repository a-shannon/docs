import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createCreditCommittee} from '../ergo-node/credit-committee.mjs';
import {MoneroCreditAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {issueBackingClaim,captureBackingClaim,assertBackingSelection,reserveBackingSettlement,assertBackingSettlement} from './backingClaim.mjs';

const h=n=>n.toString(16).padStart(2,'0').repeat(32);
const guardSecrets=[1,2,3,4].map(n=>n.toString(16).padStart(64,'0'));
const guardPublicKeys=guardSecrets.map(secret=>{const key=createECDH('secp256k1');key.setPrivateKey(Buffer.from(secret,'hex'));return key.getPublicKey('hex','compressed');});
const defaults={deployment:{threshold:3,guardPublicKeys,guardSecrets},policyDigest:h(1),activationId:'test-backing',custodyDomain:'local-test',
  backingPolicy:'single-deposit-v1',getStateContext:()=>{throw Error('unused');},verifyForGuard:()=>{throw Error('unused');}};
async function setup(t){
  const directory=mkdtempSync(join(tmpdir(),'backing-claim-test-')),handles=[];
  t.after(async()=>{for(const handle of handles)await handle.close();const absolute=resolve(directory);assert(absolute.startsWith(resolve(tmpdir())+'\\')||absolute.startsWith(resolve(tmpdir())+'/'));rmSync(absolute,{recursive:true,force:true});});
  const open=async()=>{const handle=await createCreditCommittee({...defaults,directory});handles.push(handle);return handle;};
  const committee=await open();
  const backing={version:1,genesis:h(2),vaultSpend:h(3),vaultAddress:'local-standard-vault',intentHash:h(4),txid:h(5),outputIndex:'1',globalIndex:'23',
    publicKey:h(6),keyImage:h(7),amountAtomic:'500000240',destinationNetwork:'ergo-testnet',destinationAsset:h(8),recipient:'local-recipient',creditedAtomic:'500000120'};
  const request={binding:{obligationId:'test-deposit',creditTransactionDigest:h(9),sourceIntentDigest:backing.intentHash,triggerBoxId:h(10),policyDigest:defaults.policyDigest,committeeDigest:committee.committeeDigest},
    outputs:[{sourceNetwork:'mainnet',publicKey:backing.publicKey}],backing};
  const assign=(indices=[0,1,2,3])=>{for(const i of indices){const db=MoneroCreditAssignment.open(join(directory,`guard-${i}.sqlite`),committee.configurations()[i]);db.assign(request);db.close();}};
  return {directory,committee,request,backing,open,assign};
}
function selected(backing){return {genesis:backing.genesis,vaultSpend:backing.vaultSpend,vaultAddress:backing.vaultAddress,changeIdentity:h(15),
  selection:{network:'testnet',vaultSpend:backing.vaultSpend,inputs:[{txid:h(16),outputIndex:'0',globalIndex:'1',publicKey:h(17),amount:'1000000000000'},
    {txid:backing.txid,outputIndex:backing.outputIndex,globalIndex:backing.globalIndex,publicKey:backing.publicKey,amount:backing.amountAtomic}]}};}
const anchorFor=digest=>({backingDigest:digest,reservation:{reservationId:h(20),reservationHash:h(21),selectionBytes:'exact-native-selection'},
  requestDigest:h(22),bindingDigest:h(23),expectationDigest:h(24)});

test('partial committee settlement retains earlier guards and retries only the exact anchor',async t=>{
  const {DatabaseSync}=await import('node:sqlite');
  const f=await setup(t);f.assign();let cap=issueBackingClaim(f.committee,f.request);
  const anchor=anchorFor(captureBackingClaim(cap).digest),db=new DatabaseSync(join(f.directory,'guard-2.sqlite'));
  try{
    db.exec("CREATE TRIGGER storage_fault BEFORE INSERT ON settlements BEGIN SELECT RAISE(ABORT,'test-storage-fault'); END");
    assert.throws(()=>reserveBackingSettlement(cap,anchor),/test-storage-fault/);
    assert.deepEqual(f.committee.checkpoints().map(x=>x.settlements),[1,1,0,0]);
    assert.throws(()=>assertBackingSettlement(cap,anchor),/settlement:missing/);
    db.exec('DROP TRIGGER storage_fault');
  }finally{db.close();}
  await f.committee.close();const reopened=await f.open();cap=issueBackingClaim(reopened,f.request);
  const changed=structuredClone(anchor);changed.reservation.reservationId=h(51);
  assert.throws(()=>reserveBackingSettlement(cap,changed),/settlement:conflict/);
  reserveBackingSettlement(cap,anchor);assertBackingSettlement(cap,anchor);
  assert.deepEqual(reopened.checkpoints().map(x=>x.settlements),[1,1,1,1]);
});

test('only matching retained committee claims issue a non-cloneable backing capability',async t=>{
  const f=await setup(t);assert.throws(()=>issueBackingClaim({assertAssigned:()=>[]},f.request),/committee-unissued/);
  assert.throws(()=>issueBackingClaim(f.committee,f.request),/assignment:missing/);f.assign([0,1,2]);
  assert.throws(()=>issueBackingClaim(f.committee,f.request),/assignment:missing/);f.assign([3]);
  const cap=issueBackingClaim(f.committee,f.request),captured=captureBackingClaim(cap);assert.deepEqual(captured.request,f.request);
  assert.throws(()=>captureBackingClaim({...cap}),/backing:unissued/);
  captured.request.backing.publicKey=h(50);assert.equal(captureBackingClaim(cap).request.backing.publicKey,f.backing.publicKey);
  const changed=structuredClone(f.request);changed.backing.recipient='other';assert.throws(()=>issueBackingClaim(f.committee,changed),/assignment:conflict/);
});
test('the selected native occurrence must equal the admitted backing, including amount and source context',async t=>{
  const f=await setup(t);f.assign();const cap=issueBackingClaim(f.committee,f.request),good=selected(f.backing);
  assert.equal(assertBackingSelection(cap,good),captureBackingClaim(cap).digest);
  for(const field of ['txid','outputIndex','globalIndex','amount']){
    const altered=structuredClone(good);altered.selection.inputs[1][field]=field==='txid'?h(50):'2';
    assert.throws(()=>assertBackingSelection(cap,altered),new RegExp('selection-'+field));
  }
  for(const field of ['genesis','vaultSpend','vaultAddress']){const altered=structuredClone(good);altered[field]='different';assert.throws(()=>assertBackingSelection(cap,altered),/selection-context/);}
  const network=structuredClone(good);network.selection.network='mainnet';assert.throws(()=>assertBackingSelection(cap,network),/selection-context/);
  const absent=structuredClone(good);absent.selection.inputs[1].publicKey=h(50);assert.throws(()=>assertBackingSelection(cap,absent),/selection-class/);
  const alias=structuredClone(good);alias.selection.inputs[0].publicKey=f.backing.publicKey;assert.throws(()=>assertBackingSelection(cap,alias),/selection-class/);
  const change=structuredClone(good);change.changeIdentity=f.backing.publicKey;assert.throws(()=>assertBackingSelection(cap,change),/change-alias/);
});
test('one exact settlement survives committee reopen and all independent anchor changes are refused',async t=>{
  const f=await setup(t);f.assign();let cap=issueBackingClaim(f.committee,f.request);const anchor=anchorFor(captureBackingClaim(cap).digest);
  assert.throws(()=>assertBackingSettlement(cap,anchor),/settlement:missing/);reserveBackingSettlement(cap,anchor);assertBackingSettlement(cap,anchor);
  for(const field of ['backingDigest','requestDigest','bindingDigest','expectationDigest']){const altered=structuredClone(anchor);altered[field]=h(50);assert.throws(()=>assertBackingSettlement(cap,altered),/backing:anchor|settlement:conflict/);}
  for(const field of ['reservationId','reservationHash','selectionBytes']){const altered=structuredClone(anchor);altered.reservation[field]=field==='selectionBytes'?'changed-selection':h(50);assert.throws(()=>assertBackingSettlement(cap,altered),/settlement:conflict/);}
  const other=structuredClone(anchor);other.reservation.reservationId=h(51);assert.throws(()=>reserveBackingSettlement(cap,other),/settlement:conflict/);
  await f.committee.close();assert.throws(()=>captureBackingClaim(cap),/committee-closed/);
  const reopened=await f.open();cap=issueBackingClaim(reopened,f.request);assertBackingSettlement(cap,anchor);
  assert.deepEqual(reopened.checkpoints().map(row=>row.settlements),[1,1,1,1]);
  reopened.invalidate(f.request.binding.obligationId,'source-reorganized');assert.throws(()=>assertBackingSettlement(cap,anchor),/assignment:invalidated/);
  assert.deepEqual(reopened.checkpoints().map(row=>[row.outputs,row.nullifiers,row.settlements]),[[1,1,1],[1,1,1],[1,1,1],[1,1,1]]);
});
