import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire,isBuiltin,registerHooks} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {canonicalAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {openWatcherCreditView} from './watcher-credit-view.mjs';

export const WATCHER_PIN='13b4c76ee7803bdf5f052e33cdc12b66acac2db0';
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const stringify=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
const hash=value=>crypto.createHash('sha256').update(stringify(value)).digest('hex');
const fields=['sourceTxId','fromChain','toChain','fromAddress','toAddress','amount','bridgeFee','networkFee','sourceChainTokenId','targetChainTokenId','sourceBlockId','height','requestId'];
let dependencyResolver;
function resolveDependencies(){
  if(dependencyResolver)return;
  dependencyResolver=registerHooks({resolve(specifier,context,next){try{return next(specifier,context);}catch(error){if(!specifier.startsWith('.'))throw error;for(const suffix of ['.js','/index.js']){try{return next(specifier+suffix,context);}catch{}}throw error;}}});
}
export function canonicalObservation(observation){
  const result={};for(const field of fields){assert.notEqual(observation[field],undefined,'Missing observation '+field);result[field]=observation[field];}
  for(const field of ['sourceTxId','sourceBlockId','requestId'])assert.match(result[field],/^[0-9a-f]{64}$/);
  for(const field of ['amount','bridgeFee','networkFee'])assert.match(result[field],/^(0|[1-9][0-9]*)$/);
  assert(Number.isSafeInteger(result.height)&&result.height>=0);return result;
}

/** Bounded host persistence, independent of the daemon's scanner database. */
export function openWatcherStore(filename){
  const db=new DatabaseSync(filename);db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY,rawHash TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,raw TEXT NOT NULL,backing TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS creditContinuity(guardKey TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS queue(stage TEXT PRIMARY KEY,requestId TEXT NOT NULL,txId TEXT NOT NULL UNIQUE,signedHex TEXT NOT NULL,signedJson TEXT NOT NULL,confirmed TEXT);
    CREATE TABLE IF NOT EXISTS receipts(requestId TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
  return {
    creditContinuity(rows){db.exec('BEGIN IMMEDIATE');try{for(const row of rows){const previous=db.prepare('SELECT payload FROM creditContinuity WHERE guardKey=?').get(row.guardKey);if(previous){const old=JSON.parse(previous.payload);assert.deepEqual(row.identity,old.identity,'Watcher credit identity drift');assert.equal(row.checkpoint.configDigest,old.checkpoint.configDigest,'Watcher credit config drift');assert(row.checkpoint.revision>=old.checkpoint.revision,'Watcher credit revision regressed');if(row.checkpoint.revision===old.checkpoint.revision)assert.equal(row.checkpoint.stateDigest,old.checkpoint.stateDigest,'Watcher credit state drift');}db.prepare('INSERT OR REPLACE INTO creditContinuity VALUES(?,?)').run(row.guardKey,stringify(row));}db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}},
    source(requestId,raw,backing){const previous=db.prepare('SELECT raw,backing FROM sources WHERE id=?').get(requestId);if(raw!==undefined){const next={raw:canonicalAssignment(raw),backing:canonicalAssignment(backing)};if(previous)assert.deepEqual({...previous},next,'Watcher retained source drift');else db.prepare('INSERT INTO sources VALUES(?,?,?)').run(requestId,next.raw,next.backing);}const row=previous??db.prepare('SELECT raw,backing FROM sources WHERE id=?').get(requestId);return row?{raw:JSON.parse(row.raw),backing:JSON.parse(row.backing)}:undefined;},
    observe(raw,observation){const canonical=canonicalObservation(observation),payload=stringify(canonical),rawHash=hash(raw),row=db.prepare('SELECT * FROM observations WHERE id=?').get(canonical.requestId);if(row){assert.equal(row.rawHash,rawHash,'Conflicting watcher request');assert.equal(row.payload,payload,'Conflicting watcher observation');}else db.prepare('INSERT INTO observations VALUES(?,?,?)').run(canonical.requestId,rawHash,payload);return canonical;},
    observation(requestId){const row=db.prepare('SELECT payload FROM observations WHERE id=?').get(requestId);return row?JSON.parse(row.payload):undefined;},
    queue(stage,requestId,tx){const row=this.readQueue(stage);const record={stage,requestId,txId:tx.id().to_str(),signedHex:Buffer.from(tx.sigma_serialize_bytes()).toString('hex'),signedJson:tx.to_json()};if(row){for(const field of ['requestId','txId','signedHex','signedJson'])assert.equal(row[field],record[field],'Queued transaction drift');}else db.prepare('INSERT INTO queue(stage,requestId,txId,signedHex,signedJson) VALUES(?,?,?,?,?)').run(...Object.values(record));return this.readQueue(stage);},
    readQueue(stage){return db.prepare('SELECT * FROM queue WHERE stage=?').get(stage);},
    confirmedOutputs(){return db.prepare('SELECT confirmed FROM queue WHERE confirmed IS NOT NULL').all().flatMap(row=>JSON.parse(row.confirmed).outputs);},
    confirm(stage,receipt){db.prepare('UPDATE queue SET confirmed=? WHERE stage=?').run(stringify(receipt),stage);},
    receipt(requestId,value){if(value!==undefined){const payload=stringify(value),prior=this.receipt(requestId);if(prior)assert.equal(stringify(prior),payload,'Receipt drift');else db.prepare('INSERT INTO receipts VALUES(?,?)').run(requestId,payload);}const row=db.prepare('SELECT payload FROM receipts WHERE requestId=?').get(requestId);return row?JSON.parse(row.payload):undefined;},
    close(){db.close();}
  };
}

/** Loads the reviewed transaction closure; config, local-node and store ports are explicit. */
export async function loadWatcherRuntime({dependencyRoot,deployment,watcher,nodePort,database}){
  resolveDependencies();
  const require=createRequire(path.join(dependencyRoot,'package.json')),ts=require('typescript'),wasm=require('ergo-lib-wasm-nodejs');
  const {DefaultLogger,DummyLogger}=await import(pathToFileURL(require.resolve('@rosen-bridge/abstract-logger')));const warnings=[],logger=new DummyLogger();logger.warn=message=>warnings.push(String(message));DefaultLogger.init(logger);
  const {TokenMap}=await import(pathToFileURL(require.resolve('@rosen-bridge/tokens')));const tokenMap=new TokenMap();
  await tokenMap.updateConfigByJson([{ergo:{tokenId:deployment.tokens.RWT,name:'Local RWT',decimals:0,type:'EIP-004',residency:'native',extra:{}}}]);
  const c=deployment.contracts,t=deployment.tokens,secret=typeof watcher.secretKey==='string'?wasm.SecretKey.dlog_from_bytes(Buffer.from(watcher.secretKey,'hex')):watcher.secretKey;
  const config={general:{minBoxValue:'1000000',fee:'1100000',address:secret.get_address().to_base58(wasm.NetworkPrefix.Testnet),secretKey:secret,versionInputExtension:false},rosen:{rwtRepoNFT:t.RWTRepoNFT,RWTId:t.RWT,RSN:t.Asset,AWC:watcher.WID,repoConfigNFT:t.RepoConfigNFT,watcherPermitAddress:c.Permit.address,commitmentAddress:c.Commitment.address,RWTRepoAddress:deployment.fundingAddress,watcherCollateralAddress:deployment.fundingAddress,repoConfigAddress:deployment.fundingAddress,emissionAddress:deployment.fundingAddress,emissionNFT:t.CleanupNFT,eventTriggerAddress:c.EventTrigger.address}};
  const box=json=>wasm.ErgoBox.from_json(stringify(json));
  const network={getMaxHeight:async inputs=>Math.max((await nodePort.rpc('/info')).fullHeight,...inputs.map(b=>b.creation_height())),getErgoStateContext:()=>nodePort.getStateContext(),unspentErgoBoxById:async id=>box(await nodePort.rpc('/utxo/byId/'+id)),trackMemPool:async b=>box(await nodePort.rpc('/utxo/byId/'+b.box_id().to_str())),getBoxWithToken:async(_address,id)=>{const candidate=id===t.RepoConfigNFT?deployment.repoConfigBox:deployment.RWTRepoBox;assert(candidate,'Missing repository data box');return box(await nodePort.rpc('/utxo/byId/'+candidate.boxId));}};
  const ports={'src/config/config':{getConfig:()=>config},'src/ergo/network/ergoNetwork':{ErgoNetwork:network},'src/config/tokensConfig':{TokensConfig:{getInstance:()=>({getTokenMap:()=>tokenMap})}},'src/api/Transaction':{Transaction:{watcherWID:watcher.WID}},'src/init':{watcherDatabase:database},'src/database/entities/txEntity':{TxType:{COMMITMENT:'commitment',TRIGGER:'trigger'}},'package.json':{default:{version:'6.3.2'}}};
  const names=['src/ergo/boxes.ts','src/ergo/utils.ts','src/utils/utils.ts','src/config/constants.ts','src/errors/errors.ts','src/transactions/commitmentCreation.ts','src/transactions/commitmentReveal.ts'];
  const modules=new Map();
  function synthetic(key,exports){if(!modules.has(key))modules.set(key,new vm.SyntheticModule(Object.keys(exports),function(){for(const [n,v]of Object.entries(exports))this.setExport(n,v);},{identifier:key}));return modules.get(key);}
  function source(name){if(!modules.has(name))modules.set(name,new vm.SourceTextModule(ts.transpileModule(fs.readFileSync(path.join(sourceRoot,'watcher',name),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace("assert { type: 'json' }","with { type: 'json' }"),{identifier:name}));return modules.get(name);}
  async function linker(specifier,ref){if(!specifier.startsWith('.'))return synthetic(specifier,await import(isBuiltin(specifier)?specifier:pathToFileURL(require.resolve(specifier))));const key=path.posix.normalize(path.posix.join(path.posix.dirname(ref.identifier),specifier));if(names.includes(key+'.ts'))return source(key+'.ts');assert(ports[key],'Unprovided runtime port '+key);return synthetic(key,ports[key]);}
  // Linking one root first freezes the shared cycle before evaluating the others.
  for(const name of ['src/ergo/boxes.ts','src/transactions/commitmentCreation.ts','src/transactions/commitmentReveal.ts']){const m=source(name);if(m.status==='unlinked')await m.link(linker);if(m.status==='linked')await m.evaluate();}
  return {wasm,warnings,requestId:txId=>Buffer.from(require('blakejs').blake2b(Buffer.from(txId),undefined,32)).toString('hex'),Boxes:source('src/ergo/boxes.ts').namespace.Boxes,ErgoUtils:source('src/ergo/utils.ts').namespace.ErgoUtils,CommitmentCreation:source('src/transactions/commitmentCreation.ts').namespace.CommitmentCreation,CommitmentReveal:source('src/transactions/commitmentReveal.ts').namespace.CommitmentReveal};
}

/** Runs actual pinned commitment/reveal jobs against confirmed local-node spends. */
export async function createWatcherTransport({directory,deployment,nodePort,observe,dependencyRoot}){
  assert(path.isAbsolute(directory));assert(path.isAbsolute(dependencyRoot));assert.equal(deployment.watchers.length,2);assert.equal(new Set(deployment.watchers.map(w=>w.WID)).size,2,'Distinct watcher identities required');
  for(const capability of ['rpc','confirmed','getStateContext'])assert.equal(typeof nodePort[capability],'function');assert.equal(typeof observe,'function');
  fs.mkdirSync(directory,{recursive:true});const stores=deployment.watchers.map((_,i)=>openWatcherStore(path.join(directory,'watcher-'+i+'.sqlite')));
  const runtimes=[],databases=[];
  for(let i=0;i<2;i++){
    const watcher=deployment.watchers[i];let closure;
    const serialized=json=>Buffer.from(closure.wasm.ErgoBox.from_json(stringify(json)).sigma_serialize_bytes()).toString('base64');
    async function knownUnspent(predicate){const known=[...watcher.permitBoxes,watcher.WIDBox,...(watcher.feeBoxes||[]),...stores[i].confirmedOutputs()],unique=new Map(known.filter(predicate).map(b=>[b.boxId,b]));const live=[];for(const id of unique.keys()){try{live.push(await nodePort.rpc('/utxo/byId/'+id));}catch(e){if(!String(e).includes('404'))throw e;}}return live;}
    const database={getUnspentPermitBoxes:async WID=>{assert.equal(WID,watcher.WID);return (await knownUnspent(b=>b.ergoTree===deployment.contracts.Permit.tree)).filter(b=>Buffer.from(closure.wasm.ErgoBox.from_json(stringify(b)).register_value(4).to_byte_array()).toString('hex')===WID).map(b=>({boxSerialized:serialized(b)}));},getUnspentAddressBoxes:async()=>{const secret=typeof watcher.secretKey==='string'?closure.wasm.SecretKey.dlog_from_bytes(Buffer.from(watcher.secretKey,'hex')):watcher.secretKey;const addressTree=secret.get_address().to_ergo_tree().to_base16_bytes();return (await knownUnspent(b=>b.ergoTree===addressTree)).map(b=>({serialized:serialized(b)}));},trackTxQueue:async b=>b};
    closure=await loadWatcherRuntime({dependencyRoot,deployment,watcher,nodePort,database});runtimes.push(closure);databases.push(database);
  }
  async function reconcile(store,stage){const queued=store.readQueue(stage);assert(queued,'Missing signed transaction queue');if(queued.confirmed)return JSON.parse(queued.confirmed);
    let receipt;try{receipt=await nodePort.rpc('/blockchain/transaction/byId/'+queued.txId);}catch(e){if(!String(e).includes('404'))throw e;}
    if(!receipt){const id=await nodePort.rpc('/transactions',JSON.parse(queued.signedJson));assert.equal(id,queued.txId,'Node transaction ID mismatch');}
    receipt=await nodePort.confirmed(queued.txId);assert.equal(receipt.id,queued.txId);assert(receipt.numConfirmations>0,'Unconfirmed watcher spend');store.confirm(stage,receipt);return receipt;
  }
  return {close(){stores.forEach(s=>s.close());},async publish(rawRequest){
    const observations=[];for(let i=0;i<2;i++){const proposal=await observe(i,structuredClone(rawRequest));assert(!proposal.fromAddress?.startsWith('rosen-monero-output:v2:'),'V2 deposits require watcher participants with credit custody');observations.push(stores[i].observe(rawRequest,proposal));}assert.deepEqual(observations[0],observations[1],'Independent watcher observations disagree');const observation=observations[0],requestId=observation.requestId;
    const prior=stores[0].receipt(requestId);if(prior)return prior;
    const commitments=[],commitmentTransactions=[];
    for(let i=0;i<2;i++){
      const runtime=runtimes[i],watcher=deployment.watchers[i],store=stores[i],stage='commitment:'+requestId;
      assert.equal(observation.requestId,runtime.requestId(observation.sourceTxId),'Watcher request ID must match contract event ID');
      if(!store.readQueue(stage)){
        const txUtils={submitTransaction:async(tx,type)=>{assert.equal(type,'commitment');store.queue(stage,requestId,tx);await reconcile(store,stage);}};
        const creator=new runtime.CommitmentCreation({allReadyObservations:async()=>[observation]},txUtils,new runtime.Boxes(databases[i]));
        await creator.job();assert(store.readQueue(stage),'Pinned commitment job failed before queue creation: '+runtime.warnings.at(-1));
      }
      const receipt=await reconcile(store,stage),output=receipt.outputs.find(b=>b.ergoTree===deployment.contracts.Commitment.tree);assert(output,'No actual commitment output');
      const box=runtime.wasm.ErgoBox.from_json(stringify(output));assert.equal(Buffer.from(box.register_value(4).to_byte_array()).toString('hex'),watcher.WID);assert.equal(Buffer.from(box.register_value(5).to_byte_array()).toString('hex'),requestId);
      commitments.push({WID:watcher.WID,boxId:output.boxId,commitment:Buffer.from(box.register_value(6).to_byte_array()).toString('hex'),rwtCount:box.tokens().get(0).amount().as_i64().to_str(),requestId});commitmentTransactions.push(receipt);
    }
    const runtime=runtimes[0],store=stores[0],stage='trigger:'+requestId;
    if(!store.readQueue(stage)){
      const boxes=new runtime.Boxes(databases[0]);
      const reveal=new runtime.CommitmentReveal({allReadyCommitmentSets:async()=>[{observation,commitments}]},{submitTransaction:async(tx,type)=>{assert.equal(type,'trigger');store.queue(stage,requestId,tx);await reconcile(store,stage);}},boxes);
      assert.equal(runtime.ErgoUtils.requiredCommitmentCount(await liveBox(runtime,deployment.RWTRepoBox),await liveBox(runtime,deployment.repoConfigBox)),2n,'Exact two-watcher readiness threshold required');await reveal.job();assert(store.readQueue(stage),'Pinned reveal job failed before queue creation: '+runtime.warnings.at(-1));
    }
    const transaction=await reconcile(store,stage),trigger=transaction.outputs.find(b=>b.ergoTree===deployment.contracts.EventTrigger.tree);assert(trigger,'No confirmed event trigger');assert(commitments.every(c=>transaction.inputs.some(b=>b.boxId===c.boxId)),'Trigger did not spend both commitments');
    const receipt={watcherPin:WATCHER_PIN,observation,watcherObservations:observations,commitments,commitmentTransactions,trigger,transaction};for(const s of stores)s.receipt(requestId,receipt);return receipt;
  }};
  async function liveBox(runtime,json){return runtime.wasm.ErgoBox.from_json(stringify(await nodePort.rpc('/utxo/byId/'+json.boxId)));}
}

/** One watcher-owned pinned job runner. Its caller may be a separate process. */
export async function createWatcherParticipant({databasePath,deployment,watcher,nodePort,inspect,dependencyRoot,creditEntries,pause=async()=>{}}){
  assert(path.isAbsolute(databasePath));assert.equal(typeof inspect,'function');
  const store=openWatcherStore(databasePath);let closure,live=true;const current=()=>assert(live,'Closed watcher participant');
  let credit;
  try{credit=openWatcherCreditView({entries:creditEntries,committeeKeys:deployment.guardPublicKeys,remember:rows=>store.creditContinuity(rows)});}
  catch(error){store.close();throw error;}
  function assertBacking(observation,backing){
    const origin=crypto.createHash('sha256').update('rosen-monero/credit-origin/v2').update('\0').update(canonicalAssignment(backing)).digest('hex');
    assert.equal(observation.fromAddress,'rosen-monero-output:v2:'+origin,'Watcher backing commitment drift');
    assert.equal(observation.sourceTxId,backing.txId);assert.equal(observation.sourceBlockId,backing.blockHash);assert.equal(observation.height,backing.blockHeight);
    assert.equal(observation.requestId,closure.requestId(backing.txId),'Watcher request binding');
  }
  function retained(requestId){const source=store.source(requestId),observation=store.observation(requestId);assert(source&&observation,'Missing retained watcher source');assertBacking(observation,source.backing);return {source,observation};}
  function assertNew(requestId){current();credit.assertNew(retained(requestId).source.backing);}
  const serialized=json=>Buffer.from(closure.wasm.ErgoBox.from_json(stringify(json)).sigma_serialize_bytes()).toString('base64');
  async function knownUnspent(predicate){const known=[...watcher.permitBoxes,watcher.WIDBox,...(watcher.feeBoxes||[]),...store.confirmedOutputs()],unique=new Map(known.filter(predicate).map(b=>[b.boxId,b]));const live=[];for(const id of unique.keys()){try{live.push(await nodePort.rpc('/utxo/byId/'+id));}catch(e){if(!String(e).includes('404'))throw e;}}return live;}
  const database={getUnspentPermitBoxes:async WID=>{assert.equal(WID,watcher.WID);return (await knownUnspent(b=>b.ergoTree===deployment.contracts.Permit.tree)).filter(b=>Buffer.from(closure.wasm.ErgoBox.from_json(stringify(b)).register_value(4).to_byte_array()).toString('hex')===WID).map(b=>({boxSerialized:serialized(b)}));},getUnspentAddressBoxes:async()=>{const secret=typeof watcher.secretKey==='string'?closure.wasm.SecretKey.dlog_from_bytes(Buffer.from(watcher.secretKey,'hex')):watcher.secretKey;const addressTree=secret.get_address().to_ergo_tree().to_base16_bytes();return (await knownUnspent(b=>b.ergoTree===addressTree)).map(b=>({serialized:serialized(b)}));},trackTxQueue:async b=>b};
  try{closure=await loadWatcherRuntime({dependencyRoot,deployment,watcher,nodePort,database});}
  catch(error){credit.close();store.close();throw error;}
  async function reconcile(stage,checkpoint,confirmationCheckpoint=checkpoint+':before-confirmation'){current();const queued=store.readQueue(stage);assert(queued,'Missing signed transaction queue');if(queued.confirmed)return JSON.parse(queued.confirmed);let receipt;try{receipt=await nodePort.rpc('/blockchain/transaction/byId/'+queued.txId);}catch(e){if(!String(e).includes('404'))throw e;}if(!receipt){await pause(checkpoint);assertNew(queued.requestId);const id=await nodePort.rpc('/transactions',JSON.parse(queued.signedJson));assert.equal(id,queued.txId,'Node transaction ID mismatch');}await pause(confirmationCheckpoint);receipt=await nodePort.confirmed(queued.txId);assert.equal(receipt.id,queued.txId);assert(receipt.numConfirmations>0,'Unconfirmed watcher spend');current();store.confirm(stage,receipt);return receipt;}
  async function observe(rawRequest){current();const admitted=await inspect(structuredClone(rawRequest));assert.equal(admitted.status,'accepted','Independent watcher source was not accepted');const observation=structuredClone(admitted.observation);assert.equal(observation.rawData,'');delete observation.rawData;observation.height=admitted.backing.blockHeight;assertBacking(observation,admitted.backing);credit.assertNew(admitted.backing);current();const result=store.observe(rawRequest,observation);store.source(result.requestId,rawRequest,admitted.backing);return result;}
  async function commitment(rawRequest){
    const observation=await observe(rawRequest),requestId=observation.requestId,stage='commitment:'+requestId;
    if(!store.readQueue(stage)){
      const txUtils={submitTransaction:async(tx,type)=>{assert.equal(type,'commitment');assertNew(requestId);store.queue(stage,requestId,tx);await reconcile(stage,'beforeCommitmentBroadcast');}};
      const creator=new closure.CommitmentCreation({allReadyObservations:async()=>[observation]},txUtils,new closure.Boxes(database));
      await creator.job();assert(store.readQueue(stage),'Pinned commitment job failed before queue creation: '+closure.warnings.at(-1));
    }
    const receipt=await reconcile(stage,'beforeCommitmentBroadcast'),output=receipt.outputs.find(b=>b.ergoTree===deployment.contracts.Commitment.tree);assert(output,'No actual commitment output');
    const box=closure.wasm.ErgoBox.from_json(stringify(output));assert.equal(Buffer.from(box.register_value(4).to_byte_array()).toString('hex'),watcher.WID);assert.equal(Buffer.from(box.register_value(5).to_byte_array()).toString('hex'),requestId);
    return {observation,commitment:{WID:watcher.WID,boxId:output.boxId,commitment:Buffer.from(box.register_value(6).to_byte_array()).toString('hex'),rwtCount:box.tokens().get(0).amount().as_i64().to_str(),requestId},transaction:receipt};
  }
  async function receipt(requestId,value){
    current();const saved=store.receipt(requestId);if(value===undefined&&!saved)return undefined;
    value=structuredClone(value??saved);const {observation}=retained(requestId);
    assert.deepEqual(value.observation,observation,'Watcher recovered observation drift');assert.equal(value.watcherPin,WATCHER_PIN);
    assert.equal(value.commitments.length,2);assert.deepEqual(value.commitments.map(c=>c.WID),deployment.watchers.map(w=>w.WID));
    assert.equal(new Set(value.commitments.map(c=>c.boxId)).size,2);assert(value.commitments.every(c=>c.requestId===requestId));
    const own=store.readQueue('commitment:'+requestId);assert(own?.confirmed,'Missing confirmed own commitment');
    const selected=value.commitments.find(c=>c.WID===watcher.WID);assert(JSON.parse(own.confirmed).outputs.some(b=>b.boxId===selected.boxId),'Recovered commitment drift');
    const chainReceipt=await nodePort.confirmed(value.transaction.id);current();assert.equal(chainReceipt.id,value.transaction.id);assert(chainReceipt.numConfirmations>0);
    assert.deepEqual(value.transaction.inputs,chainReceipt.inputs,'Recovered transaction inputs drift');
    // The indexer adds spend metadata after credit consumes the trigger. Compare
    // consensus box bytes and IDs, not the mutable JSON presentation of a box.
    const boxBytes=json=>{const box=closure.wasm.ErgoBox.from_json(stringify(json));assert.equal(box.box_id().to_str(),json.boxId,'Recovered transaction outputs drift');return Buffer.from(box.sigma_serialize_bytes()).toString('hex');};
    assert.deepEqual(value.transaction.outputs.map(boxBytes),chainReceipt.outputs.map(boxBytes),'Recovered transaction outputs drift');
    assert(chainReceipt.inputs.some(b=>b.boxId===selected.boxId),'Recovered trigger did not spend own commitment');
    const trigger=chainReceipt.outputs.find(b=>b.ergoTree===deployment.contracts.EventTrigger.tree);assert(trigger,'Missing confirmed recovered trigger');
    assert.equal(boxBytes(trigger),boxBytes(value.trigger),'Recovered trigger drift');assert(value.transaction.outputs.some(b=>b.boxId===trigger.boxId));
    // The decoded event must still match the complete independently retained source.
    const box=closure.wasm.ErgoBox.from_json(stringify(trigger));
    const candidate=new closure.Boxes(database).createTriggerEvent(1000000n,observation.height,deployment.watchers.map(w=>w.WID),observation,10n);
    const expectedBox=closure.wasm.ErgoBox.from_box_candidate(candidate,closure.wasm.TxId.from_str('00'.repeat(32)),0);
    for(const register of [4,5,6,7])assert.equal(box.register_value(register).encode_to_base16(),expectedBox.register_value(register).encode_to_base16(),'Recovered event drift');
    if(saved)assert.deepEqual(value,saved,'Receipt drift');return store.receipt(requestId,value);
  }
  async function recover(rawRequest){
    current();const requestId=closure.requestId(rawRequest.txId);const saved=store.receipt(requestId);if(!saved)return null;
    assert.equal(canonicalAssignment(rawRequest),canonicalAssignment(retained(requestId).source.raw),'Watcher recovery request drift');
    return {receipt:await receipt(requestId),commitmentTransaction:JSON.parse(store.readQueue('commitment:'+requestId).confirmed)};
  }
  async function reveal(requestId,commitments){
    assert.match(requestId,/^[0-9a-f]{64}$/);assert.equal(commitments.length,2);
    const expected=deployment.watchers?.map(value=>value.WID)??[];assert.equal(expected.length,2,'Two public watcher identities required');assert.equal(new Set(expected).size,2);
    assert.deepEqual(commitments.map(value=>value.WID),expected,'Unexpected watcher commitments');assert.equal(new Set(commitments.map(value=>value.boxId)).size,2,'Distinct commitment boxes required');assert(commitments.every(value=>value.requestId===requestId),'Commitment request mismatch');
    const prior=store.receipt(requestId);if(prior){assert.deepEqual(commitments,prior.commitments,'Recovered commitments drift');return receipt(requestId);}
    const {observation}=retained(requestId),stage='trigger:'+requestId;
    if(!store.readQueue(stage)){
      assertNew(requestId);
      const boxes=new closure.Boxes(database),revealJob=new closure.CommitmentReveal({allReadyCommitmentSets:async()=>[{observation,commitments}]},{submitTransaction:async(tx,type)=>{assert.equal(type,'trigger');assertNew(requestId);store.queue(stage,requestId,tx);await reconcile(stage,'beforeRevealBroadcast','beforeRevealConfirmation');}},boxes);
      const live=async json=>closure.wasm.ErgoBox.from_json(stringify(await nodePort.rpc('/utxo/byId/'+json.boxId)));assert.equal(closure.ErgoUtils.requiredCommitmentCount(await live(deployment.RWTRepoBox),await live(deployment.repoConfigBox)),2n,'Exact two-watcher readiness threshold required');
      await revealJob.job();assert(store.readQueue(stage),'Pinned reveal job failed before queue creation: '+closure.warnings.at(-1));
    }
    const transaction=await reconcile(stage,'beforeRevealBroadcast','beforeRevealConfirmation'),trigger=transaction.outputs.find(b=>b.ergoTree===deployment.contracts.EventTrigger.tree);assert(trigger,'No confirmed event trigger');assert(commitments.every(c=>transaction.inputs.some(b=>b.boxId===c.boxId)),'Trigger did not spend both commitments');
    return receipt(requestId,{watcherPin:WATCHER_PIN,observation,commitments,trigger,transaction});
  }
  return {observe,commitment,reveal,receipt,recover,close(){if(live){live=false;credit.close();store.close();}}};
}
