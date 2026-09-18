import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {config} from '../tools/config.mjs';
import {wasm,rpc,confirmed,tree} from './rosen-node.mjs';
import {stateContext} from './authority-fixture.mjs';
import {createCreditCommittee} from './credit-committee.mjs';
import {snapshotCreditSigning} from '../guard-service/src/deposit/moneroCreditSigner.mjs';
import {verifyCreditOutputs} from './credit-output-policy.mjs';
import {verifyCreditEvent} from './credit-event-policy.mjs';
import {retainCreditRecord,recoverCredit} from './credit-recovery.mjs';
import {canonicalAssignment,committeeConfigDigest} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {makeIndependentDepositProviders,independentlyDecideDeposit} from '../consumer/independentDepositSource.mjs';
import {captureAuthenticatedDepositSource,moneroCreditOrigin} from '../consumer/authenticatedDepositSource.mjs';
import {issueBackingClaim} from '../consumer/backingClaim.mjs';
import {verifyDeliveryMode} from '../consumer/depositDelivery.mjs';
import {captureFreshCreditSource} from './fresh-credit-source.mjs';
import {freshCreditConfigurations} from './credit-custody.mjs';

const require=createRequire(path.join(config.rosenRoot,'package.json'));
const load=relative=>import(pathToFileURL(path.join(config.rosenRoot,relative)).href);
const hex=value=>Buffer.from(value.sigma_serialize_bytes()).toString('hex');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const text=value=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?item.toString():item);
const nativeBox=value=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(value,'hex'));
const boxes=values=>{const result=wasm.ErgoBoxes.empty();values.forEach(v=>result.add(v));return result;};

/** The origin descriptor binds output backing through the unchanged Rosen event. */
export function creditObservation(candidate,source){
  assert.equal(candidate.status,'accepted');assert.equal(candidate.evidenceMode,'independent');assert.equal(candidate.destinationNetwork,'ergo-testnet');
  assert.equal(candidate.retainedAtomicRemainder,0n);assert.equal(candidate.destinationAmount,candidate.netAmount);
  return {sourceTxId:candidate.txid,fromChain:'monero',toChain:'ergo',fromAddress:moneroCreditOrigin(source,candidate),toAddress:candidate.recipient,
    amount:String(candidate.amount),bridgeFee:String(candidate.bridgeFee),networkFee:String(candidate.networkFee),sourceChainTokenId:'XMR',
    targetChainTokenId:candidate.destinationAsset,sourceBlockId:candidate.blockHash,height:Number(candidate.blockHeight),
    requestId:Buffer.from(require('blakejs').blake2b(Buffer.from(candidate.txid),undefined,32)).toString('hex')};
}
export function creditOrder(candidate,deployment,wids){
  assert.equal(wids.length,2);assert.equal(new Set(wids).size,2);
  return [...wids.map(WID=>({address:deployment.contracts.Permit.address,assets:{nativeToken:1000000n,tokens:[{id:deployment.tokens.RWT,value:10n}]},extra:WID})),
    {address:candidate.recipient,assets:{nativeToken:10000000n,tokens:[{id:deployment.tokens.Asset,value:candidate.destinationAmount}]}},
    {address:deployment.fundingAddress,assets:{nativeToken:1000000n,tokens:[{id:deployment.tokens.Asset,value:candidate.bridgeFee+candidate.networkFee}]},extra:''}];
}
const orderKey=order=>text(order.map(row=>({...row,address:tree(row.address)})));

/** Local raw-source -> actual trigger/order/reduction verifier for each guard. */
async function prepareAuthorizedCredit({directory,source,rawRequest,watcherReceipt,deployment,loadRequest,freshAdmission},verifierOnly=false){
  const freshMode=freshAdmission!==undefined;
  let authenticatedSource,freshSource;
  if(!freshMode){
    verifyDeliveryMode(source.context?.configuration?.depositData,loadRequest);
    authenticatedSource=captureAuthenticatedDepositSource(source);
  }
  assert(path.isAbsolute(directory));fs.mkdirSync(directory,{recursive:true});
  const request=freshMode?undefined:structuredClone(rawRequest),receipt=structuredClone(watcherReceipt);
  if(freshMode){
    assert.equal(source,undefined,'Fresh source cannot use legacy source');assert.equal(rawRequest,undefined,'Fresh source cannot use legacy request');
    assert.equal(loadRequest,undefined,'Fresh source cannot use legacy loader');
    freshSource=await captureFreshCreditSource({freshAdmission,watcherReceipt:receipt});
  }
  const d=structuredClone({...deployment,guardSecrets:undefined,watchers:deployment.watchers.map(({secretKey,...watcher})=>watcher)});
  const {DefaultLogger,DummyLogger}=await load('node_modules/@rosen-bridge/abstract-logger/dist/index.js');DefaultLogger.init(new DummyLogger());
  const {TokenMap}=await load('node_modules/@rosen-bridge/tokens/dist/index.js');
  const {ErgoChain,ErgoTransaction}=await load('packages/chains/ergo/dist/index.js');
  const {default:ErgoNodeNetwork}=await load('packages/networks/ergo-node/lib/index.ts');
  const {TransactionType}=await load('packages/abstract-chain/dist/index.js');
  const {DataSource}=await load('node_modules/@rosen-bridge/extended-typeorm/dist/index.js');
  const {default:EventTriggerExtractor}=await load('node_modules/@rosen-bridge/watcher-data-extractor/dist/extractor/eventTriggerExtractor.js');
  const extractor=new EventTriggerExtractor('local-authority',new DataSource({type:'sqlite',database:':memory:'}),'node','',d.contracts.EventTrigger.address,d.tokens.RWT,d.contracts.Permit.address,d.contracts.Fraud.address,undefined,false);
  let configs;
  if(freshMode)configs=freshCreditConfigurations({deployment:d,scope:freshSource.scope,genesis:freshSource.genesis});
  else {
    const policyDigest=hash(canonicalAssignment({profile:'local-four-guard-backed-credit-v1',configuration:source.context.configuration,feePolicy:source.context.feePolicy,
      guardBoxId:d.guard.boxId,tokens:d.tokens,contracts:Object.fromEntries(Object.entries(d.contracts).map(([name,c])=>[name,c.tree]))}));
    const custodyDomain='local-monero-genesis:'+source.publicScan.genesis,activationId='ergo-guard:'+d.guard.boxId,backingPolicy='single-deposit-v1';
    configs=d.guardPublicKeys.map(guardKey=>({custodyDomain,guardKey,committeeKeys:d.guardPublicKeys,quorum:3,maxFaults:1,activationId,policyEpoch:'1',policyDigest,backingPolicy}));
  }
  const {policyDigest,custodyDomain,activationId,backingPolicy}=configs[0];
  const assignmentRequest=(candidate,snapshot,backing)=>({binding:{obligationId:candidate.depositId,creditTransactionDigest:snapshot.digest,sourceIntentDigest:candidate.intentHash,
    triggerBoxId:receipt.trigger.boxId,policyDigest,committeeDigest:committeeConfigDigest(configs[0])},outputs:candidate.outputs.map(o=>({sourceNetwork:candidate.sourceNetwork,publicKey:o.publicKey})),
    backing:freshMode?structuredClone(backing):captureAuthenticatedDepositSource(source).backing});
  const readers=freshMode?freshSource.readers:configs.map((_,i)=>makeIndependentDepositProviders({source,binary:config.observerBinary,sha256:config.observerSha256,runtimeDirectory:config.runtimeDirectory,observerId:'guard-'+i}));
  const runSource=freshMode?freshSource.initial:undefined,runCandidate=freshMode?runSource.decision:source.decision;
  const runObservation=freshMode?runSource.observation:receipt.observation,runBacking=freshMode?runSource.backing:undefined;
  let live=true,committee;
  const network=new ErgoNodeNetwork({nodeBaseUrl:'http://127.0.0.1:19051',logger:new DummyLogger()});
  const chain=new ErgoChain(network,{fee:1100000n,confirmations:{payment:1,cold:1,manual:1,arbitrary:1},addresses:{lock:d.contracts.Lock.address,permit:d.contracts.Permit.address,fraud:d.contracts.Fraud.address,cold:d.fundingAddress},rwtId:d.tokens.RWT,minBoxValue:1000000n,eventTxConfirmation:1},new TokenMap(),{
    isInSign:id=>committee.isInSign(id),sign:(...args)=>committee.sign(...args)});
  async function verifyForGuard(index,snapshot){
    assert(live,'Closed source authority');
    let candidate,expected,backing,freshRead;
    if(freshMode){
      freshRead=await freshSource.read(index);candidate=freshRead.decision;expected=freshRead.observation;backing=freshRead.backing;
    }else{
      authenticatedSource.current();
      const supplied=loadRequest===undefined?request:await loadRequest();
      candidate=await independentlyDecideDeposit({source,rawRequest:supplied,providers:readers[index].providers});
      if(candidate.status!=='accepted')throw Error('Guard source '+candidate.status+':'+candidate.reason);
      expected=creditObservation(candidate,source);
    }
    assert.equal(candidate.destinationAsset,d.tokens.Asset);
    assert.deepEqual(expected,receipt.observation,'Guard source event agreement');
    const tx=wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(snapshot.reducedHex,'hex')),inputs=snapshot.inputHex.map(nativeBox),data=snapshot.dataHex.map(nativeBox);
    assert.equal(snapshot.requiredSign,3);assert.equal(data.length,1);assert.equal(data[0].box_id().to_str(),d.guard.boxId);
    for(const box of [...inputs,...data])assert.equal(hex(box),hex(wasm.ErgoBox.from_json(text(await rpc('/utxo/byId/'+box.box_id().to_str())))),'Input no longer canonical/unspent');
    const guard=JSON.parse(data[0].to_json());assert.equal(guard.ergoTree,d.contracts.GuardSign.tree);
    assert.deepEqual(guard.assets,[{tokenId:d.tokens.GuardNFT,amount:1}]);
    assert.deepEqual(data[0].register_value(4).to_js().map(k=>Buffer.from(k).toString('hex')),d.guardPublicKeys);
    assert.deepEqual(Array.from(data[0].register_value(5).to_i32_array()),[3,3]);
    const triggers=inputs.filter(b=>b.ergo_tree().to_base16_bytes()===d.contracts.EventTrigger.tree);assert.equal(triggers.length,1);
    const trigger=JSON.parse(triggers[0].to_json());assert.equal(trigger.boxId,receipt.trigger.boxId);
    assert.equal(hex(triggers[0]),hex(wasm.ErgoBox.from_json(text(receipt.trigger))));
    const event=extractor.extractBoxData(trigger);verifyCreditEvent(event,expected);
    const wids=receipt.commitments.map(c=>c.WID);assert.deepEqual(wids,d.watchers.map(w=>w.WID));
    assert.equal(Buffer.from(triggers[0].register_value(4).to_byte_array()).toString('hex'),Buffer.from(require('blakejs').blake2b(Buffer.concat(wids.map(w=>Buffer.from(w,'hex'))),undefined,32)).toString('hex'));
    assert.deepEqual(trigger.assets,[{tokenId:d.tokens.RWT,amount:20}]);
    const inclusion=await rpc('/blockchain/transaction/byId/'+receipt.transaction.id);assert(inclusion.numConfirmations>=1);assert(inclusion.outputs.some(b=>b.boxId===trigger.boxId));
    for(const b of inputs.filter(b=>b.box_id().to_str()!==trigger.boxId)){
      const row=JSON.parse(b.to_json());assert.equal(row.ergoTree,d.contracts.Lock.tree);assert(row.assets.every(a=>a.tokenId===d.tokens.Asset));
    }
    const payment=new ErgoTransaction(snapshot.txId,event.eventId,Buffer.from(snapshot.reducedHex,'hex'),TransactionType.payment,snapshot.inputHex.map(h=>Buffer.from(h,'hex')),snapshot.dataHex.map(h=>Buffer.from(h,'hex')));
    assert.equal(orderKey(await chain.extractTransactionOrder(payment)),orderKey(creditOrder(candidate,d,wids)),'Credit recipient/amount/reward order');
    assert(await chain.verifyTransactionFee(payment),'Credit miner fee');
    verifyCreditOutputs({unsigned:tx.unsigned_tx(),inputs,order:creditOrder(candidate,d,wids),lockTree:d.contracts.Lock.tree,feeTree:ErgoChain.feeBoxErgoTree,assetId:d.tokens.Asset});
    const recomputed=wasm.ReducedTransaction.from_unsigned_tx(tx.unsigned_tx(),boxes(inputs),boxes(data),await stateContext());
    assert.equal(hex(recomputed),snapshot.reducedHex,'Independent Ergo reduction');
    if(freshMode)await freshSource.revalidate(index,freshRead);
    else {await source.current();authenticatedSource.current();}
    assert(live,'Closed source authority');
    const assignment=assignmentRequest(candidate,snapshot,backing);
    const assertCurrent=()=>{if(freshMode)freshSource.current();else authenticatedSource.current();assert(live,'Closed source authority');};
    return {assignment,assertCurrent,...(freshMode?{async revalidate(){assertCurrent();const refreshed=await freshSource.revalidate(index,freshRead);assertCurrent();
      return {assignment:assignmentRequest(refreshed.decision,snapshot,refreshed.backing),assertCurrent};}}:{})};
  }
  if(verifierOnly){
    assert(freshMode,'Process verifier requires fresh admission');
    return Object.freeze({verifyForGuard,readers,chain,policyDigest,activationId,custodyDomain,backingPolicy,
      async readBacking(index){assert(live,'Closed source authority');const result=await freshSource.read(index);assert(live,'Closed source authority');return result;},
      configurations:()=>structuredClone(configs),initial:Object.freeze({decision:runCandidate,observation:runObservation,backing:runBacking}),
      expectedAssignment:snapshot=>assignmentRequest(runCandidate,snapshot,runBacking),close(){live=false;}});
  }
  committee=await createCreditCommittee({directory:path.join(directory,'guards'),deployment,verifyForGuard,getStateContext:stateContext,policyDigest,activationId,custodyDomain,backingPolicy,
    ...(freshMode?{contributionPackage:config.contributionPackage}:{})});
  let confirmedAssignment;
  return {verifyForGuard,readers,chain,async close(){live=false;await committee.close();},get counts(){return committee.counts;},checkpoints:()=>committee.checkpoints(),
    backingClaim(){if(freshMode)throw Error('V2 backing withdrawals require a reviewed payout join');authenticatedSource.current();assert(live && confirmedAssignment,'Backing requires confirmed credit');return issueBackingClaim(committee,confirmedAssignment);},
    invalidate:reason=>committee.invalidate(runCandidate.depositId,reason),async run(){
      const file=path.join(directory,'signed-credit.json'),candidateFile=path.join(directory,'candidate.json');
      let record,payment;
      if(fs.existsSync(candidateFile))payment=ErgoTransaction.fromJson(fs.readFileSync(candidateFile,'utf8'));
      else {
        assert(!fs.existsSync(file),'Credit recovery missing candidate');
        const generated=await chain.generateTransaction(runObservation.requestId,TransactionType.payment,creditOrder(runCandidate,d,receipt.commitments.map(c=>c.WID)),[],[],[hex(wasm.ErgoBox.from_json(text(receipt.trigger)))],[hex(wasm.ErgoBox.from_json(text(await rpc('/utxo/byId/'+d.guard.boxId))))]);
        payment=generated;retainCreditRecord(candidateFile,payment.toJson());
      }
      assert.equal(payment.eventId,receipt.observation.requestId);assert.equal(payment.txType,TransactionType.payment);
      const snapshot=snapshotCreditSigning(wasm.ReducedTransaction.sigma_parse_bytes(payment.txBytes),3,payment.inputBoxes.map(b=>nativeBox(Buffer.from(b).toString('hex'))),payment.dataInputs.map(b=>nativeBox(Buffer.from(b).toString('hex'))));
      assert.equal(payment.txId,snapshot.txId);
      if(fs.existsSync(file))record=JSON.parse(fs.readFileSync(file,'utf8'));
      else {
        const signed=await chain.signTransaction(payment,3),native=wasm.Transaction.sigma_parse_bytes(signed.txBytes);
        record={txId:native.id().to_str(),signedHex:hex(native),transaction:JSON.parse(native.to_json()),policyDigest,committee:committee.configurations(),counts:committee.counts};
        retainCreditRecord(file,JSON.stringify(record));
      }
      const result=await recoverCredit({record,snapshot,policyDigest,request:assignmentRequest(runCandidate,snapshot,runBacking),committee,
        validateSigned(row,expected){const native=wasm.Transaction.sigma_parse_bytes(Buffer.from(row.signedHex,'hex'));assert.equal(native.id().to_str(),expected.txId);
          assert.equal(hex(native),hex(wasm.Transaction.from_json(text(row.transaction))));},
        async lookupConfirmed(id){try{const tx=await rpc('/blockchain/transaction/byId/'+id);return tx.numConfirmations>=1?tx:undefined;}catch(error){if(!String(error).includes('404'))throw error;}},
        async verifyFresh(snap,expected){const checks=await Promise.all(configs.map((_,i)=>verifyForGuard(i,snap)));
          for(const check of checks){assert.equal(canonicalAssignment(check.assignment),canonicalAssignment(expected),'Credit recovery obligation');check.assertCurrent();}},
        async submit(row){try{assert.equal(await rpc('/transactions',row.transaction),row.txId);}catch(error){await confirmed(row.txId);}},waitConfirmed:confirmed});
      if(result.status==='confirmed')confirmedAssignment=assignmentRequest(runCandidate,snapshot,runBacking);
      return {...record,...result,checkpoints:committee.checkpoints(),sourceReceipts:freshMode?[]:readers.map(r=>r.receipts())};
    }};
}

export const openAuthorizedCredit=options=>prepareAuthorizedCredit(options);
/** Source, event, payment and reduction checks without creating any signer or ledger. */
export const openCreditVerifier=options=>prepareAuthorizedCredit(options,true);
