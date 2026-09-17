import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {registerAuthenticatedDepositSource as register,captureAuthenticatedDepositSource as capture} from './authenticatedDepositSource.mjs';
import * as authenticatedSource from './authenticatedDepositSource.mjs';

const h=n=>n.toString(16).padStart(2,'0').repeat(32);
const canonical=value=>JSON.stringify(value,(_,item)=>item&&Object.getPrototypeOf(item)===Object.prototype?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
// Synthetic structural fixture only: no crypto, holder, chain or proof validation is performed by these tests.
function fixture(){
  const genesis=h(1),vaultSpend=h(2),txid=h(3),blockHash=h(4),P=h(5),I=h(6),asset=h(7),tip=h(8),pin='ab'.repeat(20);
  const configuration={version:2,domain:'rosen-monero-deposit',sourceNetwork:'mainnet',vaultEpoch:'1',vaultAddress:'synthetic-vault',destinationNetwork:'ergo-testnet',destinationAsset:asset,nativeSourcePin:pin};
  const deposit={txId:txid,txBytes:'aabb',blockHash,blockHeight:10,outputKey:P,outputIndex:0,chainIndex:42,amountAtomic:'1000',feeAtomic:'1'};
  const snapshot={id:createHash('sha256').update(genesis+tip).digest('hex'),network:'mainnet',txid,blockHash,blockHeight:10n,chainHeight:100n,minConfirmations:2n};
  const context={id:'synthetic-source',revision:1n,configurationRevision:'synthetic-v1',configuration,feePolicy:{bridgeFee:'100',networkFee:'20',sourceDecimals:12,destinationDecimals:12,remainder:'reject'},snapshot};
  const wire={version:2,domain:configuration.domain,source_network:'mainnet',vault_epoch:'1',vault_address:configuration.vaultAddress,destination_network:'ergo-testnet',destination_asset:asset,bridge_fee:'100',network_fee:'20',txid,to_address:'synthetic-recipient',amount:'1000',expiry_height:'200',outputs:[{output_index:'0',output_public_key:P,amount:'1000'}]};
  const bytes=Uint8Array.from(Buffer.from(canonical(wire))),proof='OutProofV2'+'1'.repeat(132);
  const identity=id=>({kind:'independent',id,sourcePin:pin});
  const providers={proof:{identity:identity('synthetic-proof'),async verify(){}},receipt:{identity:identity('synthetic-holders'),async reconstruct(){}},addresses:{identity:identity('synthetic-address'),async verify(){}}};
  const decision={status:'accepted',authority:'stateless-candidate',evidenceMode:'independent',depositId:`monero:deposit:mainnet:${txid}`,intentHash:createHash('sha256').update(bytes).digest('hex'),intentBytesHex:Buffer.from(bytes).toString('hex'),sourceNetwork:'mainnet',txid,blockHash,blockHeight:10n,snapshotId:snapshot.id,checkedAtHeight:100n,expiresAtHeight:200n,vaultEpoch:'1',vaultAddress:configuration.vaultAddress,destinationNetwork:'ergo-testnet',destinationAsset:asset,recipient:'synthetic-recipient',amount:1000n,bridgeFee:100n,networkFee:20n,netAmount:880n,destinationAmount:880n,retainedAtomicRemainder:0n,outputs:[{outputIndex:0n,publicKey:P,amount:1000n,locator:`monero:deposit:mainnet:${txid}:0`,economicId:`monero:output-key:mainnet:${P}`}],verifierReferences:Object.values(providers).map(p=>`independent:${p.identity.id}@${pin}`)};
  const observation={type:'source-verified',id:1,ceremony:h(9),epoch:'1',rosterDigest:h(10),genesis,inspection:h(11),snapshot:{height:100,hash:tip},txId:txid,blockHash,blockHeight:10,outputKey:P,outputIndex:0,chainIndex:42,amountAtomic:'1000',keyImage:I,spentStatus:0,historyOccurrences:1,walletSigns:0};
  const publicScan={groupPublicKey:vaultSpend,genesis,snapshot:{height:100,hash:tip},source:{kind:'deposit',startHeight:1,blockHashes:[h(12)],ringIndices:[1],outputIds:[{transaction:txid,index:0,chainIndex:42}],deposit:{...deposit}},keyImage:I};
  return {source:{context,request:{intentBytes:bytes,proof,receiptEvidence:{txid}},providers,decision,observation,deposit,current:async()=>{},publicScan,proofRequest:{txHex:deposit.txBytes,txId:txid,vaultAddress:configuration.vaultAddress,messageHex:Buffer.from(bytes).toString('hex'),proof}},authority:{genesis,vaultSpend}};
}
test('registered synthetic source returns same identity and exact immutable backing',()=>{
  const {source,authority}=fixture();assert.equal(register(source,authority),source);const cap=capture(source);
  assert.deepEqual(cap.backing,{version:1,...authority,vaultAddress:'synthetic-vault',intentHash:source.decision.intentHash,txid:h(3),outputIndex:'0',globalIndex:'42',publicKey:h(5),keyImage:h(6),amountAtomic:'1000',destinationNetwork:'ergo-testnet',destinationAsset:h(7),recipient:'synthetic-recipient',creditedAtomic:'880'});
  assert(Object.isFrozen(cap.backing));assert(Object.isFrozen(source.providers.proof));assert.equal(cap.current(),undefined);
  assert.throws(()=>register(source,authority),/source:registered/);assert.throws(()=>capture({...source}),/source:unregistered/);
  assert.throws(()=>{cap.backing.publicKey=h(22);});assert(!JSON.stringify(cap.backing).includes('private'));
});
test('unregistered handles and changed original byte buffers never yield a current capability',()=>{
  const {source,authority}=fixture();assert.throws(()=>capture(source),/source:unregistered/);register(source,authority);const cap=capture(source);
  source.request.intentBytes[0]^=1;assert.throws(()=>capture(source),/source:changed/);assert.throws(()=>cap.current(),/source:changed/);
});
test('all public source subtrees and provider callbacks are retained',()=>{
  const {source,authority}=fixture();register(source,authority);
  for(const operation of [()=>{source.current=async()=>{};},()=>{source.providers.proof.verify=async()=>{};},()=>{source.providers.receipt.reconstruct=async()=>{};},()=>{source.providers.addresses.verify=async()=>{};},()=>{source.decision.recipient='other';},()=>{source.publicScan.source.deposit.txId=h(21);},()=>{source.request.proof='other';},()=>{source.context.snapshot.blockHeight=11n;},()=>{source.observation.keyImage=h(21);},()=>{source.proofRequest.txHex='cc';}])assert.throws(operation);
  capture(source).current();
});
test('each cross-record identity or value mismatch is rejected before registration',()=>{
  const mutations=[
    s=>s.decision.status='rejected',s=>s.decision.authority='other',s=>s.decision.evidenceMode='fixture',s=>s.context.configuration.version=1,
    s=>s.decision.outputs.push({...s.decision.outputs[0]}),s=>s.decision.outputs[0].publicKey=h(21),s=>s.decision.outputs[0].outputIndex=1n,s=>s.decision.outputs[0].amount=999n,
    s=>s.deposit.txId=h(21),s=>s.deposit.outputIndex=1,s=>s.deposit.chainIndex=43,s=>s.deposit.amountAtomic='999',s=>s.deposit.blockHash=h(21),
    s=>s.observation.keyImage=h(21),s=>s.observation.genesis=h(21),s=>s.observation.spentStatus=1,s=>s.observation.walletSigns=1,s=>s.observation.outputKey=h(21),
    s=>s.publicScan.groupPublicKey=h(21),s=>s.publicScan.genesis=h(21),s=>s.publicScan.snapshot.hash=h(21),s=>s.publicScan.source.kind='coinbase',
    s=>s.publicScan.sourcePolicy='authenticated-backing-v1',s=>s.observation.sourcePolicy='other',s=>s.observation.historyOccurrences=0x100000000,
    s=>s.context.snapshot.txid=h(21),s=>s.context.snapshot.blockHeight=11n,s=>s.context.snapshot.chainHeight=101n,s=>s.context.configuration.vaultAddress='other',
    s=>s.decision.intentHash=h(21),s=>s.decision.recipient='other',s=>s.decision.destinationAsset=h(21),s=>s.decision.destinationAmount=879n,s=>s.decision.amount=999n,
    s=>s.request.proof='OutProofV2'+'2'.repeat(132),s=>s.request.receiptEvidence.txid=h(21),s=>s.proofRequest.txHex='cc',s=>s.proofRequest.txId=h(21),s=>s.proofRequest.messageHex='ff',
    s=>s.providers.proof.identity.kind='fixture',s=>s.providers.proof.identity.sourcePin='cd'.repeat(20),s=>s.decision.verifierReferences[0]='other',
  ];
  for(const mutate of mutations){const {source,authority}=fixture();mutate(source);assert.throws(()=>register(source,authority),undefined,mutate.toString());assert.throws(()=>capture(source),/source:unregistered/);}
});
test('normalization rejects getters, hidden fields, unsupported objects and cycles without invoking getters',()=>{
  let calls=0;
  const mutations=[s=>Object.defineProperty(s.context,'hidden',{value:true}),s=>Object.defineProperty(s.context,'unsafe',{enumerable:true,get(){calls++;return 1;}}),s=>{s.context[Symbol('extra')]=1;},s=>{s.context.extra=new Date();},s=>{s.context.extra=undefined;},s=>{s.context.extra=()=>{};},s=>{s.context.extra=s.context;},s=>{s.context.extra=NaN;},s=>{s.request.intentBytes.extra=true;},s=>{s.extra='donor-key.private';}];
  for(const mutate of mutations){const {source,authority}=fixture();mutate(source);assert.throws(()=>register(source,authority));}assert.equal(calls,0);
});
test('bigint/string and byte/array substitutions cannot preserve source meaning',()=>{
  for(const mutate of [s=>s.decision.amount='1000',s=>s.request.intentBytes=Array.from(s.request.intentBytes),s=>s.deposit.outputIndex='0']){
    const {source,authority}=fixture();mutate(source);assert.throws(()=>register(source,authority));
  }
});
test('selected backing policy retains duplicate observations without inferring a second claim',()=>{
  const {source,authority}=fixture();source.publicScan.sourcePolicy='authenticated-backing-v1';source.observation.sourcePolicy='authenticated-backing-v1';source.observation.historyOccurrences=2;
  register(source,authority);assert.equal(capture(source).backing.publicKey,h(5));assert.equal(capture(source).backing.amountAtomic,'1000');
});

function rewriteIntent(source, edit) {
  const intent=JSON.parse(Buffer.from(source.request.intentBytes).toString('utf8'));
  edit(intent);
  const bytes=Uint8Array.from(Buffer.from(canonical(intent)));
  source.request.intentBytes=bytes;
  source.decision.intentBytesHex=Buffer.from(bytes).toString('hex');
  source.decision.intentHash=createHash('sha256').update(bytes).digest('hex');
  source.proofRequest.messageHex=source.decision.intentBytesHex;
}

test('origin agrees across fresh verifier identities and independently registered equal sources',()=>{
  const first=fixture(),second=fixture();
  register(first.source,first.authority);register(second.source,second.authority);
  const candidate=structuredClone(first.source.decision);
  candidate.verifierReferences=['independent:fresh-reader@'+'ab'.repeat(20)];
  const origin=authenticatedSource.moneroCreditOrigin(first.source,candidate);
  assert.match(origin,/^rosen-monero-output:v1:[0-9a-f]{64}$/);
  assert.equal(origin,authenticatedSource.moneroCreditOrigin(second.source,second.source.decision));
  assert.throws(()=>authenticatedSource.moneroCreditOrigin({...first.source},candidate),/source:unregistered/);
  first.source.request.intentBytes[0]^=1;
  assert.throws(()=>authenticatedSource.moneroCreditOrigin(first.source,candidate),/source:changed/);
});

test('each recomputed decision field remains bound despite fresh verifier references',()=>{
  const {source,authority}=fixture();register(source,authority);
  for(const field of Object.keys(source.decision).filter(name=>name!=='verifierReferences')){
    const candidate=structuredClone(source.decision);
    const value=candidate[field];
    candidate[field]=typeof value==='bigint'?value+1n:typeof value==='string'?value+'x':[];
    assert.throws(()=>authenticatedSource.moneroCreditOrigin(source,candidate),/source:agreement:candidate/,field);
  }
  for(const candidate of [{...source.decision,unexpected:'value'},Object.fromEntries(Object.entries(source.decision).filter(([name])=>name!=='intentHash'))]){
    assert.throws(()=>authenticatedSource.moneroCreditOrigin(source,candidate),/source:agreement:candidate/);
  }
});

test('origin distinguishes selected output, associated image, full intent and destination',()=>{
  const base=fixture();register(base.source,base.authority);
  const original=authenticatedSource.moneroCreditOrigin(base.source,base.source.decision);
  // These are coherent structural sources, not alternative native deposits or proofs.
  const variants={
    outputIndex(s){
      s.deposit.outputIndex=s.observation.outputIndex=s.publicScan.source.deposit.outputIndex=1;
      s.publicScan.source.outputIds[0].index=1;
      s.decision.outputs[0].outputIndex=1n;s.decision.outputs[0].locator=s.decision.depositId+':1';
      rewriteIntent(s,intent=>{intent.outputs[0].output_index='1';});
    },
    outputKey(s){
      s.deposit.outputKey=s.observation.outputKey=s.publicScan.source.deposit.outputKey=h(21);
      s.decision.outputs[0].publicKey=h(21);s.decision.outputs[0].economicId='monero:output-key:mainnet:'+h(21);
      rewriteIntent(s,intent=>{intent.outputs[0].output_public_key=h(21);});
    },
    globalIndex(s){
      s.deposit.chainIndex=s.observation.chainIndex=s.publicScan.source.deposit.chainIndex=43;
      s.publicScan.source.outputIds[0].chainIndex=43;
    },
    keyImage(s){s.observation.keyImage=s.publicScan.keyImage=h(21);},
    expiry(s){s.decision.expiresAtHeight=201n;rewriteIntent(s,intent=>{intent.expiry_height='201';});},
    recipient(s){s.decision.recipient='another-recipient';rewriteIntent(s,intent=>{intent.to_address='another-recipient';});},
  };
  for(const [name,mutate] of Object.entries(variants)){
    const {source,authority}=fixture();mutate(source);register(source,authority);
    assert.notEqual(authenticatedSource.moneroCreditOrigin(source,source.decision),original,name);
  }
});

test('origin excludes local snapshot handles while retaining the same immutable backing',()=>{
  const first=fixture(),second=fixture(),s=second.source;
  s.context.snapshot.chainHeight=s.decision.checkedAtHeight=101n;
  s.publicScan.snapshot.height=s.observation.snapshot.height=101;
  s.publicScan.snapshot.hash=s.observation.snapshot.hash=h(22);
  s.context.snapshot.id=s.decision.snapshotId=createHash('sha256').update(s.publicScan.genesis+h(22)).digest('hex');
  register(first.source,first.authority);register(s,second.authority);
  assert.notEqual(first.source.decision.snapshotId,s.decision.snapshotId);
  assert.equal(authenticatedSource.moneroCreditOrigin(first.source,first.source.decision),authenticatedSource.moneroCreditOrigin(s,s.decision));
});
