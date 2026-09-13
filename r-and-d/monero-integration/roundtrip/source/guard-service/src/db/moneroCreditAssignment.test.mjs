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
