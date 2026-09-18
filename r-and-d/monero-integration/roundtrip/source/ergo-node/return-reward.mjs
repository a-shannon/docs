import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {canonicalAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {snapshotCreditSigning} from '../guard-service/src/deposit/moneroCreditSigner.mjs';
import {retainCreditRecord} from './credit-recovery.mjs';
import {verifyCreditOutputs} from './credit-output-policy.mjs';
import {effectiveWithdrawalFees,captureWithdrawalFeeAuthority,verifyRetainedWithdrawalFeeAuthority} from './v2-withdrawal-authority.mjs';

const hex=value=>Buffer.from(value.sigma_serialize_bytes()).toString('hex');
const text=value=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?String(item):item);
const hash=value=>createHash('sha256').update(value).digest('hex');
const hash32=value=>assert(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),'Reward hash');
const decimal=value=>{assert(/^(0|[1-9][0-9]*)$/.test(String(value)),'Reward decimal');return BigInt(value);};
const compact=s=>Object.fromEntries(['digest','txId','reducedHex','inputHex','dataHex','requiredSign'].map(key=>[key,s[key]]));

/** Only public deployment fields are captured; caller mutation cannot change authority. */
export function returnRewardContext(input){
  const d=input.deployment;
  const deployment=Object.fromEntries(['tokens','contracts','fundingAddress','threshold','guardPublicKeys','guard','minimumFee','rewardPolicy'].filter(key=>d[key]!==undefined).map(key=>[key,d[key]]));
  deployment.watchers=d.watchers.map(({WID,address})=>({WID,...(address===undefined?{}:{address})}));
  const context=structuredClone({deployment,returnReceipt:input.returnReceipt,redemption:input.redemption,terms:input.terms,feeAuthority:input.feeAuthority,paymentTxId:input.paymentTxId});
  hash32(context.paymentTxId);assert.equal(deployment.threshold,3);assert.equal(deployment.guardPublicKeys.length,4);
  assert.equal(new Set(deployment.guardPublicKeys).size,4);assert.equal(deployment.watchers.length,2);
  assert.equal(new Set(deployment.watchers.map(w=>w.WID)).size,2);
  return context;
}

export function returnRewardPolicy(deployment){
  const p=deployment.rewardPolicy??{};
  const watchersSharePercent=decimal(p.watchersSharePercent??70),watchersEmissionSharePercent=decimal(p.watchersEmissionSharePercent??70);
  assert(watchersSharePercent<=100n&&watchersEmissionSharePercent<=100n,'Reward share range');
  const distribution=structuredClone(p.chainBridgeFeeDistribution??[]);
  assert(Array.isArray(distribution)&&distribution.length<=16,'Reward distribution');
  let total=0n;for(const row of distribution){assert.equal(Object.keys(row).sort().join(','),'address,percent');assert(typeof row.address==='string');total+=decimal(row.percent);}
  assert(total<=100n,'Reward distribution total');
  return {watchersSharePercent,watchersEmissionSharePercent,minimumErg:1000000n,additionalErgOnPayment:0n,
    bridgeFeeDefaultAddress:p.bridgeFeeDefaultAddress??deployment.fundingAddress,
    networkFeeRepoAddress:p.networkFeeRepoAddress??deployment.fundingAddress,
    emissionAddress:p.emissionAddress??deployment.fundingAddress,emissionTokenId:p.emissionTokenId??deployment.tokens.Asset,
    chainBridgeFeeDistribution:{ergo:distribution}};
}

async function actualPorts(deployment){
  const {config}=await import('../tools/config.mjs');
  const load=relative=>import(pathToFileURL(path.join(config.rosenRoot,relative)).href);
  const [{wasm,rpc,tree},{stateContext},{verifyReturnAuthority},{withRewardPorts},{default:EventOrder}]=await Promise.all([
    import('./rosen-node.mjs'),import('./authority-fixture.mjs'),import('./return-authority.mjs'),import('../consumer/rewardPorts.ts'),import('../guard-service/src/event/eventOrder.ts')]);
  const [{DefaultLogger,DummyLogger},{TokenMap},{ErgoChain,ErgoTransaction},{default:ErgoNodeNetwork},{TransactionType}]=await Promise.all([
    load('node_modules/@rosen-bridge/abstract-logger/dist/index.js'),load('node_modules/@rosen-bridge/tokens/dist/index.js'),
    load('packages/chains/ergo/dist/index.js'),load('packages/networks/ergo-node/lib/index.ts'),load('packages/abstract-chain/dist/index.js')]);
  DefaultLogger.init(new DummyLogger());const tokenMap=new TokenMap();
  await tokenMap.updateConfigByJson([{ergo:{tokenId:deployment.tokens.Asset,name:'Local rsXMR',decimals:12,type:'EIP-004',residency:'wrapped',extra:{}},
    monero:{tokenId:'XMR',name:'XMR',decimals:12,type:'native',residency:'native',extra:{}}}]);
  const unavailable=()=>{throw Error('Reward builder cannot sign');};
  const chain=new ErgoChain(new ErgoNodeNetwork({nodeBaseUrl:'http://127.0.0.1:19051',logger:new DummyLogger()}),
    {fee:1100000n,confirmations:{payment:1,cold:1,manual:1,arbitrary:1},addresses:{lock:deployment.contracts.Lock.address,permit:deployment.contracts.Permit.address,fraud:deployment.contracts.Fraud.address,cold:deployment.fundingAddress},
      rwtId:deployment.tokens.RWT,minBoxValue:1000000n,eventTxConfirmation:1},tokenMap,{isInSign:unavailable,sign:unavailable});
  return {wasm,rpc,tree,stateContext,verifyReturnAuthority,captureFeeAuthority:captureWithdrawalFeeAuthority,withRewardPorts,EventOrder,tokenMap,chain,ErgoTransaction,
    rewardType:TransactionType.reward,feeTree:ErgoChain.feeBoxErgoTree};
}

/** Read-only verifier. The payment ID is a binding, never proof of native payout. */
export async function openReturnRewardVerifier(options,trustedPorts){
  const context=returnRewardContext(options),d=context.deployment;
  const binding=canonicalAssignment({profile:'local-return-reward-v1',...context}),policyDigest=hash(binding);
  const api=trustedPorts??await actualPorts(d),configs=returnRewardPolicy(d),{wasm,chain}=api;
  const box=bytes=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(bytes,'hex'));
  const boxHex=raw=>hex(wasm.ErgoBox.from_json(text(raw)));
  const nativeBoxes=rows=>{const result=wasm.ErgoBoxes.empty();rows.forEach(row=>result.add(row));return result;};
  const orderKey=rows=>canonicalAssignment(JSON.parse(text(rows.map(row=>({...row,address:api.tree(row.address)})))));
  for(const name of ['Lock','Permit','EventTrigger','Commitment','GuardSign'])assert.equal(api.tree(d.contracts[name].address),d.contracts[name].tree,'Reward deployment script');
  for(const destination of [configs.bridgeFeeDefaultAddress,configs.networkFeeRepoAddress,...configs.chainBridgeFeeDistribution.ergo.map(row=>row.address)]){
    const script=api.tree(destination);assert(![d.contracts.Lock.tree,d.contracts.Permit.tree,api.feeTree].includes(script),'Reward destination role');
  }
  async function currentInputs(rows){for(const native of rows)assert.equal(boxHex(await api.rpc('/utxo/byId/'+native.box_id().to_str())),hex(native),'Reward input not canonical/unspent');}
  async function noUnmergedCommitments(event,wids){
    // This profile has exactly two deployed watchers, both already merged. Any
    // other event commitment is unsupported, not silently omitted from rewards.
    for(let offset=0;offset<10000;offset+=100){
      const page=await api.rpc('/blockchain/box/unspent/byAddress?offset='+offset+'&limit=100',d.contracts.Commitment.address);
      assert(Array.isArray(page)&&page.length<=100,'Reward commitment page');
      for(const raw of page){
        assert.equal(raw.ergoTree,d.contracts.Commitment.tree,'Reward commitment address query');
        const native=wasm.ErgoBox.from_json(text(raw)),id=native.register_value(5);
        if(!id||Buffer.from(id.to_byte_array()).toString('hex')!==event.eventId)continue;
        const wid=Buffer.from(native.register_value(4).to_byte_array()).toString('hex');
        assert(wids.includes(wid),'Reward unsupported unmerged watcher');
      }
      if(page.length<100)return;
    }
    throw Error('Reward commitment scan exceeded bound');
  }
  async function fresh(){
    const info=await api.rpc('/info');assert.equal(info.network,'devnet');assert.equal(info.appVersion,'6.0.3');assert.equal(info.peersCount,0);
    const authority=await api.verifyReturnAuthority(structuredClone(context));
    const fee=await verifyRetainedWithdrawalFeeAuthority(d,authority.event,context.feeAuthority,api.captureFeeAuthority);
    const feeConfig=Object.fromEntries(Object.entries(fee.feeConfig).map(([key,value])=>[key,decimal(value)]));
    assert.equal(feeConfig.rsnRatio,0n,'Reward nonzero emission profile unsupported');
    const fees=effectiveWithdrawalFees(authority.event,fee.feeConfig);assert(BigInt(fees.networkFee)>0n,'Reward positive network fee');
    await noUnmergedCommitments(authority.event,authority.wids);
    const triggerHex=boxHex(authority.trigger),trigger=box(triggerHex);
    assert.equal(BigInt(authority.event.WIDsCount),BigInt(authority.wids.length));
    assert.equal(trigger.value().as_i64().to_str(),String(BigInt(authority.wids.length)*1000000n),'Reward permit value profile');
    const scope={chain,tokenMap:api.tokenMap,configs,eventBoxes:{
      async getEventBox(id){assert.equal(id,authority.transaction.id);return triggerHex;},
      async getEventValidCommitments(event,count,wids){assert.equal(event.eventId,authority.event.eventId);assert.equal(count,10n);assert.deepEqual(wids,authority.wids);return [];},
    }};
    const order=await api.withRewardPorts(scope,()=>api.EventOrder.createEventRewardOrder(authority.event,authority.transaction.id,feeConfig,context.paymentTxId,authority.wids));
    return {authority,order,triggerHex};
  }
  async function verifyRaw(value){
    const snapshot=structuredClone(compact(value)),tx=wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(snapshot.reducedHex,'hex'));
    const inputs=snapshot.inputHex.map(box),data=snapshot.dataHex.map(box);
    const captured=snapshotCreditSigning(tx,snapshot.requiredSign,inputs,data);
    assert.deepEqual(compact(captured),snapshot,'Reward exact snapshot binding');
    const opened=await fresh(),guard=data[0];assert.equal(data.length,1,'Reward sole guard data input');
    assert.equal(guard.box_id().to_str(),d.guard.boxId,'Reward guard identity');
    const guardJson=JSON.parse(guard.to_json());assert.equal(guardJson.ergoTree,d.contracts.GuardSign.tree,'Reward guard script');
    assert.deepEqual(guardJson.assets,[{tokenId:d.tokens.GuardNFT,amount:1}],'Reward guard NFT');
    assert.deepEqual(guard.register_value(4).to_js().map(key=>Buffer.from(key).toString('hex')),d.guardPublicKeys,'Reward guard keys');
    assert.deepEqual(Array.from(guard.register_value(5).to_i32_array()),[3,3],'Reward guard threshold');
    await currentInputs([...inputs,...data]);
    const triggerId=opened.authority.trigger.boxId,triggers=inputs.filter(input=>input.box_id().to_str()===triggerId);
    assert.equal(triggers.length,1,'Reward sole trigger input');assert.equal(hex(triggers[0]),opened.triggerHex,'Reward exact trigger input');
    for(const input of inputs.filter(input=>input.box_id().to_str()!==triggerId)){
      const raw=JSON.parse(input.to_json());assert.equal(raw.ergoTree,d.contracts.Lock.tree,'Reward funding input script');
      assert(raw.assets.every(asset=>asset.tokenId===d.tokens.Asset),'Reward funding input token');
    }
    const transaction=new api.ErgoTransaction(snapshot.txId,opened.authority.event.eventId,Buffer.from(snapshot.reducedHex,'hex'),api.rewardType,
      snapshot.inputHex.map(bytes=>Buffer.from(bytes,'hex')),snapshot.dataHex.map(bytes=>Buffer.from(bytes,'hex')));
    assert.equal(orderKey(await chain.extractTransactionOrder(transaction)),orderKey(opened.order),'Reward exact extracted order');
    assert(await chain.verifyTransactionFee(transaction),'Reward miner fee');
    verifyCreditOutputs({unsigned:tx.unsigned_tx(),inputs,order:opened.order,lockTree:d.contracts.Lock.tree,feeTree:api.feeTree,assetId:d.tokens.Asset});
    const recomputed=wasm.ReducedTransaction.from_unsigned_tx(tx.unsigned_tx(),nativeBoxes(inputs),nativeBoxes(data),await api.stateContext());
    assert.equal(hex(recomputed),snapshot.reducedHex,'Reward independent reduction');
    const closing=await fresh();
    const stableAuthority=({authority})=>canonicalAssignment({triggerHex:boxHex(authority.trigger),event:authority.event,observation:authority.observation,wids:authority.wids,
      transactionId:authority.transaction.id,blockId:authority.transaction.blockId,inclusionHeight:authority.transaction.inclusionHeight});
    assert.equal(stableAuthority(closing),stableAuthority(opened),'Reward authority changed during verification');
    assert.equal(orderKey(closing.order),orderKey(opened.order),'Reward order changed during verification');await currentInputs([...inputs,...data]);
    return {policyDigest,binding,snapshot,order:structuredClone(opened.order),eventId:opened.authority.event.eventId,triggerBoxId:triggerId,paymentTxId:context.paymentTxId};
  }
  return Object.freeze({verify:verifyRaw,verifyRaw,verifyForGuard:async(index,snapshot)=>{assert(Number.isInteger(index)&&index>=0&&index<4,'Reward guard index');return verifyRaw(snapshot);},
    chain,policyDigest,binding,async inspect(){const opened=await fresh();return structuredClone({order:opened.order,event:opened.authority.event,triggerHex:opened.triggerHex});},
    async create(directory){
      assert(path.isAbsolute(directory));fs.mkdirSync(directory,{recursive:true});const filename=path.join(directory,'reward-candidate.json');let transaction;
      if(fs.existsSync(filename)){const saved=JSON.parse(fs.readFileSync(filename,'utf8'));assert.equal(saved.binding,binding,'Reward retained context conflict');transaction=api.ErgoTransaction.fromJson(saved.transaction);}
      else {const opened=await fresh();const guard=boxHex(await api.rpc('/utxo/byId/'+d.guard.boxId));
        transaction=await chain.generateTransaction(opened.authority.event.eventId,api.rewardType,opened.order,[],[],[opened.triggerHex],[guard]);}
      assert.equal(transaction.txType,api.rewardType);assert.equal(transaction.eventId,context.returnReceipt.observation.requestId);
      const snapshot=compact(snapshotCreditSigning(wasm.ReducedTransaction.sigma_parse_bytes(transaction.txBytes),3,
        transaction.inputBoxes.map(bytes=>box(Buffer.from(bytes).toString('hex'))),transaction.dataInputs.map(bytes=>box(Buffer.from(bytes).toString('hex')))));
      assert.equal(transaction.txId,snapshot.txId);const verified=await verifyRaw(snapshot);
      const record=text({binding,transaction:transaction.toJson()});
      if(!fs.existsSync(filename))retainCreditRecord(filename,record);
      else assert.equal(fs.readFileSync(filename,'utf8'),record,'Reward retained candidate conflict');
      return {transaction,snapshot,order:verified.order,policyDigest,binding,verify:verifyRaw,verifyRaw};
    }});
}

export async function createReturnReward(options,trustedPorts){
  const verifier=await openReturnRewardVerifier(options,trustedPorts);return verifier.create(options.directory);
}
