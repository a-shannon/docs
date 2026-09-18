import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync,renameSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createECDH,createHash} from 'node:crypto';
import {canonicalAssignment,committeeConfigDigest} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {freshCreditConfigurations,openGuardCustody} from './credit-custody.mjs';

const h=n=>n.toString(16).padStart(64,'0');
const keys=[1,2,3,4].map(n=>{const k=createECDH('secp256k1');k.setPrivateKey(Buffer.from(h(n),'hex'));return k.getPublicKey('hex','compressed');});
const deployment={guardPublicKeys:keys,guard:{boxId:h(5)},tokens:{Asset:h(6),RWT:h(7)},contracts:{Lock:{tree:'abcd'},GuardSign:{tree:'1234'}}};
const scope={network:'mainnet',vault:'fixed-vault'},genesis=h(8);
const configurations=freshCreditConfigurations({deployment,scope,genesis});
function options(){return {directory:mkdtempSync(join(tmpdir(),'credit-custody-')),index:0,configuration:structuredClone(configurations[0]),contributionPackageSha256:h(9)};}
function request(configuration){return {binding:{obligationId:'retained',creditTransactionDigest:h(10),sourceIntentDigest:h(11),triggerBoxId:h(12),
  policyDigest:configuration.policyDigest,committeeDigest:committeeConfigDigest(configuration)},outputs:[{sourceNetwork:'mainnet',publicKey:h(13)}],
  backing:{version:2,genesis,committeeDigest:h(15),vaultSpend:h(16),vaultAddress:'vault',intentHash:h(11),txId:h(17),blockHash:h(18),
    blockHeight:90,outputIndex:0,globalIndex:105,outputKey:h(13),keyImage:h(19),amountAtomic:'1000',destinationNetwork:'ergo-testnet',
    destinationAsset:h(6),recipient:'recipient',creditedAtomic:'880'}};}

test('V2 configurations preserve the pre-extraction policy and canonical configuration bytes',()=>{
  const d=deployment,policyDigest=createHash('sha256').update(canonicalAssignment({profile:'local-four-guard-backed-credit-v2',scope,genesis,
    guardBoxId:d.guard.boxId,tokens:d.tokens,contracts:Object.fromEntries(Object.entries(d.contracts).map(([name,c])=>[name,c.tree]))})).digest('hex');
  const expected=d.guardPublicKeys.map(guardKey=>({custodyDomain:'local-monero-genesis:'+genesis,guardKey,committeeKeys:d.guardPublicKeys,
    quorum:3,maxFaults:1,activationId:'ergo-guard:'+d.guard.boxId,policyEpoch:'1',policyDigest,backingPolicy:'single-deposit-v2'}));
  assert.equal(canonicalAssignment(configurations),canonicalAssignment(expected));
});

test('explicit creation and exact reopening retain an assigned output and key image',()=>{
  const args=options(),created=openGuardCustody({...args,create:true}),assignment=request(args.configuration);
  created.ledger.assign(assignment);const checkpoint=created.ledger.checkpoint();created.ledger.close();
  const reopened=openGuardCustody(args);
  try {assert.equal(reopened.bootstrap,created.bootstrap);assert.equal(readFileSync(reopened.manifest,'utf8'),created.bootstrap);
    assert.deepEqual(reopened.ledger.checkpoint(),checkpoint);assert.equal(reopened.ledger.assertAssigned(assignment).status,'assigned');
    const duplicate=structuredClone(assignment);duplicate.binding.obligationId='duplicate';assert.equal(reopened.ledger.assign(duplicate).status,'conflict');
  }finally{reopened.ledger.close();}
  assert.throws(()=>openGuardCustody({...args,create:true}),/exist/i);
});

test('default reopen never creates absent custody',()=>{
  const args=options();assert.throws(()=>openGuardCustody(args),/missing/i);assert.deepEqual(readdirSync(args.directory),[]);
});
for(const missing of ['manifest','database'])test('missing '+missing+' refuses reopen and recreation without replacing retained files',()=>{
  const args=options(),created=openGuardCustody({...args,create:true});created.ledger.close();
  renameSync(created[missing],created[missing]+'.retained');
  const before=readdirSync(created.custody).sort();
  assert.throws(()=>openGuardCustody(args),/missing/i);assert.throws(()=>openGuardCustody({...args,create:true}),/exist/i);
  assert.equal(existsSync(created[missing]),false);assert.deepEqual(readdirSync(created.custody).sort(),before);
});
for(const [name,change] of [
  ['configuration',args=>{args.configuration.policyEpoch='2';}],
  ['contribution digest',args=>{args.contributionPackageSha256=h(99);}],
  ['index',args=>{args.index=1;}],
])test('reopening rejects wrong '+name+' without replacing custody',()=>{
  const args=options(),created=openGuardCustody({...args,create:true});created.ledger.close();
  const before=readFileSync(created.database);change(args);assert.throws(()=>openGuardCustody(args));
  assert.deepEqual(readFileSync(created.database),before);assert.equal(readFileSync(created.manifest,'utf8'),created.bootstrap);
});
test('noncanonical bootstrap and empty replacement ledger are refused',()=>{
  const args=options(),created=openGuardCustody({...args,create:true});created.ledger.close();
  writeFileSync(created.manifest,created.bootstrap+'\n');assert.throws(()=>openGuardCustody(args),/drift/i);
  writeFileSync(created.manifest,created.bootstrap);renameSync(created.database,created.database+'.retained');writeFileSync(created.database,'');
  assert.throws(()=>openGuardCustody(args),/metadata|schema|table/i);
});
