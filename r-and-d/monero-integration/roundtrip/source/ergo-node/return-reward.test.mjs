import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import * as wasm from 'ergo-lib-wasm-nodejs';
import {config} from '../tools/config.mjs';
import {openReturnRewardVerifier,createReturnReward,returnRewardPolicy} from './return-reward.mjs';
import {withRewardPorts,getRewardChain} from '../consumer/rewardPorts.ts';
import EventOrder from '../guard-service/src/event/eventOrder.ts';
import {snapshotCreditSigning} from '../guard-service/src/deposit/moneroCreditSigner.mjs';
import {canonicalAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {createHash} from 'node:crypto';

const load=relative=>import(pathToFileURL(path.join(config.rosenRoot,relative)).href);
const [{ErgoChain,ErgoTransaction},{TokenMap},{TransactionType,ConfirmationStatus},{DummyLogger,DefaultLogger},{mockedStateContext}]=await Promise.all([
  load('packages/chains/ergo/dist/index.js'),load('node_modules/@rosen-bridge/tokens/dist/index.js'),load('packages/abstract-chain/dist/index.js'),
  load('node_modules/@rosen-bridge/abstract-logger/dist/index.js'),load('packages/chains/ergo/tests/transactionTestData.ts')]);
DefaultLogger.init(new DummyLogger());
const hex=value=>Buffer.from(value.sigma_serialize_bytes()).toString('hex');
const public1='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const public2='02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const pubs=[public1,public2,'03'+public1.slice(2),'03'+public2.slice(2)];
const public3='02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';
const address=tree=>wasm.Address.recreate_from_ergo_tree(wasm.ErgoTree.from_base16_bytes(tree)).to_base58(wasm.NetworkPrefix.Testnet);
const tree=address=>wasm.Address.from_base58(address).to_ergo_tree().to_base16_bytes();
const scripts=[...pubs,public3].map(pub=>'0008cd'+pub);
const asset='11'.repeat(32),rwt='22'.repeat(32),nft='33'.repeat(32),wids=['44'.repeat(32),'55'.repeat(32)];
function nativeBox(script,value,tokens,registers={},index=0){
  const builder=new wasm.ErgoBoxCandidateBuilder(wasm.BoxValue.from_i64(wasm.I64.from_str(String(value))),wasm.Contract.new(wasm.ErgoTree.from_base16_bytes(script)),100000);
  tokens.forEach(([id,amount])=>builder.add_token(wasm.TokenId.from_str(id),wasm.TokenAmount.from_i64(wasm.I64.from_str(String(amount)))));
  for(const [key,value]of Object.entries(registers))builder.set_register_value(Number(key),value);
  return wasm.ErgoBox.from_box_candidate(builder.build(),wasm.TxId.from_str('66'.repeat(32)),index);
}
const compact=s=>Object.fromEntries(['digest','txId','reducedHex','inputHex','dataHex','requiredSign'].map(key=>[key,s[key]]));
const arrayBoxes=values=>{const result=wasm.ErgoBoxes.empty();values.forEach(value=>result.add(value));return result;};
const hash=value=>createHash('sha256').update(value).digest('hex');

async function fixture(){
  const contracts=Object.fromEntries(['Lock','Permit','EventTrigger','Commitment','GuardSign'].map((name,i)=>[name,{tree:scripts[i],address:address(scripts[i])}]));
  const guard=nativeBox(contracts.GuardSign.tree,2000000n,[[nft,1n]],{4:wasm.Constant.from_coll_coll_byte(pubs.map(pub=>Buffer.from(pub,'hex'))),5:wasm.Constant.from_i32_array(Int32Array.from([3,3]))},2);
  const trigger=nativeBox(contracts.EventTrigger.tree,2000000n,[[rwt,20n]],{},0),lock=nativeBox(contracts.Lock.tree,100000000n,[[asset,500000n]],{},1);
  const feeNft='ab'.repeat(32),feeTree=scripts[4];
  const deployment={contracts,tokens:{Asset:asset,RWT:rwt,GuardNFT:nft},fundingAddress:address(scripts[4]),threshold:3,guardPublicKeys:pubs,
    guard:{boxId:guard.box_id().to_str()},watchers:wids.map(WID=>({WID})),minimumFee:{nft:feeNft,ergoTree:feeTree,minConfirmations:1},rewardPolicy:{}};
  const event={eventId:'77'.repeat(32),fromChain:'ergo',toChain:'monero',sourceChainTokenId:asset,targetChainTokenId:'XMR',sourceChainHeight:900,
    amount:'1000000',bridgeFee:'100',networkFee:'20',WIDsCount:2};
  const authority={event,transaction:{id:'88'.repeat(32),blockId:'99'.repeat(32),inclusionHeight:1,numConfirmations:1},trigger:JSON.parse(trigger.to_json()),wids,observation:{requestId:event.eventId}};
  const feeAuthority={authority:{version:1,network:'devnet',nodeVersion:'6.0.3',minFeeNFT:feeNft,ergoTokenId:asset,expectedErgoTree:feeTree,
    fromChain:'ergo',toChain:'monero',sourceChainHeight:900,minConfirmations:1,boxId:'bc'.repeat(32),boxBytes:'00',transactionId:'bd'.repeat(32),
    blockId:'be'.repeat(32),inclusionHeight:850},feeConfig:{bridgeFee:'101',networkFee:'21',feeRatio:'2',feeRatioDivisor:'10000',rsnRatio:'0',rsnRatioDivisor:'1'}};
  feeAuthority.digest=hash(canonicalAssignment({authority:feeAuthority.authority,feeConfig:feeAuthority.feeConfig}));
  const options={deployment,returnReceipt:{...authority,observation:authority.observation},redemption:{},terms:{},feeAuthority,paymentTxId:'aa'.repeat(32)};
  const tokenMap=new TokenMap();await tokenMap.updateConfigByJson([{ergo:{tokenId:asset,name:'rsXMR',decimals:12,type:'EIP-004',residency:'wrapped',extra:{}},monero:{tokenId:'XMR',name:'XMR',decimals:12,type:'native',residency:'native',extra:{}}}]);
  const network={getHeight:async()=>100000,getStateContext:async()=>mockedStateContext,getTxConfirmation:async()=>1,getAddressBoxes:async(_address,offset)=>offset?[]:[lock],
    getAddressAssets:async()=>({nativeToken:100000000n,tokens:[{id:asset,value:500000n}]}),getMempoolTransactions:async()=>[]};
  const sign=()=>{throw Error('test signing forbidden');};
  const chain=new ErgoChain(network,{fee:1100000n,confirmations:{payment:1,cold:1,manual:1,arbitrary:1},
    addresses:{lock:contracts.Lock.address,permit:contracts.Permit.address,fraud:contracts.Permit.address,cold:deployment.fundingAddress},rwtId:rwt,minBoxValue:1000000n,eventTxConfirmation:1},tokenMap,{isInSign:sign,sign});
  const current=new Map([trigger,lock,guard].map(box=>[box.box_id().to_str(),JSON.parse(box.to_json())]));
  let observations=0,feeReads=0,unmerged=[],afterFeeCapture=()=>{};
  const ports={wasm,chain,tokenMap,EventOrder,withRewardPorts,ErgoTransaction,rewardType:TransactionType.reward,feeTree:ErgoChain.feeBoxErgoTree,tree,stateContext:async()=>mockedStateContext,
    verifyReturnAuthority:async()=>{observations++;return structuredClone({...authority,transaction:{...authority.transaction,numConfirmations:observations}});},
    captureFeeAuthority:async()=>{feeReads++;const captured=structuredClone(feeAuthority);await afterFeeCapture(feeReads);return captured;},
    rpc:async route=>{if(route==='/info')return {network:'devnet',appVersion:'6.0.3',peersCount:0};if(route.startsWith('/utxo/byId/')){const box=current.get(route.split('/').at(-1));assert(box,'test spent input');return structuredClone(box);}if(route.startsWith('/blockchain/box/unspent/byAddress'))return unmerged;throw Error('Unexpected test RPC '+route);}};
  const rehashFee=()=>feeAuthority.digest=hash(canonicalAssignment({authority:feeAuthority.authority,feeConfig:feeAuthority.feeConfig}));
  return {options,ports,current,authority,guard,trigger,lock,feeAuthority,rehashFee,get observations(){return observations;},get feeReads(){return feeReads;},
    setUnmerged(value){unmerged=value;},setAfterFeeCapture(value){afterFeeCapture=value;}};
}

test('actual EventOrder uses fee maxima, ratio, watcher rounding and native payment binding',async()=>{
  const f=await fixture(),verifier=await openReturnRewardVerifier(f.options,f.ports),{order}=await verifier.inspect();
  assert.equal(await f.ports.chain.getTxConfirmationStatus('aa'.repeat(32),TransactionType.reward),ConfirmationStatus.ConfirmedEnough);
  assert.equal(order.length,4);assert.deepEqual(order.slice(0,2).map(row=>row.assets.tokens),wids.map(()=>[{id:rwt,value:10n},{id:asset,value:70n}]));
  assert.deepEqual(order.slice(0,2).map(row=>row.extra),wids);assert.equal(order[2].assets.tokens[0].value,60n);assert.equal(order[3].assets.tokens[0].value,21n);
  assert.equal(order[2].extra,Buffer.from(f.options.paymentTxId).toString('hex'));
  assert.throws(()=>getRewardChain(),/outside configured scope/);
});

test('actual ErgoChain candidate passes full native verification, retains exact restart bytes and rejects changed context',async()=>{
  const f=await fixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'return-reward-test-'));
  const created=await createReturnReward({...f.options,directory},f.ports);assert.equal(created.transaction.txType,TransactionType.reward);
  assert.equal(created.snapshot.requiredSign,3);assert.equal(created.snapshot.inputHex.length,2);assert.equal(created.snapshot.dataHex.length,1);
  assert.equal((await created.verifyRaw(created.snapshot)).snapshot.digest,created.snapshot.digest);
  const restarted=await createReturnReward({...f.options,directory},f.ports);assert.deepEqual(restarted.snapshot,created.snapshot);
  await assert.rejects(()=>createReturnReward({...f.options,paymentTxId:'bb'.repeat(32),directory},f.ports),/retained context conflict/);
  assert.equal(f.observations,7);assert.equal(f.feeReads,7);
});

test('reward ports keep concurrent order configurations isolated',async()=>{
  const first=await fixture(),second=await fixture();second.options.deployment.rewardPolicy.watchersSharePercent=20;
  const verifiers=await Promise.all([first,second].map(f=>openReturnRewardVerifier(f.options,f.ports)));
  const results=await Promise.all(verifiers.map(verifier=>verifier.inspect()));
  assert.deepEqual(results.map(r=>r.order[0].assets.tokens[1].value),[70n,20n]);
});

test('reward context is copied and incomplete payout binding refuses',async()=>{
  const f=await fixture(),verifier=await openReturnRewardVerifier(f.options,f.ports);
  f.options.deployment.rewardPolicy.watchersSharePercent=99;assert.equal((await verifier.inspect()).order[0].assets.tokens[1].value,70n);
  await assert.rejects(()=>openReturnRewardVerifier({...f.options,paymentTxId:''},f.ports),/Reward hash/);
  assert.throws(()=>returnRewardPolicy({...f.options.deployment,rewardPolicy:{watchersSharePercent:101}}),/share range/);
});

test('fresh fee authority drift and unsupported emissions refuse',async()=>{
  const f=await fixture(),verifier=await openReturnRewardVerifier(f.options,f.ports);f.feeAuthority.feeConfig.bridgeFee='999';
  f.rehashFee();await assert.rejects(()=>verifier.inspect(),/retained fee/);
  const emission=await fixture();emission.feeAuthority.feeConfig.rsnRatio='1';
  emission.rehashFee();
  await assert.rejects(async()=>{const v=await openReturnRewardVerifier(emission.options,emission.ports);return v.inspect();},/nonzero emission/);
});

test('fresh reward verification accepts a current NFT successor with identical historical fees',async()=>{
  const f=await fixture(),verifier=await openReturnRewardVerifier(f.options,f.ports);
  Object.assign(f.feeAuthority.authority,{boxId:'ca'.repeat(32),boxBytes:'01',transactionId:'cb'.repeat(32),blockId:'cc'.repeat(32),inclusionHeight:899});f.rehashFee();
  const inspected=await verifier.inspect();assert.equal(inspected.event.eventId,f.authority.event.eventId);assert.equal(f.feeReads,1);
});

test('fresh reward verification rejects changed selectors and closing fee changes',async()=>{
  const selector=await fixture(),first=await openReturnRewardVerifier(selector.options,selector.ports);selector.feeAuthority.authority.expectedErgoTree=scripts[3];selector.rehashFee();
  await assert.rejects(()=>first.inspect(),/retained fee/);
  const closing=await fixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'return-reward-closing-fee-'));
  closing.setAfterFeeCapture(reads=>{if(reads===1){closing.feeAuthority.feeConfig.networkFee='22';closing.rehashFee();}});
  await assert.rejects(()=>createReturnReward({...closing.options,directory},closing.ports),/retained fee/);
});

test('unmerged watcher is never silently omitted from rewards',async()=>{
  const f=await fixture(),v=await openReturnRewardVerifier(f.options,f.ports);
  const box=nativeBox(f.options.deployment.contracts.Commitment.tree,1000000n,[[rwt,10n]],{4:wasm.Constant.from_byte_array(Buffer.from('ee'.repeat(32),'hex')),5:wasm.Constant.from_byte_array(Buffer.from(f.authority.event.eventId,'hex'))},5);
  f.setUnmerged([JSON.parse(box.to_json())]);await assert.rejects(()=>v.inspect(),/unmerged watcher/);
});

for(const mutation of ['digest','input-bytes','spent','order-recipient','extra-output','miner-fee','asset-destruction','data-quorum'])test('reward verifier refuses '+mutation,async()=>{
  const f=await fixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'return-reward-negative-'));
  const created=await createReturnReward({...f.options,directory},f.ports),snapshot=structuredClone(created.snapshot);
  if(mutation==='digest')snapshot.digest='00'.repeat(32);
  else if(mutation==='input-bytes')snapshot.inputHex.reverse();
  else if(mutation==='spent')f.current.delete(f.lock.box_id().to_str());
  else {
    const reduced=wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(snapshot.reducedHex,'hex')),json=JSON.parse(reduced.unsigned_tx().to_json());
    const outputs=json.outputs;
    if(mutation==='order-recipient')outputs[0].ergoTree=f.options.deployment.contracts.GuardSign.tree;
    if(mutation==='extra-output')outputs.push(structuredClone(outputs.at(-1)));
    if(mutation==='miner-fee')outputs.at(-1).value=Number(outputs.at(-1).value)+1;
    if(mutation==='asset-destruction')outputs.at(-2).assets[0].amount--;
    let data=snapshot.dataHex.map(bytes=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(bytes,'hex')));
    if(mutation==='data-quorum'){
      const replaced=nativeBox(f.options.deployment.contracts.GuardSign.tree,2000000n,[[nft,1n]],{4:wasm.Constant.from_coll_coll_byte(pubs.map(pub=>Buffer.from(pub,'hex'))),5:wasm.Constant.from_i32_array(Int32Array.from([2,3]))},6);
      data=[replaced];json.dataInputs=[{boxId:replaced.box_id().to_str()}];f.current.set(replaced.box_id().to_str(),JSON.parse(replaced.to_json()));
    }
    const inputs=snapshot.inputHex.map(bytes=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(bytes,'hex')));
    const altered=wasm.ReducedTransaction.from_unsigned_tx(wasm.UnsignedTransaction.from_json(JSON.stringify(json)),arrayBoxes(inputs),arrayBoxes(data),mockedStateContext);
    Object.assign(snapshot,compact(snapshotCreditSigning(altered,3,inputs,data)));
  }
  await assert.rejects(()=>created.verifyRaw(snapshot));
});
