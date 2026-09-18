import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createECDH,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {serveProcessRpc,emitProcessEvent} from '../tools/process-rpc.mjs';
import {readParticipantConfig} from '../tools/participant-config.mjs';
import {auditCreditBacking} from './credit-backing-audit.mjs';

const file=process.env.PARTICIPANT_CONFIG;
assert(path.isAbsolute(file??''),'Absolute participant configuration required');
const {selected,sha256:configSha256}=readParticipantConfig();
assert.equal(Object.keys(selected).sort().join(','),'candidate,deployment,directory,index,roundtripConfig,secretKey,source,version,watcherReceipt');
assert.equal(selected.version,1);assert(Number.isInteger(selected.index)&&selected.index>=0&&selected.index<4);
assert(path.isAbsolute(selected.directory)&&path.isAbsolute(selected.roundtripConfig));
assert.equal(selected.deployment.guardSecrets,undefined,'Actor cannot receive other guard secrets');
assert(selected.deployment.watchers.every(w=>w.secretKey===undefined),'Actor cannot receive watcher secrets');
assert.match(selected.secretKey,/^[0-9a-f]{64}$/);
const ownKey=createECDH('secp256k1');ownKey.setPrivateKey(Buffer.from(selected.secretKey,'hex'));
assert.equal(ownKey.getPublicKey('hex','compressed'),selected.deployment.guardPublicKeys[selected.index]);
process.env.ROUNDTRIP_CONFIG=selected.roundtripConfig;
await import('./deposit-register.mjs');
const [{config},{openProcessSource},{openCreditVerifier},{stateContext},{captureContributionPackage},ledgerModule,signerModule]=await Promise.all([
  import('../tools/config.mjs'),import('./process-source.mjs'),import('./authorized-credit.mjs'),import('./authority-fixture.mjs'),
  import('../tools/contribution-package.mjs'),import('../guard-service/src/db/moneroCreditAssignment.mjs'),
  import('../guard-service/src/deposit/moneroCreditSigner.mjs')]);
const {MoneroCreditAssignment,canonicalAssignment}=ledgerModule;
const {createMoneroCreditSigner,snapshotCreditSigning}=signerModule;
const sources=await Promise.all(Array.from({length:4},()=>openProcessSource(selected.source)));
const verifier=await openCreditVerifier({directory:path.join(selected.directory,'verification'),deployment:selected.deployment,
  watcherReceipt:selected.watcherReceipt,freshAdmission:{readers:sources,candidate:selected.candidate}});
const implementation=captureContributionPackage(config.contributionPackage);
const {MultiSigHandler,MultiSigUtils}=await import(implementation.entry);implementation.verify();
const require=createRequire(path.join(config.rosenRoot,'package.json')),wasm=require('ergo-lib-wasm-nodejs');
const {ECDSA}=await import('@rosen-bridge/encryption'),{DummyLogger}=await import('@rosen-bridge/abstract-logger');
const index=selected.index,keys=[...selected.deployment.guardPublicKeys],peerIds=keys.map((_,i)=>'process-credit-guard-'+i);
const configuration=verifier.configurations()[index],custody=path.join(selected.directory,'custody');
const bootstrap=canonicalAssignment({version:1,index,configuration,contributionPackageSha256:implementation.sha256});
const manifest=path.join(custody,'bootstrap.json'),database=path.join(custody,'ledger.sqlite');
fs.mkdirSync(custody,{recursive:true});let ledger;
if(fs.existsSync(manifest)){
  assert.equal(fs.readFileSync(manifest,'utf8'),bootstrap,'Guard bootstrap drift');assert(fs.existsSync(database),'Missing retained guard ledger');
  ledger=MoneroCreditAssignment.open(database,configuration);
}else{
  assert.equal(fs.readdirSync(custody).length,0,'Unidentified guard custody');
  const fd=fs.openSync(manifest,'wx');try{fs.writeFileSync(fd,bootstrap);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  ledger=MoneroCreditAssignment.create(database,configuration);
}
let active,closed=false,auditing=false,facade;const gates=new Map(),counts={commitments:0,partialSigns:0,completed:0,messagesSent:0,messagesReceived:0};
const current=()=>{assert(!closed,'Closed guard process');return active;};
const stats=()=>({index,pid:process.pid,counts:{...counts},checkpoint:ledger.checkpoint(),proofCalls:sources.reduce((n,s)=>n+s.proofCalls,0),
  coordinatorIndex:participant.getCurrentTurnInd(),session:active?.session??null});
async function pause(checkpoint){
  const run=current();assert(run,'Guard session missing');
  await new Promise(resolve=>{gates.set(checkpoint,resolve);emitProcessEvent('checkpoint',{index,session:run.session,checkpoint});});
  current();
}
const participant=new MultiSigHandler({logger:new DummyLogger(),multiSigUtilsInstance:new MultiSigUtils(stateContext),
  messageEnc:new ECDSA(selected.secretKey),secretHex:selected.secretKey,txSignTimeout:60,turnTime:600,
  commGuardsPk:keys,ergoGuardPks:[...keys],guardDetection:{activeGuards:async()=>
    (active?.indices??[0,1,2,3]).map(i=>({index:i,peerId:peerIds[i]}))},
  submit(message,recipients){const run=current();assert(run,'Inactive guard session');
    counts.messagesSent++;emitProcessEvent('packet',{index,session:run.session,message,recipients});},
  async beforeContribution(request){const run=current();assert(run&&!run.settled,'Inactive contribution');
    if(run.pausePartials&&request.kind!=='commitment')await pause('beforePartial');
    implementation.verify();await facade.refreshContribution(request);current();implementation.verify();}});
assert.equal(participant.contributionValidationVersion,1);assert.equal(participant.getPk(),keys[index]);
const prover=participant.getProver.bind(participant);let counted;
participant.getProver=()=>counted??=(new Proxy(prover(),{get(target,name){const value=Reflect.get(target,name,target);
  if(name==='generate_commitments_for_reduced_transaction'||name==='sign_reduced_transaction_multi')return(...args)=>{
    const result=value.apply(target,args);counts[name==='generate_commitments_for_reduced_transaction'?'commitments':'partialSigns']++;
    emitProcessEvent('contribution',{index,session:active.session,counts:{...counts}});return result;};
  return typeof value==='function'?value.bind(target):value;}}));
const turn=participant.handleMyTurnForTx.bind(participant);
participant.handleMyTurnForTx=async txId=>{const run=current();assert(run&&run.txId===txId,'Unbound queued transaction');
  if(!run.queued){run.queued=true;emitProcessEvent('queued',{index,session:run.session,txId});}};
facade=createMoneroCreditSigner({participant,assignment:ledger,verify:snapshot=>verifier.verifyForGuard(index,snapshot),requireFreshContribution:true});
const nativeBox=hex=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(hex,'hex'));
function snapshotFrom(row){
  assert(row&&Object.keys(row).sort().join(',')==='dataHex,digest,inputHex,reducedHex,requiredSign,txId');
  const snapshot=snapshotCreditSigning(wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(row.reducedHex,'hex')),row.requiredSign,
    row.inputHex.map(nativeBox),row.dataHex.map(nativeBox));
  assert.equal(snapshot.digest,row.digest);assert.equal(snapshot.txId,row.txId);assert.equal(snapshot.requiredSign,3);return snapshot;
}
await serveProcessRpc({ready:{index,pid:process.pid,guardKey:keys[index],configuration,policyDigest:verifier.policyDigest,
  configSha256,custodyPath:fs.realpathSync(custody),
  bootstrapSha256:createHash('sha256').update(bootstrap).digest('hex'),coordinatorIndex:participant.getCurrentTurnInd()},handlers:{
  async sign({session,snapshot,indices,pausePartials=false}){
    current();assert(!auditing,'Active backing audit');assert(!active,'A process hosts one signing attempt; restart before retry');assert.match(session,/^[0-9a-f-]{36}$/);
    assert(Array.isArray(indices)&&indices.length>=3&&indices.length<=4&&new Set(indices).size===indices.length);
    assert(indices.every(i=>Number.isInteger(i)&&i>=0&&i<4)&&indices.includes(index));assert.equal(typeof pausePartials,'boolean');
    const captured=snapshotFrom(snapshot);active={session,txId:captured.txId,indices:[...indices],pausePartials,queued:false,settled:false,seen:new Set()};
    try{const signed=await facade.sign(captured.reduced,3,captured.inputs,captured.dataInputs);counts.completed++;
      active.settled=true;return {signedHex:Buffer.from(signed.sigma_serialize_bytes()).toString('hex'),txId:signed.id().to_str(),stats:stats()};}
    catch(error){active.settled=true;facade.close();throw error;}
  },
  async turn({session}){const run=current();assert(run?.session===session&&run.queued&&!run.settled,'Unready guard turn');await turn(run.txId);return null;},
  async message({session,sender,message}){const run=current();assert(run?.session===session,'Stale transport session');
    assert(Number.isInteger(sender)&&run.indices.includes(sender)&&sender!==index);assert.equal(typeof message,'string');
    const packetHash=createHash('sha256').update(sender+'\0'+message).digest('hex');
    if(run.seen.has(packetHash)||run.settled)return null;
    assert(run.seen.size<1000,'Guard message budget');run.seen.add(packetHash);
    await facade.handleMessage(message,peerIds[sender]);counts.messagesReceived++;return null;},
  resume({checkpoint}){const gate=gates.get(checkpoint);assert(gate,'Guard is not paused');gates.delete(checkpoint);gate();return null;},
  async verify(snapshot){current();const result=await verifier.verifyForGuard(index,snapshotFrom(snapshot));result.assertCurrent();return result.assignment;},
  async audit(snapshot){current();assert(!auditing&&(!active||active.settled),'Active signing session or backing audit');auditing=true;
    try{return await auditCreditBacking({assignment:verifier.expectedAssignment(snapshotFrom(snapshot)),ledger,
      readAnchor:height=>sources[index].anchor(height),readBacking:()=>verifier.readBacking(index),assertCurrent:current});}finally{auditing=false;}},
  observe(request){current();return ledger.observeAssignment(request);},
  assertAssigned(request){current();return ledger.assertAssigned(request);},
  invalidate({obligationId,reason}){current();return ledger.invalidate(obligationId,reason);},
  stats(){current();return stats();}
},async close(){closed=true;facade.close();for(const gate of gates.values())gate();gates.clear();verifier.close();
  for(const source of sources)source.close();ledger.close();}});
