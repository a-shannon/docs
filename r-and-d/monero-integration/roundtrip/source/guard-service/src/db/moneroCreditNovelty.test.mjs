import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,unlinkSync,readFileSync,renameSync,copyFileSync,lstatSync} from 'node:fs';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ECDH,randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {MoneroCreditAssignment as Ledger,committeeConfigDigest} from './moneroCreditAssignment.mjs';

const h=n=>n.toString(16).padStart(2,'0').repeat(32);
const keys=[1,2,3,4].map(n=>{const key=ECDH('secp256k1');key.setPrivateKey(Buffer.from(n.toString(16).padStart(64,'0'),'hex'));return key.getPublicKey('hex','compressed');});
const config={custodyDomain:'local-monero-genesis:'+h(1),guardKey:keys[0],committeeKeys:keys,
  quorum:3,maxFaults:1,activationId:'guard-activation-1',policyEpoch:'1',policyDigest:h(10),backingPolicy:'single-deposit-v2'};
const request=(obligationId='deposit')=>({binding:{obligationId,creditTransactionDigest:h(11),sourceIntentDigest:h(12),
  triggerBoxId:h(13),policyDigest:config.policyDigest,committeeDigest:committeeConfigDigest(config)},
  outputs:[{sourceNetwork:'mainnet',publicKey:h(14)}],backing:{version:2,genesis:h(1),committeeDigest:h(2),
    vaultSpend:h(3),vaultAddress:'configured-vault',intentHash:h(12),txId:h(4),blockHash:h(5),blockHeight:4097,
    outputIndex:1,globalIndex:5000,outputKey:h(14),keyImage:h(6),amountAtomic:'1000',destinationNetwork:'ergo-testnet',
    destinationAsset:h(7),recipient:'configured-recipient',creditedAtomic:'880'}});
const novelty=r=>({sourceNetwork:r.outputs[0].sourceNetwork,backing:structuredClone(r.backing)});
const bytes=file=>Object.fromEntries(['','-wal'].filter(s=>existsSync(file+s)).map(s=>[s,
  createHash('sha256').update(readFileSync(file+s)).digest('hex')]));
function fixture(t,cfg=config){
  const file=join(tmpdir(),'monero-novelty-'+randomUUID()+'.sqlite'),handles=[],extra=[];
  const writer=Ledger.create(file,cfg);handles.push(writer);
  t.after(()=>{for(const handle of handles)handle.close();for(const name of [file,...extra])for(const suffix of ['','-wal','-shm'])if(existsSync(name+suffix))unlinkSync(name+suffix);});
  return {file,writer,extra,read(c=cfg){const reader=Ledger.openReadOnly(file,c);handles.push(reader);return reader;}};
}

test('read-only novelty is fresh and carries the same complete checkpoint without writes',t=>{
  const f=fixture(t),before=bytes(f.file),reader=f.read(),r=request(),stat=lstatSync(f.file);
  assert.deepEqual(reader.inspectNovelty(novelty(r)),{status:'new',checkpoint:f.writer.checkpoint(),identity:{dev:stat.dev,ino:stat.ino}});
  assert.deepEqual(reader.checkpoint(),f.writer.checkpoint());assert.deepEqual(bytes(f.file),before);
  assert.equal(f.writer.assign(r).status,'assigned');const assigned=bytes(f.file);
  assert.deepEqual(reader.inspectNovelty(novelty(r)),{status:'claimed',checkpoint:f.writer.checkpoint(),identity:{dev:stat.dev,ino:stat.ino}});
  assert.equal(reader.assertAssigned(r).status,'assigned');assert.deepEqual(bytes(f.file),assigned);
  assert.equal(f.writer.assign(structuredClone(r)).status,'existing');
  assert.deepEqual(reader.checkpoint(),f.writer.checkpoint());assert.deepEqual(bytes(f.file),assigned);
});

test('read-only handles reject every mutation path without changing retained bytes',t=>{
  const f=fixture(t),r=request();f.writer.assign(r);const reader=f.read(),before=reader.checkpoint(),retained=bytes(f.file);
  const settlement=Object.fromEntries(['reservationId','reservationHash','requestDigest','selectionDigest','bindingDigest','expectationDigest'].map((key,i)=>[key,h(50+i)]));
  for(const operation of [()=>reader.assign(r),()=>reader.invalidate('deposit','source-reorganization'),
    ()=>reader.reserveSettlement(r,settlement),()=>reader.assertSettlement(r,settlement),()=>reader.observeSettlement(r,settlement)])
    assert.throws(operation,/custody:read-only/);
  assert.deepEqual(reader.checkpoint(),before);assert.deepEqual(bytes(f.file),retained);
});

test('P and I each reject a new occurrence, including after invalidation and reopen',t=>{
  const f=fixture(t),r=request();f.writer.assign(r);let reader=f.read();
  const sameP=novelty(r);Object.assign(sameP.backing,{txId:h(30),blockHash:h(31),blockHeight:5000,outputIndex:2,
    globalIndex:8000,committeeDigest:h(32),keyImage:h(33),intentHash:h(34),amountAtomic:'1500',creditedAtomic:'1380',recipient:'other-recipient'});
  const sameI=novelty(r);sameI.backing.outputKey=h(35);
  const independent=structuredClone(sameP);independent.backing.outputKey=h(36);
  for(const candidate of [sameP,sameI])assert.equal(reader.inspectNovelty(candidate).status,'claimed');
  assert.equal(reader.inspectNovelty(independent).status,'new');
  f.writer.invalidate('deposit','source-reorganization');reader.close();reader=f.read();
  const before=reader.checkpoint(),retained=bytes(f.file);
  for(const candidate of [novelty(r),sameP,sameI])assert.equal(reader.inspectNovelty(candidate).status,'claimed');
  assert.equal(reader.inspectNovelty(independent).status,'new');
  assert.deepEqual(reader.checkpoint(),before);assert.deepEqual(bytes(f.file),retained);
});

test('novelty validates the complete v2 descriptor and trusted custody genesis',t=>{
  const f=fixture(t),reader=f.read(),valid=novelty(request()),before=reader.checkpoint();
  for(const key of Object.keys(valid.backing)){
    const missing=structuredClone(valid);delete missing.backing[key];assert.throws(()=>reader.inspectNovelty(missing),undefined,'missing '+key);
    const invalid=structuredClone(valid);invalid.backing[key]=null;assert.throws(()=>reader.inspectNovelty(invalid),undefined,'null '+key);
  }
  for(const candidate of [{...valid,sourceNetwork:'unknown'},{...valid,extra:true},
    {...valid,backing:{...valid.backing,genesis:h(99)}},{...valid,backing:{...valid.backing,outputIndex:-0}},
    {...valid,backing:{...valid.backing,amountAtomic:'01'}}])assert.throws(()=>reader.inspectNovelty(candidate));
  let accessed=false;const accessor=structuredClone(valid);Object.defineProperty(accessor.backing,'outputKey',{enumerable:true,get(){accessed=true;return h(14);}});
  assert.throws(()=>reader.inspectNovelty(accessor),/backing:schema/);assert.equal(accessed,false);
  assert.deepEqual(reader.checkpoint(),before);
});

test('novelty refuses non-v2 custody and opening refuses missing or mismatched state',t=>{
  const legacy=fixture(t,{...config,backingPolicy:'single-deposit-v1'});
  assert.throws(()=>legacy.read().inspectNovelty(novelty(request())),/novelty:profile/);
  const f=fixture(t),missing=f.file+'.missing';
  assert.throws(()=>Ledger.openReadOnly(missing,config),/ENOENT/);assert.equal(existsSync(missing),false);
  assert.throws(()=>f.read({...config,policyEpoch:'2'}),/custody:config-drift/);
  const reader=f.read();reader.close();assert.throws(()=>reader.inspectNovelty(novelty(request())),/custody:closed/);
});

for(const [label,sql,error]of [
  ['metadata',"UPDATE metadata SET revision=-1",/custody:config-drift/],
  ['claim',"UPDATE claims SET requestDigest='bad'",/custody:claim-integrity/],
  ['output','DELETE FROM outputs',/custody:output-integrity/],
  ['image','DELETE FROM nullifiers',/custody:nullifier-integrity/],
])test('read-only novelty and checkpoints fail closed on '+label+' corruption',t=>{
  const f=fixture(t),r=request();f.writer.assign(r);const reader=f.read(),external=new DatabaseSync(f.file);
  try{external.exec(sql);}finally{external.close();}const corrupted=bytes(f.file);
  assert.throws(()=>reader.inspectNovelty(novelty(r)),error);assert.throws(()=>reader.checkpoint(),error);
  assert.throws(()=>f.read(),error);assert.deepEqual(bytes(f.file),corrupted);
});

test('a retained read-only view rejects changed file identity or native replacement',t=>{
  const f=fixture(t),reader=f.read(),replacement=fixture(t);replacement.writer.close();f.writer.close();
  const retained=f.file+'.retained';f.extra.push(retained);
  let locked=false;
  try{renameSync(f.file,retained);copyFileSync(replacement.file,f.file);}
  catch(error){
    // Windows SQLite prevents replacement while a handle is open. Exercise the
    // identity discriminant separately, without bypassing that native lock.
    if(process.platform!=='win32'||error.code!=='EBUSY')throw error;
    locked=true;const original=fs.lstatSync;
    t.mock.method(fs,'lstatSync',(file,...args)=>{const stat=original(file,...args);if(file===f.file)stat.ino++;return stat;});
    syncBuiltinESMExports();
  }
  try{
    assert.throws(()=>reader.inspectNovelty(novelty(request())),/custody:file-replaced/);
    assert.throws(()=>reader.checkpoint(),/custody:file-replaced/);
  }finally{if(locked){t.mock.restoreAll();syncBuiltinESMExports();}}
});
