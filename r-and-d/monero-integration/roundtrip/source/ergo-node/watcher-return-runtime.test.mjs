import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createWatcherParticipant,openWatcherStore,loadWatcherRuntime,WATCHER_PIN} from './watcher-runtime.mjs';

const enabled={skip:!process.env.WATCHER_DEPENDENCY_ROOT};
const h=n=>n.toString(16).padStart(2,'0').repeat(32);
const fakeTransaction=id=>({id:()=>({to_str:()=>id}),sigma_serialize_bytes:()=>Buffer.from(id,'hex'),to_json:()=>JSON.stringify({id})});
async function fixture(t,{pause=async()=>{}}={}){
  const dependencyRoot=process.env.WATCHER_DEPENDENCY_ROOT,require=createRequire(join(dependencyRoot,'package.json')),wasm=require('ergo-lib-wasm-nodejs');
  const directory=mkdtempSync(join(tmpdir(),'watcher-runtime-return-')),databasePath=join(directory,'watcher.sqlite'),actors=[];
  t.after(()=>actors.reverse().forEach(actor=>actor.close()));
  const secret=wasm.SecretKey.dlog_from_bytes(Buffer.from(h(1),'hex')),address=secret.get_address().to_base58(wasm.NetworkPrefix.Testnet);
  const contract={address,tree:secret.get_address().to_ergo_tree().to_base16_bytes()},watcher={WID:h(60),secretKey:secret,permitBoxes:[],feeBoxes:[]};
  const deployment={watchers:[{WID:watcher.WID},{WID:h(61)}],fundingAddress:address,
    tokens:{RWTRepoNFT:h(62),RWT:h(63),Asset:h(9),RepoConfigNFT:h(64),CleanupNFT:h(65)},
    contracts:{Permit:contract,Commitment:contract,EventTrigger:contract},RWTRepoBox:{boxId:h(66)},repoConfigBox:{boxId:h(67)}};
  const raw={txId:h(5),signedHex:'aabb',status:'confirmed'},requestId=Buffer.from(require('blakejs').blake2b(Buffer.from(raw.txId),undefined,32)).toString('hex');
  const observation={sourceTxId:raw.txId,fromChain:'ergo',toChain:'monero',fromAddress:address,toAddress:'monero-recipient',amount:'1000',
    bridgeFee:'50',networkFee:'50',sourceChainTokenId:h(9),targetChainTokenId:'XMR',sourceBlockId:h(6),height:10,requestId};
  const calls={submits:0,confirmations:0,sourceReads:0,rpc:[]},state={patch:{},beforeRead:async()=>{},fail:false},responses=new Map();
  const observeReturn=async value=>{calls.sourceReads++;assert.deepEqual(value,{txId:h(5),signedHex:'aabb',status:'confirmed'});
    await state.beforeRead();if(state.fail)throw Error('return source unavailable');return {...observation,...state.patch};};
  const nodePort={async rpc(route,payload){calls.rpc.push(route);if(route==='/transactions'){calls.submits++;return payload.id;}
    if(route.startsWith('/blockchain/transaction/byId/'))throw Error('404');throw Error('Unexpected node access: '+route);},
    async confirmed(id){calls.confirmations++;assert(responses.has(id),'Missing receipt');return responses.get(id);},async getStateContext(){throw Error('Unexpected signing');}};
  const args={databasePath,deployment,watcher,nodePort,observeReturn,dependencyRoot,pause};
  const open=async()=>{const actor=await createWatcherParticipant(args);actors.push(actor);return actor;},actor=await open();
  const withStore=fn=>{const store=openWatcherStore(databasePath);try{return fn(store);}finally{store.close();}};
  const queue=(stage,id=h(70))=>withStore(store=>store.queue(stage+':'+requestId,requestId,fakeTransaction(id)));
  const commitments=deployment.watchers.map((w,i)=>({WID:w.WID,boxId:h(80+i),requestId,commitment:h(82+i),rwtCount:'10'}));
  return {actor,open,args,raw,observation,requestId,calls,state,responses,queue,withStore,commitments,wasm};
}

test('return watcher stores exact raw receipt and canonical observation without credit custody',enabled,async t=>{
  const f=await fixture(t);assert.deepEqual(await f.actor.observe(f.raw),f.observation);
  assert.deepEqual(f.withStore(s=>s.source(f.requestId)).raw,f.raw);
  assert.deepEqual(f.withStore(s=>s.observation(f.requestId)),f.observation);assert.equal(f.calls.sourceReads,1);
  assert.equal(f.calls.submits,0);assert.deepEqual(f.calls.rpc,[]);
});

test('return source mode refuses mixed deposit ports',enabled,async t=>{
  const f=await fixture(t);
  for(const extra of [{inspect:async()=>{}},{creditEntries:[]},{observeReturn:null}])
    await assert.rejects(()=>createWatcherParticipant({...f.args,...extra}),/Watcher source mode/);
  const absent={...f.args};delete absent.observeReturn;await assert.rejects(()=>createWatcherParticipant(absent),/Watcher source mode/);
});

for(const [field,value] of [['fromAddress','rosen-monero-output:v2:'+h(90)],['fromChain','monero'],['toChain','ergo'],
  ['sourceTxId',h(90)],['requestId',h(90)]])test('return watcher refuses incompatible '+field,enabled,async t=>{
  const f=await fixture(t);f.state.patch[field]=value;await assert.rejects(()=>f.actor.observe(f.raw),/Watcher return/);
  assert.equal(f.withStore(s=>s.observation(f.requestId)),undefined);assert.equal(f.calls.submits,0);
});

test('return observation snapshots the raw request across asynchronous verification',enabled,async t=>{
  const f=await fixture(t),expected=structuredClone(f.raw);f.state.beforeRead=async()=>{f.raw.signedHex='changed';};
  await f.actor.observe(f.raw);assert.deepEqual(f.withStore(s=>s.source(f.requestId)).raw,expected);
});

test('changed return evidence after observation prevents reveal before queue creation',enabled,async t=>{
  const f=await fixture(t);await f.actor.observe(f.raw);f.state.patch.amount='1001';
  await assert.rejects(()=>f.actor.reveal(f.requestId,f.commitments),/Watcher return observation drift/);
  assert.equal(f.withStore(s=>s.readQueue('trigger:'+f.requestId)),undefined);assert.deepEqual(f.calls.rpc,[]);
});

for(const stage of ['commitment','trigger'])test('return '+stage+' broadcast awaits fresh source and refuses pause-time changes',enabled,async t=>{
  let f,paused=0;f=await fixture(t,{pause:async checkpoint=>{if(checkpoint===(stage==='commitment'?'beforeCommitmentBroadcast':'beforeRevealBroadcast')){
    paused++;f.state.beforeRead=async()=>{await new Promise(resolve=>setImmediate(resolve));f.state.patch.sourceBlockId=h(90);};}}});
  await f.actor.observe(f.raw);f.queue(stage);
  await assert.rejects(()=>stage==='commitment'?f.actor.commitment(f.raw):f.actor.reveal(f.requestId,f.commitments),/Watcher return observation drift/);
  assert.equal(paused,1);assert.equal(f.calls.submits,0);assert.equal(f.calls.confirmations,0);
  assert.equal(f.withStore(s=>s.readQueue(stage+':'+f.requestId)).confirmed,null);
});

test('reopened return queue revalidates the retained source before any broadcast',enabled,async t=>{
  const f=await fixture(t);await f.actor.observe(f.raw);f.queue('trigger');f.actor.close();f.state.fail=true;
  const reopened=await f.open();await assert.rejects(()=>reopened.reveal(f.requestId,f.commitments),/return source unavailable/);
  assert.equal(f.calls.submits,0);assert.equal(f.withStore(s=>s.readQueue('trigger:'+f.requestId)).confirmed,null);
});

test('return queue submits exact retained commitment once through the existing runtime',enabled,async t=>{
  const f=await fixture(t);await f.actor.observe(f.raw);const queued=f.queue('commitment');
  const runtime=await loadWatcherRuntime({...f.args,database:{}}),boxes=new runtime.Boxes({});
  const candidate=boxes.createCommitment(10,10n,f.args.watcher.WID,f.requestId,Buffer.from(h(85),'hex'),Buffer.from(h(86),'hex'));
  const output=JSON.parse(f.wasm.ErgoBox.from_box_candidate(candidate,f.wasm.TxId.from_str(queued.txId),0).to_json());
  f.responses.set(queued.txId,{id:queued.txId,numConfirmations:1,outputs:[output]});
  assert.equal((await f.actor.commitment(f.raw)).commitment.boxId,output.boxId);assert(f.calls.sourceReads>=3);
  await f.actor.commitment(f.raw);assert.equal(f.calls.submits,1);assert.equal(f.calls.confirmations,1);
});

test('confirmed return receipt recovers exact retained source after restart without a new submission',enabled,async t=>{
  const f=await fixture(t);await f.actor.observe(f.raw);const queued=f.queue('commitment');
  const runtime=await loadWatcherRuntime({...f.args,database:{}}),boxes=new runtime.Boxes({});
  const commitment=boxes.createCommitment(10,10n,f.args.watcher.WID,f.requestId,Buffer.from(h(85),'hex'),Buffer.from(h(86),'hex'));
  const ownOutput=JSON.parse(f.wasm.ErgoBox.from_box_candidate(commitment,f.wasm.TxId.from_str(queued.txId),0).to_json());
  f.commitments[0].boxId=ownOutput.boxId;const ownTransaction={id:queued.txId,numConfirmations:1,outputs:[ownOutput]};
  f.withStore(s=>s.confirm('commitment:'+f.requestId,ownTransaction));
  const triggerCandidate=boxes.createTriggerEvent(1000000n,f.observation.height,f.args.deployment.watchers.map(w=>w.WID),f.observation,10n);
  const trigger=JSON.parse(f.wasm.ErgoBox.from_box_candidate(triggerCandidate,f.wasm.TxId.from_str(h(90)),0).to_json());
  const transaction={id:h(90),numConfirmations:1,inputs:f.commitments.map(c=>({boxId:c.boxId})),outputs:[trigger]};
  f.responses.set(transaction.id,transaction);const receipt={watcherPin:WATCHER_PIN,observation:f.observation,commitments:f.commitments,trigger,transaction};
  await f.actor.receipt(f.requestId,receipt);f.actor.close();const reopened=await f.open(),reads=f.calls.sourceReads;
  assert.deepEqual(await reopened.recover(f.raw),{receipt,commitmentTransaction:ownTransaction});
  assert.equal(f.calls.sourceReads,reads);assert.equal(f.calls.submits,0);
  await assert.rejects(()=>reopened.recover({...f.raw,signedHex:'changed'}),/Watcher recovery request drift/);
  const db=new DatabaseSync(f.args.databasePath);
  try{db.prepare('UPDATE sources SET backing=? WHERE id=?').run(JSON.stringify({kind:'ergo-return-v1',observation:{...f.observation,amount:'999'}}),f.requestId);}finally{db.close();}
  await assert.rejects(()=>reopened.recover(f.raw),/Watcher retained return drift/);
});
