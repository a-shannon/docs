import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createECDH,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {MoneroCreditAssignment as Ledger,canonicalAssignment,committeeConfigDigest} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {createWatcherParticipant,createWatcherTransport,openWatcherStore,loadWatcherRuntime,WATCHER_PIN} from './watcher-runtime.mjs';

const enabled={skip:!process.env.WATCHER_DEPENDENCY_ROOT};
const h=n=>n.toString(16).padStart(2,'0').repeat(32);
const keys=[1,2,3,4].map(n=>{const k=createECDH('secp256k1');k.setPrivateKey(Buffer.from(n.toString(16).padStart(64,'0'),'hex'));return k.getPublicKey('hex','compressed');});
const initialBacking={version:2,genesis:h(1),committeeDigest:h(2),vaultSpend:h(3),vaultAddress:'vault',intentHash:h(4),txId:h(5),blockHash:h(6),blockHeight:10,outputIndex:1,globalIndex:12,outputKey:h(7),keyImage:h(8),amountAtomic:'1000',destinationNetwork:'ergo-testnet',destinationAsset:h(9),recipient:'recipient',creditedAtomic:'900'};
const fakeTransaction=id=>({id:()=>({to_str:()=>id}),sigma_serialize_bytes:()=>Buffer.from(id,'hex'),to_json:()=>JSON.stringify({id})});

async function fixture(t,{backing=initialBacking,pause=async()=>{}}={}){
  const dependencyRoot=process.env.WATCHER_DEPENDENCY_ROOT,require=createRequire(join(dependencyRoot,'package.json')),wasm=require('ergo-lib-wasm-nodejs');
  const directory=mkdtempSync(join(tmpdir(),'watcher-runtime-novelty-')),databasePath=join(directory,'watcher.sqlite'),ledgers=[],actors=[];
  const creditEntries=keys.map((guardKey,i)=>{const configuration={custodyDomain:'local-monero-genesis:'+backing.genesis,guardKey,committeeKeys:keys,quorum:3,maxFaults:1,activationId:'activation',policyEpoch:'1',policyDigest:h(10),backingPolicy:'single-deposit-v2'},file=join(directory,'guard-'+i+'.sqlite');
    ledgers.push(Ledger.create(file,configuration));const {dev,ino}=lstatSync(file);return {file,configuration,identity:{dev,ino}};});
  t.after(()=>{actors.reverse().forEach(a=>a.close());ledgers.forEach(l=>l.close());});
  const secret=wasm.SecretKey.dlog_from_bytes(Buffer.from(h(1),'hex')),address=secret.get_address().to_base58(wasm.NetworkPrefix.Testnet),contract={address,tree:secret.get_address().to_ergo_tree().to_base16_bytes()};
  const watcher={WID:h(60),secretKey:secret,permitBoxes:[],feeBoxes:[]};
  const deployment={guardPublicKeys:keys,watchers:[{WID:watcher.WID},{WID:h(61)}],fundingAddress:address,tokens:{RWTRepoNFT:h(62),RWT:h(63),Asset:h(9),RepoConfigNFT:h(64),CleanupNFT:h(65)},contracts:{Permit:contract,Commitment:contract,EventTrigger:contract},RWTRepoBox:{boxId:h(66)},repoConfigBox:{boxId:h(67)}};
  const requestId=Buffer.from(require('blakejs').blake2b(Buffer.from(backing.txId),undefined,32)).toString('hex');
  const origin=createHash('sha256').update('rosen-monero/credit-origin/v2').update('\0').update(canonicalAssignment(backing)).digest('hex');
  const observation={sourceTxId:backing.txId,fromChain:'monero',toChain:'ergo',fromAddress:'rosen-monero-output:v2:'+origin,toAddress:backing.recipient,amount:'1000',bridgeFee:'50',networkFee:'50',sourceChainTokenId:'XMR',targetChainTokenId:backing.destinationAsset,sourceBlockId:backing.blockHash,height:backing.blockHeight,requestId};
  const raw={txId:backing.txId,intentHash:backing.intentHash},calls={rpc:[],submits:0,confirmations:0,inspections:0},responses=new Map();
  const nodePort={async rpc(route,payload){calls.rpc.push(route);if(route==='/transactions'){calls.submits++;return payload.id;}if(route.startsWith('/blockchain/transaction/byId/'))throw Error('404');throw Error('Unexpected node access: '+route);},async confirmed(id){calls.confirmations++;assert(responses.has(id),'Missing test receipt');return responses.get(id);},async getStateContext(){throw Error('Unexpected signing');}};
  const inspect=async()=>{calls.inspections++;return {status:'accepted',observation:{...observation,rawData:''},backing:structuredClone(backing)};};
  const args={databasePath,deployment,watcher,nodePort,inspect,dependencyRoot,creditEntries,pause};
  const open=async()=>{const actor=await createWatcherParticipant(args);actors.push(actor);return actor;};
  const actor=await open();
  const assign=(value=backing,index=2)=>ledgers[index].assign({binding:{obligationId:'retained-claim',creditTransactionDigest:h(11),sourceIntentDigest:value.intentHash,triggerBoxId:h(12),policyDigest:h(10),committeeDigest:committeeConfigDigest(creditEntries[0].configuration)},outputs:[{sourceNetwork:'mainnet',publicKey:value.outputKey}],backing:structuredClone(value)});
  const withStore=fn=>{const store=openWatcherStore(databasePath);try{return fn(store);}finally{store.close();}};
  const queue=(stage,id=h(70))=>withStore(store=>store.queue(stage+':'+requestId,requestId,fakeTransaction(id)));
  const commitments=deployment.watchers.map((w,i)=>({WID:w.WID,boxId:h(80+i),requestId,commitment:h(82+i),rwtCount:'10'}));
  return {actor,open,args,assign,raw,backing,observation,requestId,commitments,calls,queue,withStore,responses,wasm};
}

test('actual watcher rejects existing P under a new transaction before retaining an observation or submitting',enabled,async t=>{
  const f=await fixture(t,{backing:{...initialBacking,txId:h(20),intentHash:h(21),keyImage:h(22)}});f.assign(initialBacking);
  await assert.rejects(()=>f.actor.observe(f.raw),/Watcher backing already claimed/);
  assert.equal(f.withStore(s=>s.observation(f.requestId)),undefined);assert.equal(f.calls.submits,0);assert.deepEqual(f.calls.rpc,[]);
});

test('legacy in-process transport cannot publish a V2 event without credit custody',enabled,async t=>{
  const f=await fixture(t),deployment={...f.args.deployment,watchers:f.args.deployment.watchers.map(w=>({...f.args.watcher,WID:w.WID}))};
  const directory=mkdtempSync(join(tmpdir(),'watcher-legacy-v2-'));
  const transport=await createWatcherTransport({directory,deployment,nodePort:f.args.nodePort,observe:async()=>f.observation,dependencyRoot:f.args.dependencyRoot});
  t.after(()=>transport.close());await assert.rejects(()=>transport.publish(f.raw),/V2 deposits require watcher participants with credit custody/);
  assert.equal(f.calls.submits,0);assert.deepEqual(f.calls.rpc,[]);
});

test('claim inserted after observe blocks reveal before any queue or node access',enabled,async t=>{
  const f=await fixture(t);await f.actor.observe(f.raw);f.assign();
  await assert.rejects(()=>f.actor.reveal(f.requestId,f.commitments),/Watcher backing already claimed/);
  assert.equal(f.withStore(s=>s.readQueue('trigger:'+f.requestId)),undefined);assert.equal(f.calls.submits,0);assert.deepEqual(f.calls.rpc,[]);
});

for(const stage of ['commitment','trigger'])test('claim inserted during '+stage+' broadcast pause stops the pending submission',enabled,async t=>{
  let f,paused=0;f=await fixture(t,{pause:async checkpoint=>{if(checkpoint===(stage==='commitment'?'beforeCommitmentBroadcast':'beforeRevealBroadcast')){paused++;f.assign();}}});
  await f.actor.observe(f.raw);f.queue(stage);
  await assert.rejects(()=>stage==='commitment'?f.actor.commitment(f.raw):f.actor.reveal(f.requestId,f.commitments),/Watcher backing already claimed/);
  assert.equal(paused,1);assert.equal(f.calls.submits,0);assert.equal(f.calls.confirmations,0);
  assert.equal(f.withStore(s=>s.readQueue(stage+':'+f.requestId)).confirmed,null);
});

test('restarted watcher cannot publish a retained trigger queue after a guard claim',enabled,async t=>{
  const f=await fixture(t);await f.actor.observe(f.raw);f.queue('trigger');f.actor.close();f.assign();
  const restarted=await f.open();await assert.rejects(()=>restarted.reveal(f.requestId,f.commitments),/Watcher backing already claimed/);
  assert.equal(f.calls.submits,0);assert.equal(f.calls.confirmations,0);assert.equal(f.withStore(s=>s.readQueue('trigger:'+f.requestId)).confirmed,null);
});

test('unclaimed queued commitment reaches actual runtime box decoding and is submitted once',enabled,async t=>{
  const f=await fixture(t);await f.actor.observe(f.raw);const queued=f.queue('commitment');
  const runtime=await loadWatcherRuntime({...f.args,database:{}}),boxes=new runtime.Boxes({});
  const candidate=boxes.createCommitment(10,10n,f.args.watcher.WID,f.requestId,Buffer.from(h(85),'hex'),Buffer.from(h(86),'hex'));
  const output=JSON.parse(f.wasm.ErgoBox.from_box_candidate(candidate,f.wasm.TxId.from_str(queued.txId),0).to_json());
  f.responses.set(queued.txId,{id:queued.txId,numConfirmations:1,outputs:[output]});
  const result=await f.actor.commitment(f.raw);assert.equal(result.commitment.boxId,output.boxId);assert.equal(result.commitment.requestId,f.requestId);
  await f.actor.commitment(f.raw);assert.equal(f.calls.submits,1);assert.equal(f.calls.confirmations,1);
});

async function confirmedReceipt(t){
  const f=await fixture(t);await f.actor.observe(f.raw);const queued=f.queue('commitment');
  const runtime=await loadWatcherRuntime({...f.args,database:{}}),boxes=new runtime.Boxes({});
  const commitment=boxes.createCommitment(10,10n,f.args.watcher.WID,f.requestId,Buffer.from(h(85),'hex'),Buffer.from(h(86),'hex'));
  const ownOutput=JSON.parse(f.wasm.ErgoBox.from_box_candidate(commitment,f.wasm.TxId.from_str(queued.txId),0).to_json());
  f.commitments[0].boxId=ownOutput.boxId;
  const ownTransaction={id:queued.txId,numConfirmations:1,outputs:[ownOutput]};f.withStore(s=>s.confirm('commitment:'+f.requestId,ownTransaction));
  const triggerCandidate=boxes.createTriggerEvent(1000000n,f.observation.height,f.args.deployment.watchers.map(w=>w.WID),f.observation,10n);
  const trigger=JSON.parse(f.wasm.ErgoBox.from_box_candidate(triggerCandidate,f.wasm.TxId.from_str(h(90)),0).to_json());
  const transaction={id:h(90),numConfirmations:1,inputs:f.commitments.map(c=>({boxId:c.boxId})),outputs:[trigger]};
  f.responses.set(transaction.id,transaction);
  const receipt={watcherPin:WATCHER_PIN,observation:f.observation,commitments:f.commitments,trigger,transaction};
  await f.actor.receipt(f.requestId,receipt);return {...f,receipt,ownTransaction};
}

test('exact confirmed receipt recovers after assignment and restart without a new observation or submission',enabled,async t=>{
  const f=await confirmedReceipt(t);f.assign();f.actor.close();const restarted=await f.open();
  const inspections=f.calls.inspections;
  const result=await restarted.recover(f.raw);assert.deepEqual(result.receipt,f.receipt);assert.deepEqual(result.commitmentTransaction,f.ownTransaction);
  assert.equal(f.calls.inspections,inspections);assert.equal(f.calls.submits,0);assert.equal(f.withStore(s=>s.readQueue('trigger:'+f.requestId)),undefined);
  await assert.rejects(()=>restarted.observe(f.raw),/Watcher backing already claimed/);
});

test('confirmed receipt recovery rejects a changed raw request',enabled,async t=>{
  const f=await confirmedReceipt(t);f.assign();await assert.rejects(()=>f.actor.recover({...f.raw,intentHash:h(99)}),/Watcher recovery request drift/);
  assert.equal(f.calls.submits,0);
});

test('confirmed receipt recovery rejects changed retained backing',enabled,async t=>{
  const f=await confirmedReceipt(t);f.assign();const db=new DatabaseSync(f.args.databasePath);
  try{db.prepare('UPDATE sources SET backing=? WHERE id=?').run(canonicalAssignment({...f.backing,keyImage:h(99)}),f.requestId);}finally{db.close();}
  await assert.rejects(()=>f.actor.recover(f.raw),/Watcher backing commitment drift/);assert.equal(f.calls.submits,0);
});

test('confirmed receipt recovery rejects changed chain trigger outputs',enabled,async t=>{
  const f=await confirmedReceipt(t);f.assign();const changed=structuredClone(f.receipt.transaction);
  const runtime=await loadWatcherRuntime({...f.args,database:{}}),boxes=new runtime.Boxes({});
  const candidate=boxes.createTriggerEvent(1000001n,f.observation.height,f.args.deployment.watchers.map(w=>w.WID),f.observation,10n);
  changed.outputs=[JSON.parse(f.wasm.ErgoBox.from_box_candidate(candidate,f.wasm.TxId.from_str(changed.id),0).to_json())];
  f.responses.set(changed.id,changed);await assert.rejects(()=>f.actor.recover(f.raw),/Recovered transaction outputs drift/);assert.equal(f.calls.submits,0);
});

test('confirmed event recovery survives node spend metadata added after credit',enabled,async t=>{
  const f=await confirmedReceipt(t);f.assign();const changed=structuredClone(f.receipt.transaction);
  changed.outputs[0].spentTransactionId=h(94);changed.outputs[0].spendingProof={proofBytes:'',extension:{}};
  f.responses.set(changed.id,changed);assert.deepEqual((await f.actor.recover(f.raw)).receipt,f.receipt);assert.equal(f.calls.submits,0);
});

test('confirmed event recovery refuses a box ID inconsistent with its serialized output',enabled,async t=>{
  const f=await confirmedReceipt(t);f.assign();const changed=structuredClone(f.receipt.transaction);
  changed.outputs[0].boxId=h(95);f.responses.set(changed.id,changed);
  await assert.rejects(()=>f.actor.recover(f.raw));assert.equal(f.calls.submits,0);
});

test('matching supplied receipt and node output cannot change the retained event origin register',enabled,async t=>{
  const f=await confirmedReceipt(t);f.assign();const runtime=await loadWatcherRuntime({...f.args,database:{}}),boxes=new runtime.Boxes({});
  const changedCandidate=boxes.createTriggerEvent(1000000n,f.observation.height,f.args.deployment.watchers.map(w=>w.WID),{...f.observation,fromAddress:'changed-origin'},10n);
  const changedTrigger=JSON.parse(f.wasm.ErgoBox.from_box_candidate(changedCandidate,f.wasm.TxId.from_str(h(90)),0).to_json());
  const changed=structuredClone(f.receipt);changed.trigger=changedTrigger;changed.transaction.outputs=[changedTrigger];
  f.responses.set(changed.transaction.id,changed.transaction);
  await assert.rejects(()=>f.actor.receipt(f.requestId,changed),/Recovered event drift/);assert.equal(f.calls.submits,0);
});
