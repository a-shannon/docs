import assert from 'node:assert/strict';
import test from 'node:test';
import {captureFreshCreditSource} from './fresh-credit-source.mjs';

const h=n=>n.toString(16).padStart(64,'0');
function fixture(){
  const candidate={id:1,scope:h(1),txId:h(2),transactionHex:'aabb',sourceBlockId:h(3),sourceHeight:4097};
  const backing={version:2,genesis:h(4),committeeDigest:h(5),vaultSpend:h(6),vaultAddress:'configured-vault',intentHash:h(7),
    txId:h(2),blockHash:h(3),blockHeight:4097,outputIndex:1,globalIndex:5000,outputKey:h(8),keyImage:h(9),amountAtomic:'1000',
    destinationNetwork:'ergo-testnet',destinationAsset:h(10),recipient:'recipient',creditedAtomic:'880'};
  const observation={fromChain:'monero',toChain:'ergo',fromAddress:'rosen-monero-output:v2:'+h(11),toAddress:'recipient',amount:'1000',
    bridgeFee:'100',networkFee:'20',sourceChainTokenId:'XMR',targetChainTokenId:h(10),sourceTxId:h(2),sourceBlockId:h(3),requestId:h(12),rawData:''};
  const state={height:5000,status:'accepted',error:undefined,backingPatch:{},observationPatch:{},decisionPatch:{},calls:[0,0,0,0]};
  const response=()=>({status:state.status,observation:{...observation,...state.observationPatch},backing:{...backing,...state.backingPatch},
    decision:{status:'accepted',depositId:'monero:deposit:mainnet:'+h(2),intentHash:h(7),sourceNetwork:'mainnet',txid:h(2),blockHash:h(3),blockHeight:4097n,destinationNetwork:'ergo-testnet',
      destinationAsset:h(10),recipient:'recipient',amount:1000n,bridgeFee:100n,networkFee:20n,netAmount:880n,
      destinationAmount:880n,retainedAtomicRemainder:0n,evidenceMode:'independent',outputs:[{publicKey:h(8)}],checkedAtHeight:BigInt(state.height),...state.decisionPatch}});
  const readers=[0,1,2,3].map(index=>({scope:candidate.scope,async inspect(input,signal){
    state.calls[index]++;assert(Object.isFrozen(input));assert.deepEqual(input,candidate);signal.throwIfAborted();
    if(state.error)throw state.error;
    return response();
  }}));
  const watcherReceipt={observation:{...observation,height:4097}};delete watcherReceipt.observation.rawData;
  return {candidate,backing,observation,state,readers,watcherReceipt,response};
}

test('four fresh readers preserve stable backing and observation across ordinary growth',async()=>{
  const f=fixture(),gate=await captureFreshCreditSource({freshAdmission:{readers:f.readers,candidate:f.candidate},watcherReceipt:f.watcherReceipt});
  assert.equal(gate.scope,f.candidate.scope);assert.equal(gate.genesis,f.backing.genesis);
  const first=await gate.read(1);f.state.height++;
  const refreshed=await gate.revalidate(1,first);
  assert.notEqual(first.decision.checkedAtHeight,refreshed.decision.checkedAtHeight);
  assert.deepEqual(refreshed.observation,first.observation);assert.deepEqual(refreshed.backing,first.backing);
  assert.deepEqual(f.state.calls,[1,2,0,0]);
});

test('malformed evidence and changed source semantics stop refresh',async()=>{
  const malformed=fixture(),malformedGate=await captureFreshCreditSource({freshAdmission:{readers:malformed.readers,candidate:malformed.candidate},watcherReceipt:malformed.watcherReceipt});
  const first=await malformedGate.read(2);malformed.state.error=Error('malformed proof');
  await assert.rejects(()=>malformedGate.revalidate(2,first),/malformed proof/);
  malformed.state.error=undefined;malformed.state.status='pending';
  await assert.rejects(()=>malformedGate.revalidate(2,first),/Fresh source not accepted/);

  const changed=fixture(),changedGate=await captureFreshCreditSource({freshAdmission:{readers:changed.readers,candidate:changed.candidate},watcherReceipt:changed.watcherReceipt});
  const stable=await changedGate.read(3);changed.state.backingPatch={outputKey:h(99)};
  await assert.rejects(()=>changedGate.revalidate(3,stable),/Fresh source (backing|binding)/);
  changed.state.backingPatch={};changed.state.observationPatch={amount:'1001'};
  await assert.rejects(()=>changedGate.revalidate(3,stable),/Fresh source (watcher receipt|observation|binding)/);
});

test('coordinated source namespace drift cannot preserve the accepted backing',async()=>{
  const f=fixture(),gate=await captureFreshCreditSource({freshAdmission:{readers:f.readers,candidate:f.candidate},watcherReceipt:f.watcherReceipt});
  const stable=await gate.read(2);
  f.state.decisionPatch={sourceNetwork:'other',depositId:'monero:deposit:other:'+h(2)};
  await assert.rejects(()=>gate.revalidate(2,stable),/Fresh source binding/);
});

for(const [name,decisionPatch] of [
  ['non-independent evidence',{evidenceMode:'cached'}],
  ['retained remainder',{retainedAtomicRemainder:1n}],
  ['net amount drift',{netAmount:879n}],
])test('refuses '+name+' before credit authorization',async()=>{
  const f=fixture(),gate=await captureFreshCreditSource({freshAdmission:{readers:f.readers,candidate:f.candidate},watcherReceipt:f.watcherReceipt});
  const stable=await gate.read(1);f.state.decisionPatch=decisionPatch;
  await assert.rejects(()=>gate.revalidate(1,stable),/Fresh source binding/);
});

test('composition requires four distinct readers at the exact candidate scope',async()=>{
  const f=fixture();
  await assert.rejects(()=>captureFreshCreditSource({freshAdmission:{readers:f.readers.slice(0,3),candidate:f.candidate},watcherReceipt:f.watcherReceipt}),/four readers/);
  f.readers[3]=f.readers[0];
  await assert.rejects(()=>captureFreshCreditSource({freshAdmission:{readers:f.readers,candidate:f.candidate},watcherReceipt:f.watcherReceipt}),/distinct readers/);
  const g=fixture();g.readers[2].scope=h(88);
  await assert.rejects(()=>captureFreshCreditSource({freshAdmission:{readers:g.readers,candidate:g.candidate},watcherReceipt:g.watcherReceipt}),/scope/);
  const crossed=fixture();crossed.state.backingPatch={txId:h(99)};
  await assert.rejects(()=>captureFreshCreditSource({freshAdmission:{readers:crossed.readers,candidate:crossed.candidate},watcherReceipt:crossed.watcherReceipt}),/Fresh source binding/);
});

test('captures the configured reader array before the first asynchronous read',async()=>{
  const f=fixture(),gate=await captureFreshCreditSource({freshAdmission:{readers:f.readers,candidate:f.candidate},watcherReceipt:f.watcherReceipt});
  f.readers[1]={scope:f.candidate.scope,async inspect(){return f.response();}};
  f.state.error=Error('original proof reader failed');
  await assert.rejects(()=>gate.read(1),/original proof reader failed/);
});

test('refuses configured reader method or scope drift',async()=>{
  const method=fixture(),methodGate=await captureFreshCreditSource({freshAdmission:{readers:method.readers,candidate:method.candidate},watcherReceipt:method.watcherReceipt});
  method.readers[2].inspect=async()=>method.response();
  await assert.rejects(()=>methodGate.read(2),/Fresh source scope/);
  const scope=fixture(),scopeGate=await captureFreshCreditSource({freshAdmission:{readers:scope.readers,candidate:scope.candidate},watcherReceipt:scope.watcherReceipt});
  scope.readers[3].scope=h(99);
  await assert.rejects(()=>scopeGate.read(3),/Fresh source scope/);
});
