import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {canonicalObservation,openWatcherStore,loadWatcherRuntime} from './watcher-runtime.mjs';
import {verifyCreditEvent} from './credit-event-policy.mjs';
const observation={sourceTxId:'11'.repeat(32),fromChain:'monero',toChain:'ergo',fromAddress:'source',toAddress:'target',amount:'100',bridgeFee:'2',networkFee:'3',sourceChainTokenId:'XMR',targetChainTokenId:'22'.repeat(32),sourceBlockId:'33'.repeat(32),height:3,requestId:'44'.repeat(32)};
test('canonical observation keeps the complete commitment preimage and rejects missing fields',()=>{assert.deepEqual(canonicalObservation({...observation,irrelevant:true}),observation);for(const field of Object.keys(observation)){const candidate={...observation};delete candidate[field];assert.throws(()=>canonicalObservation(candidate));}});
test('independent durable watcher stores reject request and observation conflicts',()=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),'watcher-store-'));const filename=path.join(directory,'one.sqlite');let store=openWatcherStore(filename);assert.deepEqual(store.observe({proof:'first'},observation),observation);assert.deepEqual(store.observation(observation.requestId),observation);store.close();store=openWatcherStore(filename);assert.deepEqual(store.observe({proof:'first'},observation),observation);assert.deepEqual(store.observation(observation.requestId),observation);assert.throws(()=>store.observe({proof:'different'},observation),/Conflicting watcher request/);assert.throws(()=>store.observe({proof:'first'},{...observation,amount:'101'}),/Conflicting watcher observation/);const independent=openWatcherStore(path.join(directory,'two.sqlite'));assert.deepEqual(independent.observe({proof:'different'},observation),observation);store.close();independent.close();fs.rmSync(directory,{recursive:true});});
test('signed queue survives reopening and forbids rebuilding a changed transaction',()=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),'watcher-queue-')),filename=path.join(directory,'watcher.sqlite');const fake=id=>({id:()=>({to_str:()=>id}),sigma_serialize_bytes:()=>Buffer.from(id,'hex'),to_json:()=>JSON.stringify({id})});let store=openWatcherStore(filename);store.queue('commitment',observation.requestId,fake('aa'));store.close();store=openWatcherStore(filename);assert.equal(store.readQueue('commitment').signedHex,'aa');assert.throws(()=>store.queue('commitment',observation.requestId,fake('bb')),/Queued transaction drift/);store.confirm('commitment',{id:'aa',numConfirmations:1});assert.deepEqual(JSON.parse(store.readQueue('commitment').confirmed),{id:'aa',numConfirmations:1});store.close();fs.rmSync(directory,{recursive:true});});
test('actual pinned commitment checker isolates digest and RWT count',{skip:!process.env.WATCHER_DEPENDENCY_ROOT},async()=>{
  const dependencyRoot=process.env.WATCHER_DEPENDENCY_ROOT;
  const {createRequire}=await import('node:module');const wasm=createRequire(path.join(dependencyRoot,'package.json'))('ergo-lib-wasm-nodejs');const secret=wasm.SecretKey.dlog_from_bytes(Buffer.from('01'.repeat(32),'hex')),address=secret.get_address().to_base58(wasm.NetworkPrefix.Testnet),WID='66'.repeat(32);
  const contract={address,tree:wasm.Address.from_base58(address).to_ergo_tree().to_base16_bytes()};const deployment={fundingAddress:address,tokens:{RWTRepoNFT:'77'.repeat(32),RWT:'88'.repeat(32),Asset:'99'.repeat(32),RepoConfigNFT:'aa'.repeat(32),CleanupNFT:'bb'.repeat(32)},contracts:{Permit:contract,Commitment:contract,EventTrigger:contract}};
  const runtime=await loadWatcherRuntime({dependencyRoot,deployment,watcher:{WID,secretKey:secret},nodePort:{},database:{}});const checker=new runtime.CommitmentReveal({}, {}, {}),commitment={WID,commitment:Buffer.from(runtime.ErgoUtils.commitmentFromObservation(observation,WID)).toString('hex'),rwtCount:'10'};
  assert.equal(checker.commitmentCheck([commitment],observation,10n).length,1);assert.equal(checker.commitmentCheck([{...commitment,commitment:'00'.repeat(32)}],observation,10n).length,0);assert.equal(checker.commitmentCheck([{...commitment,rwtCount:'11'}],observation,10n).length,0);assert.equal(checker.commitmentCheck([commitment],{...observation,amount:'101'},10n).length,0);
  const outputObservation={...observation,fromAddress:'rosen-monero-output:v1:'+'12'.repeat(32)};
  const outputCommitment={...commitment,commitment:Buffer.from(runtime.ErgoUtils.commitmentFromObservation(outputObservation,WID)).toString('hex')};
  assert.equal(checker.commitmentCheck([outputCommitment],outputObservation,10n).length,1);
  for(const fromAddress of ['legacy-vault-address','rosen-monero-output:v1:'+'13'.repeat(32)]){
    assert.equal(checker.commitmentCheck([outputCommitment],{...outputObservation,fromAddress},10n).length,0,'Rosen commitment binds the exact Monero output origin');
  }
  const widBox={box_id:()=>({to_str:()=>WID}),value:()=>({as_i64:()=>({to_str:()=> '20000000'})})};let creationCalls=0;
  const creator=new runtime.CommitmentCreation({allReadyObservations:async()=>[observation]}, {}, {getPermits:async()=>[],getWIDBox:async()=>[widBox]});creator.createCommitmentTx=async(wid,obs,digest)=>{assert.equal(wid,WID);assert.deepEqual(obs,observation);assert.equal(Buffer.from(digest).toString('hex'),commitment.commitment);creationCalls++;};await creator.job();assert.equal(creationCalls,1,'Actual creation job selects the independently admitted observation');
  const repo={register_value:()=>({to_i64:()=>({to_str:()=> '2'})})},config={register_value:()=>({to_js:()=>['10','0','1','1'],to_i64_str_array:()=>['10','0','1','1']})};let revealCalls=0;
  const reveal=new runtime.CommitmentReveal({allReadyCommitmentSets:async()=>[{observation,commitments:[commitment]}]}, {}, {getRepoBox:async()=>repo,getRepoConfigBox:async()=>config,getUserPaymentBox:async()=>[]});reveal.triggerEventCreationTx=async()=>{revealCalls++;};await reveal.job();assert.equal(revealCalls,0,'Actual reveal job rejects one commitment at exact threshold two');
});
test('actual pinned trigger extractor and guard comparison reject only a changed R5 origin',{skip:!process.env.WATCHER_DEPENDENCY_ROOT},async()=>{
  const dependencyRoot=process.env.WATCHER_DEPENDENCY_ROOT;
  const {createRequire,registerHooks}=await import('node:module'),{pathToFileURL}=await import('node:url');
  const require=createRequire(path.join(dependencyRoot,'package.json')),wasm=require('ergo-lib-wasm-nodejs');
  const secret=wasm.SecretKey.dlog_from_bytes(Buffer.from('01'.repeat(32),'hex')),address=secret.get_address().to_base58(wasm.NetworkPrefix.Testnet),WID='66'.repeat(32);
  const contract={address,tree:wasm.Address.from_base58(address).to_ergo_tree().to_base16_bytes()};
  const deployment={fundingAddress:address,tokens:{RWTRepoNFT:'77'.repeat(32),RWT:'88'.repeat(32),Asset:'99'.repeat(32),RepoConfigNFT:'aa'.repeat(32),CleanupNFT:'bb'.repeat(32)},contracts:{Permit:contract,Commitment:contract,EventTrigger:contract,Fraud:contract}};
  const runtime=await loadWatcherRuntime({dependencyRoot,deployment,watcher:{WID,secretKey:secret},nodePort:{},database:{}});
  const hooks=registerHooks({resolve(specifier,context,next){try{return next(specifier,context);}catch(error){for(const suffix of ['.js','/index.js']){try{return next(specifier+suffix,context);}catch{}}throw error;}}});
  let EventTriggerExtractor;
  try{({default:EventTriggerExtractor}=await import(pathToFileURL(path.join(dependencyRoot,'node_modules/@rosen-bridge/watcher-data-extractor/dist/extractor/eventTriggerExtractor.js'))));}finally{hooks.deregister();}
  const expected={...observation,fromAddress:'rosen-monero-output:v1:'+'12'.repeat(32)},changedOrigin='rosen-monero-output:v1:'+'13'.repeat(32),boxes=new runtime.Boxes({});
  const toBox=value=>wasm.ErgoBox.from_box_candidate(boxes.createTriggerEvent(1000000n,3,[WID,'67'.repeat(32)],value,10n),wasm.TxId.from_str('ab'.repeat(32)),0);
  const original=toBox(expected),mutated=toBox({...expected,fromAddress:changedOrigin});
  const r5=box=>box.register_value(5).to_coll_coll_byte().map(value=>Buffer.from(value).toString('hex')),originalR5=r5(original),mutatedR5=r5(mutated);
  assert.notEqual(mutatedR5[3],originalR5[3]);
  assert.deepEqual(mutatedR5.map((value,index)=>index===3?'<origin>':value),originalR5.map((value,index)=>index===3?'<origin>':value),'Only R5[3] changes');
  const extractor=new EventTriggerExtractor('test',{getRepository:()=>({})},'node','',address,deployment.tokens.RWT,address,address,undefined,false);
  const decode=box=>extractor.extractBoxData(JSON.parse(box.to_json())),decoded=decode(original),mutatedDecoded=decode(mutated);
  assert(decoded);assert(mutatedDecoded);assert.equal(decoded.fromAddress,expected.fromAddress);assert.equal(mutatedDecoded.fromAddress,changedOrigin);
  for(const field of ['sourceTxId','fromChain','toChain','toAddress','amount','bridgeFee','networkFee','sourceChainTokenId','targetChainTokenId','sourceBlockId','sourceChainHeight','eventId','WIDsCount','WIDsHash'])assert.deepEqual(mutatedDecoded[field],decoded[field],'Unexpected decoded change in '+field);
  const expectedEvent={...expected,requestId:Buffer.from(require('blakejs').blake2b(Buffer.from(expected.sourceTxId),undefined,32)).toString('hex')};
  verifyCreditEvent(decoded,expectedEvent);
  assert.throws(()=>verifyCreditEvent(mutatedDecoded,expectedEvent),/Trigger fromAddress/);
  // Exercise the shared guard predicate, not a test-local copy of its checks.
  for(const field of ['sourceTxId','fromChain','toChain','fromAddress','toAddress','amount','bridgeFee','networkFee','sourceChainTokenId','targetChainTokenId','sourceBlockId','sourceChainHeight','eventId','WIDsCount']){
    const value=decoded[field],changed={...decoded,[field]:typeof value==='number'?value+1:value+'x'};
    assert.throws(()=>verifyCreditEvent(changed,expectedEvent),new RegExp('Trigger '+field),field);
  }
  assert.throws(()=>verifyCreditEvent(undefined,expectedEvent),/Trigger event/);
});
