import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ECDH} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {MoneroCreditAssignment as BaseLedger, assignmentConfigDigest, committeeConfigDigest} from './moneroCreditAssignment.mjs';

const handles=new Map();
const tracked=(method,file,config)=>{const ledger=BaseLedger[method](file,config);handles.set(file,[...(handles.get(file)??[]),ledger]);return ledger;};
const Ledger={create:(file,config)=>tracked('create',file,config),open:(file,config)=>tracked('open',file,config)};

const keys=[1,2,3,4].map(n=>{const e=ECDH('secp256k1');e.setPrivateKey(Buffer.from(n.toString(16).padStart(64,'0'),'hex'));return e.getPublicKey('hex','compressed');});
const config={custodyDomain:'controlled-test-custody',guardKey:keys[0],committeeKeys:keys,quorum:3,maxFaults:1,activationId:'fixed-committee-1',policyEpoch:'1',policyDigest:'aa'.repeat(32)};
const make=(id,outputs=['11'.repeat(32)])=>({binding:{obligationId:id,creditTransactionDigest:'bb'.repeat(32),sourceIntentDigest:'cc'.repeat(32),triggerBoxId:'dd'.repeat(32),policyDigest:config.policyDigest,committeeDigest:committeeConfigDigest(config)},outputs:outputs.map(publicKey=>({sourceNetwork:'mainnet',publicKey}))});
const backingConfig={...config,backingPolicy:'single-deposit-v1'};
const backed=(id='deposit')=>({...make(id),binding:{...make(id).binding,committeeDigest:committeeConfigDigest(backingConfig)},backing:{
  version:1,genesis:'01'.repeat(32),vaultSpend:'02'.repeat(32),vaultAddress:'local-vault',intentHash:'cc'.repeat(32),
  txid:'03'.repeat(32),outputIndex:'0',globalIndex:'42',publicKey:'11'.repeat(32),keyImage:'04'.repeat(32),amountAtomic:'1000',
  destinationNetwork:'ergo-testnet',destinationAsset:'05'.repeat(32),recipient:'local-recipient',creditedAtomic:'880'}});
const settlement=()=>Object.fromEntries(['reservationId','reservationHash','requestDigest','selectionDigest','bindingDigest','expectationDigest'].map((key,index)=>[key,(index+10).toString(16).padStart(2,'0').repeat(32)]));
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'assignment-test-'));const file=join(directory,'guard.sqlite');t.after(()=>{for(const ledger of handles.get(file)??[])ledger.close();handles.delete(file);rmSync(directory,{recursive:true,force:true});});return file;}
test('explicit creation, restart, exact retry and txid-independent conflict',t=>{
  const file=fixture(t);assert.throws(()=>Ledger.open(file,config));assert.equal(existsSync(file),false);
  let l=Ledger.create(file,config);assert.throws(()=>Ledger.create(file,config));
  const request=make('txA');assert.equal(l.assign(request).status,'assigned');const before=l.checkpoint();l.close();
  l=Ledger.open(file,config);t.after(()=>l.close());assert.deepEqual(l.checkpoint(),before);
  assert.equal(l.assign(request).status,'existing');assert.equal(l.assign(make('txB')).status,'conflict');
  const edited=structuredClone(request);edited.binding.creditTransactionDigest='ef'.repeat(32);assert.equal(l.assign(edited).status,'conflict');
  assert.deepEqual(l.checkpoint(),before);
});
test('partial overlap is atomic and invalidation retains all liability',t=>{
  const l=Ledger.create(fixture(t),config);t.after(()=>l.close());const a='11'.repeat(32),b='22'.repeat(32);
  l.assign(make('a',[a]));const before=l.checkpoint();assert.equal(l.assign(make('b',[b,a])).status,'conflict');assert.deepEqual(l.checkpoint(),before);
  assert.equal(l.assign(make('c',[b])).status,'assigned');l.invalidate('a','source-fork');
  assert.equal(l.assign(make('a',[a])).status,'invalidated');assert.equal(l.assign(make('replacement',[a])).status,'conflict');
  assert.equal(l.checkpoint().outputs,2);const checkpoint=l.checkpoint();l.invalidate('a','again');assert.deepEqual(l.checkpoint(),checkpoint);
});
test('unsafe quorum, invalid points, config drift and malformed output rejection',t=>{
  const file=fixture(t);for(const patch of [{quorum:2},{maxFaults:2},{committeeKeys:[...keys.slice(0,3),keys[0]]},{guardKey:'02'+'ff'.repeat(32)}]) assert.throws(()=>Ledger.create(file,{...config,...patch}));
  const l=Ledger.create(file,config);t.after(()=>l.close());
  for(const patch of [{policyEpoch:'2'},{guardKey:keys[1]},{activationId:'other'},{committeeKeys:[...keys].reverse()}]) assert.throws(()=>Ledger.open(file,{...config,...patch}));
  for(const r of [make('empty',[]),make('duplicate',['11'.repeat(32),'11'.repeat(32)]),make('uppercase',['AB'.repeat(32)]),{...make('extra'),unexpected:true}]) assert.throws(()=>l.assign(r));
  assert.deepEqual(l.checkpoint().outputs,0);
});
test('two open handles serialize conflicting assignment',t=>{
  const file=fixture(t),a=Ledger.create(file,config),b=Ledger.open(file,config);t.after(()=>{a.close();b.close();});
  assert.equal(a.assign(make('first')).status,'assigned');assert.equal(b.assign(make('second')).status,'conflict');assert.equal(b.checkpoint().claims,1);
});
test('four independent guards share one committee binding but distinct custody pins',t=>{
  const configs=keys.map(guardKey=>({...config,guardKey}));
  assert.equal(new Set(configs.map(committeeConfigDigest)).size,1);
  assert.equal(new Set(configs.map(assignmentConfigDigest)).size,4);
  const request=make('committee-obligation'),results=configs.map(c=>{
    const file=fixture(t),l=Ledger.create(file,c);const assigned=l.assign(request);l.close();
    const reopened=Ledger.open(file,c);assert.equal(reopened.assign(request).status,'existing');return assigned;
  });
  assert.deepEqual(results.map(r=>r.status),['assigned','assigned','assigned','assigned']);
  assert.equal(new Set(results.map(r=>r.requestDigest)).size,1);
});
test('recovery reads refuse missing, conflicting and invalidated claims without mutation',t=>{
  const file=fixture(t),l=Ledger.create(file,config),request=make('recovery');
  const empty=l.checkpoint();assert.throws(()=>l.assertAssigned(request),/assignment:missing/);assert.deepEqual(l.checkpoint(),empty);
  const committed=l.assign(request);const assigned=l.checkpoint();assert.equal(l.assertAssigned(request).status,'assigned');
  const edited=structuredClone(request);edited.binding.creditTransactionDigest='ee'.repeat(32);
  assert.throws(()=>l.assertAssigned(edited),/assignment:conflict/);assert.throws(()=>l.observeAssignment(make('other')),/assignment:conflict/);
  assert.deepEqual(l.checkpoint(),assigned);l.invalidate('recovery','source-fork');const invalidated=l.checkpoint();
  assert.throws(()=>l.assertAssigned(request),/assignment:invalidated/);
  assert.deepEqual(l.observeAssignment(request),{status:'invalidated',requestDigest:committed.requestDigest,obligationId:'recovery',reason:'source-fork'});
  assert.deepEqual(l.checkpoint(),invalidated);l.close();const reopened=Ledger.open(file,config);
  assert.throws(()=>reopened.assertAssigned(request),/assignment:invalidated/);assert.deepEqual(reopened.checkpoint(),invalidated);
});
test('partial retained claim fails read-only integrity check and remains partial',t=>{
  const file=fixture(t),l=Ledger.create(file,config),request=make('partial');l.assign(request);
  const external=new DatabaseSync(file);external.exec('DELETE FROM outputs');external.close();const before=l.checkpoint();
  assert.throws(()=>l.observeAssignment(request),/custody:output-integrity/);assert.deepEqual(l.checkpoint(),before);
});
test('disk failure on a later output rolls back every claim row',t=>{
  const file=fixture(t),l=Ledger.create(file,config);t.after(()=>l.close());const external=new DatabaseSync(file);
  external.exec("CREATE TRIGGER reject_second BEFORE INSERT ON outputs WHEN NEW.economicId LIKE '%2222' BEGIN SELECT RAISE(ABORT,'controlled-storage-fault'); END");
  external.close();const before=l.checkpoint();assert.throws(()=>l.assign(make('partial',['11'.repeat(32),'22'.repeat(32)])),/controlled-storage-fault/);
  assert.deepEqual(l.checkpoint(),before);assert.equal(l.assign(make('other',['11'.repeat(32)])).status,'assigned');
});
test('invalidation remains terminal after reopening; output order is canonical',t=>{
  const file=fixture(t),a='11'.repeat(32),b='22'.repeat(32);let l=Ledger.create(file,config);
  l.assign(make('original',[b,a]));assert.equal(l.assign(make('original',[a,b])).status,'existing');
  l.invalidate('original','source-invalidated');const before=l.checkpoint();l.close();l=Ledger.open(file,config);t.after(()=>l.close());
  assert.deepEqual(l.checkpoint(),before);assert.equal(l.assign(make('original',[a,b])).status,'invalidated');
  assert.equal(l.assign(make('another-event',[a])).status,'conflict');
});
function worker(file,request){
  const code=`import {MoneroCreditAssignment as Ledger} from ${JSON.stringify(new URL('./moneroCreditAssignment.mjs',import.meta.url).href)};
    const ledger=Ledger.open(process.argv[1],JSON.parse(process.argv[2]));
    process.stdout.write('ready\\n');process.stdin.once('data',()=>{try{process.stdout.write(JSON.stringify(ledger.assign(JSON.parse(process.argv[3])))+'\\n');ledger.close();}catch(e){process.stderr.write(e.message);process.exitCode=1;}});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code,file,JSON.stringify(config),JSON.stringify(request)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',stderr='';let readyResolve;const ready=new Promise(r=>readyResolve=r);
  child.stdout.on('data',data=>{output+=data; if(output.includes('ready\n'))readyResolve();});child.stderr.on('data',data=>stderr+=data);
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve(JSON.parse(output.trim().split('\n').at(-1))):reject(Error(stderr)));});
  return {child,ready,done};
}
test('independent processes compete for one P and preserve winner on restart', {timeout:15000},async t=>{
  const file=fixture(t);Ledger.create(file,config).close();const a=worker(file,make('processA')),b=worker(file,make('processB'));
  t.after(()=>{a.child.kill();b.child.kill();});await Promise.all([a.ready,b.ready]);a.child.stdin.end('go');b.child.stdin.end('go');
  const results=await Promise.all([a.done,b.done]);assert.deepEqual(results.map(r=>r.status).sort(),['assigned','conflict']);
  const l=Ledger.open(file,config);t.after(()=>l.close());assert.equal(l.checkpoint().claims,1);assert.equal(l.checkpoint().outputs,1);
});
test('backing is mandatory only in its pinned profile and survives exact reopen',t=>{
  const file=fixture(t),request=backed();let l=Ledger.create(file,backingConfig);
  const absent={...request};delete absent.backing;assert.throws(()=>l.assign(absent));
  assert.throws(()=>assignmentConfigDigest({...config,backingPolicy:undefined}));
  assert.throws(()=>assignmentConfigDigest({...config,backingPolicy:'other'}));
  assert.equal(l.assign(request).status,'assigned');const before=l.checkpoint();l.close();l=Ledger.open(file,backingConfig);
  assert.equal(l.assign(request).status,'existing');assert.equal(l.assertAssigned(request).status,'assigned');assert.deepEqual(l.checkpoint(),before);
  const db=new DatabaseSync(file);assert.deepEqual(JSON.parse(db.prepare('SELECT request FROM claims').get().request).backing,request.backing);db.close();
  assert.throws(()=>Ledger.open(file,config));const legacy=Ledger.create(fixture(t),config);assert.throws(()=>legacy.assign({...make('legacy'),backing:request.backing}));
});
test('every backing field is required, immutable and type checked',t=>{
  const l=Ledger.create(fixture(t),backingConfig),request=backed();l.assign(request);const before=l.checkpoint();
  for(const key of Object.keys(request.backing)){
    const absent=structuredClone(request);delete absent.backing[key];assert.throws(()=>l.assign(absent),key+' missing');
    const wrong=structuredClone(request);wrong.backing[key]=null;assert.throws(()=>l.assign(wrong),key+' null');
  }
  for(const key of ['genesis','vaultSpend','intentHash','txid','publicKey','keyImage','destinationAsset']){
    for(const value of ['AB'.repeat(32),'ab','gg'.repeat(32),32]){const r=structuredClone(request);r.backing[key]=value;assert.throws(()=>l.assign(r),key);}
  }
  for(const key of ['outputIndex','globalIndex','amountAtomic','creditedAtomic']){
    for(const value of ['01','-1','1.0','18446744073709551616',1]){const r=structuredClone(request);r.backing[key]=value;assert.throws(()=>l.assign(r),key);}
  }
  for(const key of ['amountAtomic','creditedAtomic']){const r=structuredClone(request);r.backing[key]='0';assert.throws(()=>l.assign(r),key);}
  for(const key of ['vaultAddress','destinationNetwork','recipient']){
    for(const value of ['', 'x'.repeat(257),'line\nfeed']){const r=structuredClone(request);r.backing[key]=value;assert.throws(()=>l.assign(r),key);}
  }
  for(const patch of [{version:2},{extra:true},{publicKey:'55'.repeat(32)},{intentHash:'55'.repeat(32)}])assert.throws(()=>l.assign({...request,backing:{...request.backing,...patch}}));
  assert.throws(()=>l.assign({...request,outputs:[...request.outputs,{sourceNetwork:'mainnet',publicKey:'55'.repeat(32)}]}));
  for(const key of ['genesis','vaultSpend','txid','keyImage','destinationAsset','outputIndex','globalIndex','amountAtomic','creditedAtomic','vaultAddress','destinationNetwork','recipient']){
    const r=structuredClone(request);r.backing[key]=['outputIndex','globalIndex','amountAtomic','creditedAtomic'].includes(key)?'99':['vaultAddress','destinationNetwork','recipient'].includes(key)?'changed':'55'.repeat(32);
    assert.equal(l.assign(r).status,'conflict',key+' retained');
  }
  assert.deepEqual(l.checkpoint(),before);
});
test('P and I each reserve one obligation atomically, including after invalidation',t=>{
  const file=fixture(t),l=Ledger.create(file,backingConfig),first=backed('first');l.assign(first);const before=l.checkpoint();
  const sameP=backed('sameP');sameP.backing.keyImage='55'.repeat(32);assert.equal(l.assign(sameP).status,'conflict');
  const sameI=backed('sameI');sameI.backing.publicKey='66'.repeat(32);sameI.outputs[0].publicKey=sameI.backing.publicKey;
  assert.equal(l.assign(sameI).status,'conflict');assert.deepEqual(l.checkpoint(),before);
  const independent=structuredClone(sameI);independent.backing.keyImage=sameP.backing.keyImage;assert.equal(l.assign(independent).status,'assigned');
  l.invalidate('first','source-reorganization');assert.equal(l.assign(sameP).status,'conflict');assert.equal(l.assign(sameI).status,'conflict');
  l.close();const reopened=Ledger.open(file,backingConfig);assert.equal(reopened.assign(sameP).status,'conflict');assert.equal(reopened.assign(sameI).status,'conflict');
});
test('failed nullifier insert rolls back P and claim as one transaction',t=>{
  const file=fixture(t),l=Ledger.create(file,backingConfig),db=new DatabaseSync(file);
  db.exec("CREATE TRIGGER reject_image BEFORE INSERT ON nullifiers BEGIN SELECT RAISE(ABORT,'nullifier-storage-fault'); END");
  const before=l.checkpoint();assert.throws(()=>l.assign(backed()),/nullifier-storage-fault/);assert.deepEqual(l.checkpoint(),before);
  db.exec('DROP TRIGGER reject_image');db.close();assert.equal(l.assign(backed()).status,'assigned');
});
test('one immutable settlement per backed obligation persists and invalidation never releases it',t=>{
  const file=fixture(t),request=backed(),s=settlement();let l=Ledger.create(file,backingConfig);
  assert.throws(()=>l.reserveSettlement(request,s),/assignment:missing/);l.assign(request);
  assert.throws(()=>l.assertSettlement(request,s),/settlement:missing/);assert.equal(l.reserveSettlement(request,s).status,'reserved');
  const before=l.checkpoint();assert.equal(l.reserveSettlement(request,s).status,'existing');assert.equal(l.assertSettlement(request,s).status,'assigned');
  for(const key of Object.keys(s)){
    const changed={...s,[key]:'ff'.repeat(32)};
    for(const method of ['reserveSettlement','assertSettlement','observeSettlement'])assert.throws(()=>l[method](request,changed),/settlement:conflict/,key);
    for(const value of [undefined,null,'AB'.repeat(32),'ab'])assert.throws(()=>l.reserveSettlement(request,{...s,[key]:value}),key);
    const absent={...s};delete absent[key];assert.throws(()=>l.reserveSettlement(request,absent),key+' missing');
  }
  assert.throws(()=>l.reserveSettlement(request,{...s,extra:true}));assert.deepEqual(l.checkpoint(),before);
  l.close();l=Ledger.open(file,backingConfig);assert.equal(l.reserveSettlement(request,s).status,'existing');assert.deepEqual(l.assertSettlement(request,s).settlement,s);
  l.invalidate(request.binding.obligationId,'source-fork');const invalidated=l.checkpoint();
  assert.throws(()=>l.reserveSettlement(request,s),/assignment:invalidated/);assert.throws(()=>l.assertSettlement(request,s),/assignment:invalidated/);
  assert.equal(l.observeSettlement(request,s).status,'invalidated');assert.deepEqual(l.checkpoint(),invalidated);l.close();
  const reopened=Ledger.open(file,backingConfig);assert.equal(reopened.observeSettlement(request,s).status,'invalidated');assert.throws(()=>reopened.reserveSettlement(request,s),/assignment:invalidated/);
});
test('settlement and nullifier integrity failures fail closed on live read and reopen',t=>{
  for(const sql of ['DELETE FROM nullifiers',"UPDATE nullifiers SET nullifierId='wrong'",'DELETE FROM settlements',"UPDATE settlements SET settlementDigest='wrong'", "UPDATE settlements SET settlement='{}'"]){
    const file=fixture(t),request=backed(),s=settlement(),l=Ledger.create(file,backingConfig);l.assign(request);l.reserveSettlement(request,s);
    const db=new DatabaseSync(file);db.exec(sql);db.close();
    assert.throws(()=>l.observeSettlement(request,s),undefined,sql);l.close();assert.throws(()=>Ledger.open(file,backingConfig),undefined,sql);
  }
});
test('missing schema or version-one custody is never silently migrated',t=>{
  for(const sql of ['DROP TABLE nullifiers','DROP TABLE settlements','UPDATE metadata SET version=1']){
    const file=fixture(t),l=Ledger.create(file,backingConfig);l.close();const db=new DatabaseSync(file);db.exec(sql);db.close();assert.throws(()=>Ledger.open(file,backingConfig));
  }
});
test('backing and settlement reject hidden fields, symbols, accessors and unusual prototypes',t=>{
  const l=Ledger.create(fixture(t),backingConfig),request=backed();l.assign(request);let accessed=0;
  const corruptions=[
    value=>Object.defineProperty(value,'hidden',{value:true}),
    value=>Object.defineProperty(value,Symbol('extra'),{value:true}),
    value=>Object.defineProperty(value,Object.keys(value)[0],{enumerable:true,get(){accessed++;return 1;}}),
    value=>Object.setPrototypeOf(value,{inherited:true}),
  ];
  for(const corrupt of corruptions){
    const r=structuredClone(request);corrupt(r.backing);assert.throws(()=>l.assign(r));
    const s=settlement();corrupt(s);assert.throws(()=>l.reserveSettlement(request,s));
  }
  assert.equal(accessed,0);assert.equal(l.checkpoint().settlements,0);
});
test('settlement disk failure is atomic and competing handles retain one exact settlement',t=>{
  const file=fixture(t),a=Ledger.create(file,backingConfig),b=Ledger.open(file,backingConfig),r=backed(),s=settlement();a.assign(r);
  const db=new DatabaseSync(file);db.exec("CREATE TRIGGER fail_settlement_marker BEFORE UPDATE OF settlementDigest ON claims BEGIN SELECT RAISE(ABORT,'settlement-storage-fault'); END");
  const before=a.checkpoint();assert.throws(()=>a.reserveSettlement(r,s),/settlement-storage-fault/);assert.deepEqual(a.checkpoint(),before);
  db.exec('DROP TRIGGER fail_settlement_marker');db.close();assert.equal(b.reserveSettlement(r,s).status,'reserved');
  assert.throws(()=>a.reserveSettlement(r,{...s,reservationId:'aa'.repeat(32)}),/settlement:conflict/);assert.equal(a.reserveSettlement(r,s).status,'existing');
});
