import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {createV2WithdrawalAuthorityVerifier} from './v2-withdrawal-authority.mjs';

const h=n=>n.toString(16).padStart(64,'0'),hash=value=>createHash('sha256').update(value).digest('hex');
const bytes=value=>Buffer.from(canonicalAssignment(value)),hex=value=>bytes(value).toString('hex');
const clone=value=>structuredClone(value);
const eventFields=['height','fromChain','toChain','fromAddress','toAddress','amount','bridgeFee','networkFee',
  'sourceChainTokenId','targetChainTokenId','sourceTxId','sourceChainHeight','sourceBlockId','WIDsHash','WIDsCount'];
function fixture(){
  // Representation/transport ports exercise the join, not native serialization,
  // cryptographic signatures or the already separately tested return verifier.
  const unsigned={id:h(30),inputs:[{boxId:h(31),extension:{}}],dataInputs:[],outputs:[
    {ergoTree:'tree:recipient',assets:[{tokenId:h(4),amount:9880}],value:10000000,additionalRegisters:{}}]};
  const sign=(raw,proofs)=>({id:raw.id,inputs:raw.inputs.map((row,i)=>({boxId:row.boxId,spendingProof:{proofBytes:Buffer.from(proofs[i]).toString('hex'),extension:row.extension}})),
    dataInputs:raw.dataInputs,outputs:raw.outputs.map((row,index)=>({...row,boxId:h(40+index),transactionId:raw.id,index}))});
  const serial=raw=>({sigma_serialize_bytes:()=>bytes(raw),to_json:()=>JSON.stringify(raw),id:()=>({to_str:()=>raw.id})});
  const unsignedNative=raw=>({...serial(raw)});
  const signedNative=raw=>{const clean=clone(raw);for(const k of ['numConfirmations','blockId','inclusionHeight'])delete clean[k];
    return {...serial(clean),outputs:()=>({get:i=>({box_id:()=>({to_str:()=>clean.outputs[i].boxId})})})};};
  const wasm={ReducedTransaction:{sigma_parse_bytes:value=>{const raw=JSON.parse(Buffer.from(value));return {unsigned_tx:()=>unsignedNative(raw),raw};}},
    UnsignedTransaction:{from_json:value=>unsignedNative(JSON.parse(value))},
    Transaction:{sigma_parse_bytes:value=>signedNative(JSON.parse(Buffer.from(value))),from_json:value=>signedNative(JSON.parse(value)),
      from_unsigned_tx:(raw,proofs)=>signedNative(sign(JSON.parse(raw.to_json()),proofs))},
    ErgoBox:{sigma_parse_bytes:value=>JSON.parse(Buffer.from(value)),from_json:value=>{const raw=JSON.parse(value);return {
      sigma_serialize_bytes:()=>bytes(raw),box_id:()=>({to_str:()=>raw.boxId})};}}};
  const capture=(reduced,requiredSign,inputBoxes,dataBoxes)=>{assert.equal(requiredSign,3);assert.deepEqual(inputBoxes,[{boxId:h(31)}]);assert.deepEqual(dataBoxes,[]);
    const reducedHex=hex(reduced.raw),inputHex=inputBoxes.map(hex),dataHex=dataBoxes.map(hex);
    return {digest:hash(canonicalAssignment({domain:'rosen-monero-ergo-credit-signing-v1',requiredSign,reducedHex,inputHex,dataHex})),txId:reduced.raw.id,reduced};};
  const snapshot={requiredSign:3,reducedHex:hex(unsigned),inputHex:[hex({boxId:h(31)})],dataHex:[],txId:h(30)};
  snapshot.digest=capture(wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(snapshot.reducedHex,'hex')),3,[{boxId:h(31)}],[]).digest;
  const transaction=sign(unsigned,[Buffer.from('aa','hex')]),credit={txId:h(30),signedHex:hex(transaction),transaction,policyDigest:h(20)};
  const primary={...clone(transaction),numConfirmations:2,blockId:h(32),inclusionHeight:100};
  const backing={version:2,genesis:h(1),committeeDigest:h(2),vaultSpend:h(3),vaultAddress:'vault',intentHash:h(5),txId:h(6),
    blockHash:h(7),blockHeight:4097,outputIndex:1,globalIndex:8888,outputKey:h(8),keyImage:h(9),amountAtomic:'10000',
    destinationNetwork:'ergo-testnet',destinationAsset:h(4),recipient:'recipient',creditedAtomic:'9880'};
  const assignment={binding:{obligationId:'deposit',creditTransactionDigest:snapshot.digest,sourceIntentDigest:backing.intentHash,
    triggerBoxId:h(22),policyDigest:h(20),committeeDigest:h(21)},outputs:[{sourceNetwork:'mainnet',publicKey:h(8)}],backing};
  const redemption={creditTransactionId:credit.txId,creditSignedHex:credit.signedHex,consumedCreditBoxId:h(40),
    creditBoxHex:hex(transaction.outputs[0]),recipientAddress:'recipient',txId:h(50)};
  const terms={moneroTokenId:'XMR',toAddress:'monero-recipient',bridgeFee:'100',networkFee:'20'};
  const event={height:111,fromChain:'ergo',toChain:'monero',fromAddress:'recipient',toAddress:'monero-recipient',amount:'9880',bridgeFee:'100',
    networkFee:'20',sourceChainTokenId:h(4),targetChainTokenId:'XMR',sourceTxId:h(50),sourceChainHeight:109,sourceBlockId:h(51),
    WIDsHash:h(52),WIDsCount:2,eventId:h(53)};
  const trusted={event,transaction:{id:h(54),inclusionHeight:111},trigger:{boxId:h(55)},wids:[h(56),h(57)]};
  const source={event:Object.fromEntries(eventFields.map(k=>[k,String(event[k])])),triggerTransactionId:h(54),triggerBoxId:h(55),wids:[h(56),h(57)]};
  const document={source,profile:{sourceNetwork:'ergo',destinationNetwork:'testnet'},gross:'9880',chargedBridgeFee:'100',chargedNetworkFee:'20',netAtomicAmount:'9760',maxMinerFeeAtomic:'1000000000000'};
  const request={canonicalRequest:JSON.stringify(document),eventId:h(53),instructionDigest:h(58),requestDigest:hash(JSON.stringify(document))};
  const selected={network:'testnet',vaultSpend:h(3),vaultView:h(12),inputs:[{txid:h(6),outputIndex:'1',globalIndex:'8888',publicKey:h(8),amount:'10000'},
    {txid:h(60),outputIndex:'0',globalIndex:'8889',publicKey:h(61),amount:'5000'}]};
  const state={returnCalls:0,creditReads:0,rpcRoutes:[],beforeReturn:()=>{},capturePatch:{},decodePatch:{},info:{network:'devnet',appVersion:'6.0.3',peersCount:0}};
  const input={assignment,snapshot,credit,redemption,terms,deployment:{tokens:{Asset:h(4)}},returnReceipt:{fixture:true},selection:JSON.stringify(selected),request,
    sourceContext:{genesis:h(1),vaultSpend:h(3),vaultAddress:'vault',nativeNetwork:'testnet',sourceNetwork:'ergo',maxMinerFeeAtomic:'1000000000000'}};
  const ports={wasm,snapshotCreditSigning:capture,tree:address=>'tree:'+address,
    rpc:async route=>{state.rpcRoutes.push(route);if(route==='/info')return clone(state.info);assert.equal(route,'/blockchain/transaction/byId/'+h(30));state.creditReads++;return clone(primary);},
    verifyReturnAuthority:async value=>{state.returnCalls++;assert.deepEqual(value,{returnReceipt:input.returnReceipt,redemption:input.redemption,terms:input.terms,deployment:input.deployment});await state.beforeReturn();return clone(trusted);},
    captureRequest:async value=>{const doc=JSON.parse(value.canonicalRequest);assert.equal(value.requestDigest,hash(value.canonicalRequest));return {request:clone(value),eventId:value.eventId,
      requestDigest:value.requestDigest,network:doc.profile.destinationNetwork,sourceNetwork:doc.profile.sourceNetwork,address:'monero-recipient',amount:doc.netAtomicAmount,ceiling:doc.maxMinerFeeAtomic,...state.capturePatch};},
    decodeSelection:value=>({...JSON.parse(value),bytes:value,...state.decodePatch})};
  const verifier=createV2WithdrawalAuthorityVerifier(ports);
  const editRequest=fn=>{const doc=JSON.parse(request.canonicalRequest);fn(doc);request.canonicalRequest=JSON.stringify(doc);request.requestDigest=hash(request.canonicalRequest);};
  const editSelection=fn=>{const value=JSON.parse(input.selection);fn(value);input.selection=JSON.stringify(value);};
  return {input,verifier,ports,state,primary,trusted,editRequest,editSelection};
}
test('binds confirmed credited occurrence, independently verified return and exact native selection/request',async()=>{
  const f=fixture(),result=await f.verifier.verifyWithdrawal(f.input);
  assert.equal(result.creditTransactionId,h(30));assert.equal(result.creditBoxId,h(40));assert.equal(result.redemptionTxId,h(50));
  assert.equal(result.returnTriggerBoxId,h(55));assert.equal(result.eventId,h(53));assert.equal(result.amountAtomic,'9760');
  assert.equal(result.requestDigest,f.input.request.requestDigest);assert.equal(result.selectionDigest,hash(f.input.selection));
  assert.equal(result.assignmentDigest,hash(canonicalAssignment(f.input.assignment)));assert(Object.isFrozen(result));assert.equal(f.state.returnCalls,1);
});
for(const [name,mutate,reason] of [
  ['recomputed snapshot digest',f=>f.input.snapshot.digest=h(99),/V2 credit snapshot digest/],
  ['recomputed snapshot id',f=>f.input.snapshot.txId=h(99),/V2 credit snapshot identity/],
  ['assigned credit digest',f=>f.input.assignment.binding.creditTransactionDigest=h(99),/V2 assigned credit digest/],
  ['credit transaction',f=>f.input.credit.txId=h(99),/V2 credited transaction/],
  ['credit policy',f=>f.input.credit.policyDigest=h(99),/V2 credit policy/],
  ['canonical record bytes',f=>f.input.credit.transaction.outputs[0].value++,/V2 credit record bytes/],
  ['primary bytes',f=>f.primary.outputs[0].value++,/V2 credit primary bytes/],
  ['unconfirmed credit',f=>f.primary.numConfirmations=0,/V2 credit unconfirmed/],
  ['credited amount',f=>f.input.assignment.backing.creditedAtomic='9879',/V2 credited amount/],
  ['missing recipient occurrence',f=>f.input.assignment.backing.recipient='other',/V2 unique credited occurrence/],
  ['genesis',f=>f.input.sourceContext.genesis=h(99),/V2 source genesis/],
  ['vault spend',f=>f.input.sourceContext.vaultSpend=h(99),/V2 source vaultSpend/],
  ['vault address',f=>f.input.sourceContext.vaultAddress='other',/V2 source vaultAddress/],
  ['source intent',f=>f.input.assignment.binding.sourceIntentDigest=h(99),/V2 source intent/],
  ['assigned output',f=>f.input.assignment.outputs[0].publicKey=h(99),/V2 assigned output/],
  ['original credited transaction in redemption',f=>f.input.redemption.creditTransactionId=h(99),/V2 redemption credited transaction/],
  ['original credited bytes in redemption',f=>f.input.redemption.creditSignedHex='ab',/V2 redemption credited bytes/],
  ['exact credited box in redemption',f=>f.input.redemption.consumedCreditBoxId=h(99),/V2 redemption credited box/],
  ['exact credited box bytes',f=>f.input.redemption.creditBoxHex='ab',/V2 redemption credited box bytes/],
  ['credit owner in redemption',f=>f.input.redemption.recipientAddress='other',/V2 redemption owner/],
  ['redemption source transaction',f=>f.trusted.event.sourceTxId=h(99),/V2 redemption source transaction/],
  ['return amount',f=>f.trusted.event.amount='9879',/V2 return credited amount/],
  ['return destination',f=>f.trusted.event.toAddress='other',/V2 return destination/],
  ['return owner',f=>f.trusted.event.fromAddress='other',/V2 return owner/],
  ['return bridge fee',f=>f.trusted.event.bridgeFee='101',/V2 return bridge fee/],
  ['return network fee',f=>f.trusted.event.networkFee='21',/V2 return network fee/],
  ['event id',f=>f.input.request.eventId=h(99),/V2 withdrawal event/],
  ['native recipient',f=>f.state.capturePatch.address='other',/V2 payout recipient/],
  ['native amount',f=>f.state.capturePatch.amount='9759',/V2 payout amount/],
  ['native network',f=>f.state.capturePatch.network='mainnet',/V2 payout network/],
  ['native source network',f=>f.state.capturePatch.sourceNetwork='different',/V2 payout source network/],
  ['native miner ceiling',f=>f.state.capturePatch.ceiling='1000000000001',/V2 payout miner ceiling/],
  ['selection network',f=>f.editSelection(v=>v.network='mainnet'),/V2 selection network/],
  ['selection vault',f=>f.editSelection(v=>v.vaultSpend=h(99)),/V2 selection vault/],
  ['selection input count',f=>f.editSelection(v=>v.inputs.pop()),/V2 selection input count/],
  ['missing credited output',f=>f.editSelection(v=>v.inputs[0].publicKey=h(99)),/V2 selected credited occurrence/],
  ['duplicated credited output',f=>f.editSelection(v=>v.inputs[1].publicKey=v.inputs[0].publicKey),/V2 selected credited occurrence/],
  ['same-key different transaction',f=>f.editSelection(v=>v.inputs[0].txid=h(99)),/V2 selected backing txid/],
  ['same-key different output index',f=>f.editSelection(v=>v.inputs[0].outputIndex='2'),/V2 selected backing outputIndex/],
  ['same-key different global index',f=>f.editSelection(v=>v.inputs[0].globalIndex='9999'),/V2 selected backing globalIndex/],
  ['same-key different amount',f=>f.editSelection(v=>v.inputs[0].amount='10001'),/V2 selected backing amount/],
  ['replaced credit block during return verification',f=>f.state.beforeReturn=()=>{f.primary.blockId=h(99);},/V2 credit canonical block changed/],
  ['replaced credit height during return verification',f=>f.state.beforeReturn=()=>{f.primary.inclusionHeight++;},/V2 credit canonical height changed/],
  ['local isolation lost',f=>f.state.beforeReturn=()=>{f.state.info.peersCount=1;},/Assertion/],
])test('refuses '+name,async()=>{const f=fixture();mutate(f);await assert.rejects(f.verifier.verifyWithdrawal(f.input),reason);});
for(const field of eventFields)test('binds request source '+field+' despite a recomputed request digest',async()=>{
  const f=fixture();f.editRequest(doc=>{doc.source.event[field]='changed';});
  await assert.rejects(f.verifier.verifyWithdrawal(f.input),/V2 withdrawal complete source/);
});
for(const field of ['triggerTransactionId','triggerBoxId','wids'])test('binds request '+field,async()=>{
  const f=fixture();f.editRequest(doc=>{doc.source[field]=field==='wids'?[h(90),h(91)]:h(90);});
  await assert.rejects(f.verifier.verifyWithdrawal(f.input),/V2 withdrawal complete source/);
});
for(const [field,reason] of [['gross',/V2 payout gross/],['chargedBridgeFee',/V2 payout bridge fee/],['chargedNetworkFee',/V2 payout network fee/]])
  test('binds '+field+' despite coordinated request rehash',async()=>{
    const f=fixture();f.editRequest(doc=>{doc[field]=String(BigInt(doc[field])+1n);});await assert.rejects(f.verifier.verifyWithdrawal(f.input),reason);
  });
test('an internally consistent signed credit must still match the originally assigned unsigned credit',async()=>{
  const f=fixture();f.input.credit.transaction.outputs[0].value++;f.input.credit.signedHex=hex(f.input.credit.transaction);
  Object.assign(f.primary,clone(f.input.credit.transaction));f.input.redemption.creditSignedHex=f.input.credit.signedHex;
  await assert.rejects(f.verifier.verifyWithdrawal(f.input),/V2 signed\/unsigned credit binding/);
});
test('a decoded selection object cannot override its retained bytes',async()=>{
  const f=fixture();f.input.selection={bytes:f.input.selection,network:'mainnet',inputs:[]};
  assert.equal((await f.verifier.verifyWithdrawal(f.input)).amountAtomic,'9760');
});
test('retained credit observation does not recreate withdrawal authority or read consumed inputs',async()=>{
  const f=fixture();delete f.input.request;delete f.input.selection;delete f.input.redemption;delete f.input.returnReceipt;
  const result=await f.verifier.verifyRetainedCredit(f.input);
  assert.deepEqual(Object.keys(result).sort(),['assignmentDigest','creditBoxId','creditTransactionId']);assert(Object.isFrozen(result));
  assert.equal(f.state.returnCalls,0);assert(f.state.rpcRoutes.every(route=>route==='/info'||route.startsWith('/blockchain/transaction/byId/')));
  await assert.rejects(f.verifier.verifyWithdrawal(f.input));
});
test('a mode field cannot bypass fresh return authorization',async()=>{
  const f=fixture();f.input.mode='recovery';f.state.beforeReturn=()=>{throw Error('return trigger spent');};
  await assert.rejects(f.verifier.verifyWithdrawal(f.input),/return trigger spent/);assert.equal(f.state.returnCalls,1);
});
test('retained credit observation still rejects changed credit identity',async()=>{
  const f=fixture();f.input.assignment.binding.creditTransactionDigest=h(99);
  await assert.rejects(f.verifier.verifyRetainedCredit(f.input),/V2 assigned credit digest/);
});
test('real WASM and snapshot capture reproduce exact historical credit bytes without live UTXO reads',async()=>{
  const wasm=await import('ergo-lib-wasm-nodejs'),{readFileSync}=await import('node:fs');
  const {snapshotCreditSigning}=await import('../guard-service/src/deposit/moneroCreditSigner.mjs');
  const raw=JSON.parse(readFileSync(new URL('../guard-service/src/deposit/fixtures/credit-signing.json',import.meta.url),'utf8'));
  const reduced=wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(raw.txBytes,'hex'));
  const boxes=values=>values.map(value=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(value,'hex')));
  const captured=snapshotCreditSigning(reduced,3,boxes(raw.inputBoxes),boxes(raw.dataInputs));
  // Empty proofs exercise serialization only; mocked primary inclusion below
  // does not establish valid signatures or an actual on-chain credit.
  const unsigned=captured.reduced.unsigned_tx(),unsignedJson=JSON.parse(unsigned.to_json());
  const signed=wasm.Transaction.from_unsigned_tx(unsigned,unsignedJson.inputs.map(()=>new Uint8Array()));
  const transaction=JSON.parse(signed.to_json()),creditBox=transaction.outputs.find(row=>row.assets.length===1);
  assert(creditBox);const f=fixture();
  f.input.snapshot=Object.fromEntries(['digest','txId','reducedHex','requiredSign','inputHex','dataHex'].map(k=>[k,captured[k]]));
  f.input.credit={txId:captured.txId,signedHex:Buffer.from(signed.sigma_serialize_bytes()).toString('hex'),transaction,policyDigest:h(20)};
  f.input.assignment.binding.creditTransactionDigest=captured.digest;
  f.input.assignment.backing.destinationAsset=creditBox.assets[0].tokenId;f.input.assignment.backing.creditedAtomic=String(creditBox.assets[0].amount);
  f.input.deployment.tokens.Asset=creditBox.assets[0].tokenId;
  const verifier=createV2WithdrawalAuthorityVerifier({...f.ports,wasm,snapshotCreditSigning,tree:()=>creditBox.ergoTree,
    rpc:async route=>{if(route==='/info')return f.state.info;assert.equal(route,'/blockchain/transaction/byId/'+captured.txId);
      return {...transaction,numConfirmations:1,blockId:h(32),inclusionHeight:966001};}});
  const found=await verifier.verifyRetainedCredit(f.input);assert.equal(found.creditBoxId,creditBox.boxId);assert.equal(found.creditTransactionId,captured.txId);
});
