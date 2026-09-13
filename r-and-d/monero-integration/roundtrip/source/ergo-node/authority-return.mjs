import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {canonicalAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {retainCreditRecord} from './credit-recovery.mjs';

const text=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v);
const hex=value=>Buffer.from(value.sigma_serialize_bytes()).toString('hex');
/** from_unsigned_tx consumes its native input; policy inspection owns a clone. */
export function projectUnsignedReturn(wasm,unsigned) {
  const json=unsigned.to_json(),clone=wasm.UnsignedTransaction.from_json(json);
  return JSON.parse(wasm.Transaction.from_unsigned_tx(clone,JSON.parse(json).inputs.map(()=>new Uint8Array())).to_json());
}
export function validateReturnTerms(terms) {
  assert(terms && Object.getPrototypeOf(terms)===Object.prototype);
  assert.equal(Object.keys(terms).sort().join(','),'bridgeFee,moneroTokenId,networkFee,toAddress');
  assert.equal(terms.moneroTokenId,'XMR');
  for(const key of ['bridgeFee','networkFee']){
    assert.match(terms[key],/^(0|[1-9][0-9]{0,19})$/);assert(BigInt(terms[key])<1n<<64n);
  }
  assert(typeof terms.toAddress==='string' && terms.toAddress.length>0 && terms.toAddress.length<=256 && /^[!-~]+$/.test(terms.toAddress));
}
export function verifyReturnShape({transaction,creditBox,deployment,terms,recipientAddress,recipientTree,feeTree,registerR4}) {
  validateReturnTerms(terms);assert.equal(transaction.inputs.length,1);
  assert.equal(transaction.inputs[0].boxId,creditBox.boxId);assert.deepEqual(transaction.dataInputs,[]);
  assert.deepEqual(transaction.inputs[0].spendingProof?.extension??{},{});
  assert.equal(creditBox.ergoTree,recipientTree);assert.equal(creditBox.assets.length,1);
  assert.equal(creditBox.assets[0].tokenId,deployment.tokens.Asset);
  const amount=BigInt(creditBox.assets[0].amount);assert(amount>BigInt(terms.bridgeFee)+BigInt(terms.networkFee));
  assert.equal(transaction.outputs.length,2);
  const [lock,miner]=transaction.outputs;
  assert.equal(lock.ergoTree,deployment.contracts.Lock.tree);
  assert.equal(BigInt(lock.value),BigInt(creditBox.value)-1100000n);assert(BigInt(lock.value)>=1000000n);
  assert.equal(lock.assets.length,1);assert.equal(lock.assets[0].tokenId,deployment.tokens.Asset);assert.equal(BigInt(lock.assets[0].amount),amount);
  assert.deepEqual(lock.additionalRegisters,{R4:registerR4});
  assert.equal(miner.ergoTree,feeTree);assert.equal(BigInt(miner.value),1100000n);assert.deepEqual(miner.assets,[]);assert.deepEqual(miner.additionalRegisters,{});
  assert(typeof recipientAddress==='string' && recipientAddress.length>0);
  return amount;
}
async function io(publicRecipient) {
  const {config}=await import('../tools/config.mjs');
  const services=await import('./rosen-node.mjs');
  let recipientAddress=publicRecipient;
  if(recipientAddress===undefined){
    assert(fs.existsSync(path.join(config.ergoRuntime,'recipient-private.json')),'Missing recipient custody');
    recipientAddress=services.recipient();
  }
  assert(typeof recipientAddress==='string' && recipientAddress.length>0);services.tree(recipientAddress);
  const require=createRequire(path.join(config.rosenRoot,'package.json'));
  const load=relative=>import(pathToFileURL(path.join(config.rosenRoot,relative)).href);
  const {ErgoChain}=await load('packages/chains/ergo/dist/index.js');
  const {TokenMap}=await import(pathToFileURL(require.resolve('@rosen-bridge/tokens')));
  const {ErgoNodeRosenExtractor}=await load('node_modules/@rosen-bridge/rosen-extractor/dist/getRosenData/ergo/ergoNodeRosenExtractor.js');
  const {blake2b}=require('blakejs');
  const context=async()=>{const headers=services.wasm.BlockHeaders.from_json((await services.rpc('/blocks/lastHeaders/10')).map(JSON.stringify));return new services.wasm.ErgoStateContext(services.wasm.PreHeader.from_block_header(headers.get(0)),headers);};
  return {...services,config,recipientAddress,context,TokenMap,ErgoNodeRosenExtractor,blake2b,feeTree:ErgoChain.feeBoxErgoTree};
}
async function local(api) {const info=await api.rpc('/info');assert.equal(info.network,'devnet');assert.equal(info.appVersion,'6.0.3');assert.equal(info.peersCount,0);return info;}
function deploymentCheck(d,api) {
  assert.equal(d.threshold,3);assert.equal(d.guardPublicKeys.length,4);assert.equal(new Set(d.guardPublicKeys).size,4);
  assert.equal(api.tree(d.contracts.Lock.address),d.contracts.Lock.tree);assert.match(d.tokens.Asset,/^[0-9a-f]{64}$/);
}
function parity(api,raw,signedHex) {const native=api.wasm.Transaction.sigma_parse_bytes(Buffer.from(signedHex,'hex'));assert.equal(hex(native),hex(api.wasm.Transaction.from_json(text(raw))));return native;}
async function primary(api,id,signedHex) {
  const found=await api.rpc('/blockchain/transaction/byId/'+id);assert.equal(found.id,id);assert(found.numConfirmations>=1);
  assert.match(found.blockId,/^[0-9a-f]{64}$/);assert(Number.isSafeInteger(found.inclusionHeight) && found.inclusionHeight>=0);
  parity(api,found,signedHex);return found;
}
function r4(api,terms) {return api.wasm.Constant.from_coll_coll_byte(['monero',terms.toAddress,terms.networkFee,terms.bridgeFee,api.recipientAddress].map(s=>Buffer.from(s))).encode_to_base16();}
function shape(api,transaction,creditBox,deployment,terms) {return verifyReturnShape({transaction,creditBox,deployment,terms,recipientAddress:api.recipientAddress,recipientTree:api.tree(api.recipientAddress),feeTree:api.feeTree,registerR4:r4(api,terms)});}
function retain(file,body) {const stat=fs.statfsSync(path.dirname(file));assert(stat.bavail*stat.bsize>=40*1024**3,'Insufficient custody headroom');retainCreditRecord(file,text(body));}

/** Independent primary-chain observation; receipt bytes are claims until rechecked. */
export async function observeRedemption({receipt,deployment,terms}) {
  validateReturnTerms(terms);assert(typeof receipt.recipientAddress==='string');
  const api=await io(receipt.recipientAddress);deploymentCheck(deployment,api);await local(api);
  assert.equal(receipt.status,'confirmed');
  const credit=await primary(api,receipt.creditTransactionId,receipt.creditSignedHex);
  const nativeCredit=parity(api,credit,receipt.creditSignedHex);
  const creditBox=credit.outputs.find(box=>box.boxId===receipt.consumedCreditBoxId);assert(creditBox);
  assert.equal(hex(api.wasm.ErgoBox.from_json(text(creditBox))),receipt.creditBoxHex);
  assert(nativeCredit.outputs().get(credit.outputs.indexOf(creditBox)).box_id().to_str()===creditBox.boxId);
  const transaction=await primary(api,receipt.txId,receipt.signedHex);const native=parity(api,transaction,receipt.signedHex);
  const quantity=shape(api,transaction,creditBox,deployment,terms);
  const inputs=api.wasm.ErgoBoxes.empty();inputs.add(api.wasm.ErgoBox.from_json(text(creditBox)));
  assert(api.wasm.verify_tx_input_proof(0,await api.context(),native,inputs,api.wasm.ErgoBoxes.empty()),'Redemption recipient proof');
  let spent=false;try{await api.rpc('/utxo/byId/'+creditBox.boxId);}catch(error){if(String(error).includes('404'))spent=true;else throw error;}assert(spent,'Confirmed redemption input remains unspent');
  const map=new api.TokenMap();await map.updateConfigByJson([{ergo:{tokenId:deployment.tokens.Asset,name:'Local rsXMR',decimals:12,type:'EIP-004',residency:'wrapped',extra:{}},monero:{tokenId:'XMR',name:'XMR',decimals:12,type:'native',residency:'native',extra:{}}}]);
  const extracted=new api.ErgoNodeRosenExtractor(deployment.contracts.Lock.address,map).extractData(transaction);assert(extracted);
  assert.equal(extracted.sourceTxId,transaction.id);assert.equal(extracted.amount,String(quantity));assert.equal(extracted.toAddress,terms.toAddress);
  assert.equal(extracted.fromAddress,api.recipientAddress);assert.equal(extracted.bridgeFee,terms.bridgeFee);assert.equal(extracted.networkFee,terms.networkFee);
  assert.equal(extracted.sourceChainTokenId,deployment.tokens.Asset);assert.equal(extracted.targetChainTokenId,'XMR');
  const closing=await primary(api,receipt.txId,receipt.signedHex);assert.equal(closing.blockId,transaction.blockId);assert.equal(closing.inclusionHeight,transaction.inclusionHeight);
  const closingCredit=await primary(api,receipt.creditTransactionId,receipt.creditSignedHex);assert.equal(closingCredit.blockId,credit.blockId);await local(api);
  return {fromChain:'ergo',toChain:'monero',fromAddress:extracted.fromAddress,toAddress:extracted.toAddress,amount:extracted.amount,
    bridgeFee:extracted.bridgeFee,networkFee:extracted.networkFee,sourceChainTokenId:extracted.sourceChainTokenId,targetChainTokenId:extracted.targetChainTokenId,
    sourceTxId:transaction.id,sourceBlockId:transaction.blockId,height:transaction.inclusionHeight,
    requestId:Buffer.from(api.blake2b(Buffer.from(transaction.id,'utf8'),undefined,32)).toString('hex')};
}

/** Recipient-only spending of one already-confirmed authorized local credit. */
export async function redeemAuthorizedCredit({directory,authorized,deployment,terms}) {
  assert(path.isAbsolute(directory));validateReturnTerms(terms);assert.equal(authorized.status,'confirmed');
  const api=await io();deploymentCheck(deployment,api);await local(api);
  assert.equal(authorized.txId,authorized.transaction.id);parity(api,authorized.transaction,authorized.signedHex);
  const credit=await primary(api,authorized.txId,authorized.signedHex);
  const choices=credit.outputs.filter(box=>box.ergoTree===api.tree(api.recipientAddress) && box.assets.length===1 && box.assets[0].tokenId===deployment.tokens.Asset);
  assert.equal(choices.length,1,'Unique authorized recipient credit');const creditBox=choices[0];
  if(authorized.box)assert.equal(hex(api.wasm.ErgoBox.from_json(text(authorized.box))),hex(api.wasm.ErgoBox.from_json(text(creditBox))));
  const binding=canonicalAssignment({creditTransactionId:credit.id,creditBoxHex:hex(api.wasm.ErgoBox.from_json(text(creditBox))),
    creditSignedHex:authorized.signedHex,recipient:api.recipientAddress,terms,lockTree:deployment.contracts.Lock.tree,assetId:deployment.tokens.Asset,
    policyDigest:authorized.policyDigest,guardPublicKeys:deployment.guardPublicKeys});
  fs.mkdirSync(directory,{recursive:true});const candidateFile=path.join(directory,'redemption-candidate.json'),signedFile=path.join(directory,'redemption-signed.json');
  let candidate;
  if(fs.existsSync(candidateFile)) {candidate=JSON.parse(fs.readFileSync(candidateFile,'utf8'));assert.equal(candidate.binding,binding);}
  else {
    const live=await api.rpc('/utxo/byId/'+creditBox.boxId);assert.equal(hex(api.wasm.ErgoBox.from_json(text(live))),hex(api.wasm.ErgoBox.from_json(text(creditBox))));
    const wasm=api.wasm,quantity=BigInt(creditBox.assets[0].amount);assert(quantity>BigInt(terms.bridgeFee)+BigInt(terms.networkFee));
    const boxes=wasm.ErgoBoxes.empty();boxes.add(wasm.ErgoBox.from_json(text(live)));const value=n=>wasm.BoxValue.from_i64(wasm.I64.from_str(String(n)));
    const height=(await local(api)).fullHeight;
    const builder=new wasm.ErgoBoxCandidateBuilder(value(BigInt(live.value)-1100000n),wasm.Contract.pay_to_address(wasm.Address.from_base58(deployment.contracts.Lock.address)),height);
    builder.add_token(wasm.TokenId.from_str(deployment.tokens.Asset),wasm.TokenAmount.from_i64(wasm.I64.from_str(String(quantity))));builder.set_register_value(4,wasm.Constant.decode_from_base16(r4(api,terms)));
    const outputs=wasm.ErgoBoxCandidates.empty();outputs.add(builder.build());const tokens=new wasm.Tokens();tokens.add(new wasm.Token(wasm.TokenId.from_str(deployment.tokens.Asset),wasm.TokenAmount.from_i64(wasm.I64.from_str(String(quantity)))));
    const selection=new wasm.SimpleBoxSelector().select(boxes,value(live.value),tokens);
    const unsigned=wasm.TxBuilder.new(selection,outputs,height,value(1100000),wasm.Address.from_base58(api.recipientAddress)).build();
    candidate={binding,unsigned:JSON.parse(unsigned.to_json()),txId:unsigned.id().to_str(),creditBoxHex:hex(wasm.ErgoBox.from_json(text(creditBox)))};retain(candidateFile,candidate);
  }
  let record;
  if(fs.existsSync(signedFile)) {record=JSON.parse(fs.readFileSync(signedFile,'utf8'));assert.equal(record.binding,binding);}
  else {
    const wasm=api.wasm,unsigned=wasm.UnsignedTransaction.from_json(text(candidate.unsigned));assert.equal(unsigned.id().to_str(),candidate.txId);
    shape(api,projectUnsignedReturn(wasm,unsigned),creditBox,deployment,terms);
    const live=await api.rpc('/utxo/byId/'+creditBox.boxId);assert.equal(hex(wasm.ErgoBox.from_json(text(live))),candidate.creditBoxHex);
    const key=wasm.SecretKey.dlog_from_bytes(Buffer.from(JSON.parse(fs.readFileSync(path.join(api.config.ergoRuntime,'recipient-private.json'),'utf8')).key,'hex'));
    assert.equal(key.get_address().to_ergo_tree().to_base16_bytes(),creditBox.ergoTree);
    const keys=new wasm.SecretKeys();keys.add(key);const inputs=wasm.ErgoBoxes.empty();inputs.add(wasm.ErgoBox.from_json(text(live)));const context=await api.context();
    const native=wasm.Wallet.from_secrets(keys).sign_transaction(context,unsigned,inputs,wasm.ErgoBoxes.empty());assert.equal(native.id().to_str(),candidate.txId);
    assert(wasm.verify_tx_input_proof(0,context,native,inputs,wasm.ErgoBoxes.empty()));shape(api,JSON.parse(native.to_json()),creditBox,deployment,terms);
    record={binding,txId:native.id().to_str(),signedHex:hex(native),transaction:JSON.parse(native.to_json()),creditTransactionId:credit.id,
      creditSignedHex:authorized.signedHex,consumedCreditBoxId:creditBox.boxId,creditBoxHex:candidate.creditBoxHex,recipientAddress:api.recipientAddress};retain(signedFile,record);
  }
  assert.equal(record.txId,candidate.txId);assert.equal(record.creditBoxHex,hex(api.wasm.ErgoBox.from_json(text(creditBox))));
  assert.equal(record.creditTransactionId,credit.id);assert.equal(record.creditSignedHex,authorized.signedHex);assert.equal(record.consumedCreditBoxId,creditBox.boxId);
  assert.equal(record.recipientAddress,api.recipientAddress);
  const native=parity(api,record.transaction,record.signedHex);assert.equal(native.id().to_str(),record.txId);shape(api,record.transaction,creditBox,deployment,terms);
  const inputBoxes=api.wasm.ErgoBoxes.empty();inputBoxes.add(api.wasm.ErgoBox.from_json(text(creditBox)));
  assert(api.wasm.verify_tx_input_proof(0,await api.context(),native,inputBoxes,api.wasm.ErgoBoxes.empty()));
  let found;try{found=await primary(api,record.txId,record.signedHex);}catch(error){if(!String(error).includes('404'))throw error;}
  if(!found){await local(api);try{assert.equal(await api.rpc('/transactions',record.transaction),record.txId);}catch{await api.confirmed(record.txId);}found=await api.confirmed(record.txId);}
  const receipt={...record,status:'confirmed',transaction:found};const observation=await observeRedemption({receipt,deployment,terms});
  const receiptFile=path.join(directory,'redemption-receipt.json');if(!fs.existsSync(receiptFile))retain(receiptFile,{...receipt,observation});
  return {...receipt,observation};
}
