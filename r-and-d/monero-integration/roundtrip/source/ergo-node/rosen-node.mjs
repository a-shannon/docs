import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(config.rosenRoot+'/package.json');
export const wasm = require('ergo-lib-wasm-nodejs');
const { blake2b } = require('@noble/hashes/blake2b');
export const root = sourceRoot;
export const runtime = config.ergoRuntime;
const apiKey = JSON.parse(fs.readFileSync(runtime+'/api-private.json')).apiKey;
export const save = (name,value) => fs.writeFileSync(runtime+'/'+name,JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2),{flag:'wx'});
export async function rpc(route,body) {
  const r=await fetch('http://127.0.0.1:19051'+route,{signal:AbortSignal.timeout(15000),method:body===undefined?'GET':'POST',headers:{api_key:apiKey,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!r.ok) throw new Error(`Ergo HTTP ${r.status} at ${route}: ${(await r.text()).slice(0,400)}`);
  return r.json();
}
export async function confirmed(id) {
  for(let i=0;i<100;i++) {try {const tx=await rpc('/blockchain/transaction/byId/'+id);if(tx.numConfirmations>0)return tx;}catch(e){if(!String(e).includes('404'))throw e;} await new Promise(r=>setTimeout(r,200));}
  throw Error('Confirmation timeout '+id);
}
export const tree = address => wasm.Address.from_base58(address).to_ergo_tree().to_base16_bytes();
export const digest = hex => Buffer.from(blake2b(Buffer.from(hex,'hex'),{dkLen:32})).toString('hex');
export function recipient() {
  const filename=runtime+'/recipient-private.json';
  const key=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename)).key:crypto.randomBytes(32).toString('hex');
  if(!fs.existsSync(filename))save('recipient-private.json',{key});
  return wasm.SecretKey.dlog_from_bytes(Buffer.from(key,'hex')).get_address().to_base58(wasm.NetworkPrefix.Testnet);
}
export async function sendRequests(requests) {
  const tx=await rpc('/wallet/transaction/generate',{requests,fee:1100000});
  const id=await rpc('/transactions',tx);
  assert.equal(id,tx.id);
  return confirmed(id);
}
async function compile(name,params) {
  let source=fs.readFileSync(root+'/ergo-node/contracts/'+name+'.es','utf8');
  for(const [k,v] of Object.entries(params))source=source.replaceAll(k,v);
  assert(!/"[A-Z_]+"/.test(source),'Unresolved contract parameter');
  const result=await rpc('/script/p2sAddress',{source,treeVersion:0});
  return {address:result.address,tree:tree(result.address),sourceSha256:crypto.createHash('sha256').update(source).digest('hex')};
}
const b64 = hex => Buffer.from(hex,'hex').toString('base64');
export async function deploy() {
  assert.equal((await rpc('/info')).network,'devnet');
  assert(!fs.existsSync(runtime+'/rosen-deployment.json'),'Existing deployment');
  const wallet=await rpc('/wallet/status');
  const tokens={};
  for(const [name,amount] of Object.entries({GuardNFT:1,CleanupNFT:1,RWTRepoNFT:1,RepoConfigNFT:1,RWT:1000000,Asset:1000000000,WID:1})) {
    const file='issued-'+name+'.json';
    const receipt=fs.existsSync(runtime+'/'+file)?JSON.parse(fs.readFileSync(runtime+'/'+file)):await sendRequests([{address:wallet.changeAddress,ergValue:10000000,amount,name:'Local '+name,description:'Isolated Rosen integration fixture',decimals:0}]);
    const output=receipt.outputs.find(o=>o.assets.some(a=>a.tokenId===receipt.inputs[0].boxId));
    assert(output,'Minted token must equal first input box ID');
    tokens[name]=receipt.inputs[0].boxId;
    if(!fs.existsSync(runtime+'/'+file))save(file,receipt);
    console.log(JSON.stringify({stage:'issued',name,tokenId:tokens[name]}));
  }
  const contracts={};
  contracts.GuardSign=await compile('GuardSign',{});
  contracts.Lock=await compile('Lock',{GUARD_NFT:b64(tokens.GuardNFT)});
  contracts.Fraud=await compile('Fraud',{RWT_REPO_NFT:b64(tokens.RWTRepoNFT),CLEANUP_NFT:b64(tokens.CleanupNFT)});
  contracts.EventTrigger=await compile('EventTrigger',{CLEANUP_NFT:b64(tokens.CleanupNFT),CLEANUP_CONFIRMATION:'720',LOCK_SCRIPT_HASH:b64(digest(contracts.Lock.tree)),FRAUD_SCRIPT_HASH:b64(digest(contracts.Fraud.tree))});
  contracts.Commitment=await compile('Commitment',{EVENT_TRIGGER_SCRIPT_HASH:b64(digest(contracts.EventTrigger.tree)),RWT_REPO_NFT:b64(tokens.RWTRepoNFT),REPO_CONFIG_NFT:b64(tokens.RepoConfigNFT)});
  contracts.Permit=await compile('Permit',{RWT_REPO_NFT:b64(tokens.RWTRepoNFT),COMMITMENT_SCRIPT_HASH:b64(digest(contracts.Commitment.tree))});
  const keyFile=runtime+'/rosen-keys-private.json';
  const keys=fs.existsSync(keyFile)?JSON.parse(fs.readFileSync(keyFile)):Array.from({length:3},()=>crypto.randomBytes(32).toString('hex'));
  if(!fs.existsSync(keyFile))save('rosen-keys-private.json',keys);
  const pubkeys=keys.map(k=>{const ec=crypto.createECDH('secp256k1');ec.setPrivateKey(Buffer.from(k,'hex'));return ec.getPublicKey(undefined,'compressed');});
  const r4=wasm.Constant.from_coll_coll_byte(pubkeys).encode_to_base16();
  const r5=wasm.Constant.from_i32_array(Int32Array.from([2,2])).encode_to_base16();
  const tx=await sendRequests([
    {address:contracts.GuardSign.address,value:10000000,assets:[{tokenId:tokens.GuardNFT,amount:1}],registers:{R4:r4,R5:r5}},
    {address:contracts.Lock.address,value:1000000000,assets:[{tokenId:tokens.Asset,amount:1000000000}]}
  ]);
  const guard=tx.outputs.find(o=>o.ergoTree===contracts.GuardSign.tree);
  const lock=tx.outputs.find(o=>o.ergoTree===contracts.Lock.tree);
  assert(guard&&lock);
  const deployment={tokens,contracts,guard,lock,transactionId:tx.id,fundingAddress:wallet.changeAddress,threshold:2,guardPublicKeys:pubkeys.map(b=>b.toString('hex')),sourceCommit:'1b892c43f2d45eb6916f35e2edbb7560a4569f8e'};
  save('rosen-deployment.json',deployment);
  return deployment;
}
export async function credit(observation,label) {
  assert.match(label,/^[a-z0-9-]+$/);
  assert(!fs.existsSync(runtime+'/credit-'+label+'.json'),'Existing credit receipt');
  const d=JSON.parse(fs.readFileSync(runtime+'/rosen-deployment.json'));
  assert.equal(observation.fromChain,'monero');assert.equal(observation.toChain,'ergo');
  assert.equal(observation.targetChainTokenId,d.tokens.Asset);
  for(const field of ['amount','bridgeFee','networkFee'])assert.match(observation[field],/^(0|[1-9][0-9]*)$/);
  assert.match(observation.sourceTxId,/^[0-9a-f]{64}$/);assert.match(observation.sourceBlockId,/^[0-9a-f]{64}$/);
  assert(Number.isSafeInteger(observation.height)&&observation.height>=0);
  const amount=BigInt(observation.amount),fee=BigInt(observation.bridgeFee)+BigInt(observation.networkFee);
  assert(amount>fee&&fee>0n);
  const {DefaultLogger,DummyLogger}=await import(pathToFileURL(require.resolve('@rosen-bridge/abstract-logger')));
  DefaultLogger.init(new DummyLogger());
  const {TokenMap}=await import(pathToFileURL(require.resolve('@rosen-bridge/tokens')));
  const {ErgoChain}=await import(rosenURL('packages/chains/ergo/dist/index.js'));
  const {default:ErgoNodeNetwork}=await import(rosenURL('packages/networks/ergo-node/lib/index.ts'));
  const {TransactionType}=await import(pathToFileURL(require.resolve('@rosen-chains/abstract-chain')));
  const {default:EventTriggerExtractor}=await import(pathToFileURL(require.resolve('@rosen-bridge/watcher-data-extractor/dist/extractor/eventTriggerExtractor.js')));
  const {DataSource}=await import(rosenURL('node_modules/@rosen-bridge/extended-typeorm/dist/index.js'));
  const {producer}=await import('./watcher-producer.mjs');
  const network=new ErgoNodeNetwork({nodeBaseUrl:'http://127.0.0.1:19051',logger:new DummyLogger()});
  const builder=await producer(d);
  const candidate=builder.createTriggerEvent(2000000n,await network.getHeight(),[d.tokens.WID],observation,10n);
  const registers={};for(let i=4;i<=7;i++)registers['R'+i]=candidate.register_value(i).encode_to_base16();
  const triggerFile='trigger-'+label+'.json';
  const triggerTx=fs.existsSync(runtime+'/'+triggerFile)?JSON.parse(fs.readFileSync(runtime+'/'+triggerFile)):await sendRequests([{address:d.contracts.EventTrigger.address,value:2000000,assets:[{tokenId:d.tokens.RWT,amount:10}],registers}]);
  if(!fs.existsSync(runtime+'/'+triggerFile))save(triggerFile,triggerTx);
  const triggerJSON=triggerTx.outputs.find(o=>o.ergoTree===d.contracts.EventTrigger.tree);
  const trigger=wasm.ErgoBox.from_json(JSON.stringify(triggerJSON));
  const extractor=new EventTriggerExtractor('local',new DataSource({type:'sqlite',database:':memory:'}),'node','',d.contracts.EventTrigger.address,d.tokens.RWT,d.contracts.Permit.address,d.contracts.Fraud.address,undefined,false);
  assert(extractor.hasBoxData(triggerJSON));const extracted=extractor.extractBoxData(triggerJSON);assert(extracted);
  for(const field of ['sourceTxId','sourceBlockId','amount','bridgeFee','networkFee','targetChainTokenId','toAddress'])assert.equal(extracted[field],observation[field]);
  const secrets=new wasm.SecretKeys();JSON.parse(fs.readFileSync(runtime+'/rosen-keys-private.json')).slice(0,2).forEach(k=>secrets.add(wasm.SecretKey.dlog_from_bytes(Buffer.from(k,'hex'))));
  const signer=wasm.Wallet.from_secrets(secrets);
  const chain=new ErgoChain(network,{fee:1100000n,confirmations:{payment:1,cold:1,manual:1,arbitrary:1},addresses:{lock:d.contracts.Lock.address,permit:d.contracts.Permit.address,fraud:d.contracts.Fraud.address,cold:d.fundingAddress},rwtId:d.tokens.RWT,minBoxValue:1000000n,eventTxConfirmation:1},new TokenMap(),{isInSign:async()=>false,sign:async(reduced,required)=>{assert.equal(required,2);return signer.sign_reduced_transaction(reduced);}});
  const order=[{address:d.contracts.Permit.address,assets:{nativeToken:2000000n,tokens:[{id:d.tokens.RWT,value:10n}]},extra:d.tokens.WID},{address:observation.toAddress,assets:{nativeToken:10000000n,tokens:[{id:d.tokens.Asset,value:amount-fee}]}},{address:d.fundingAddress,assets:{nativeToken:1000000n,tokens:[{id:d.tokens.Asset,value:fee}]},extra:''}];
  const guard=wasm.ErgoBox.from_json(JSON.stringify(await rpc('/utxo/byId/'+d.guard.boxId)));
  const hex=b=>Buffer.from(b.sigma_serialize_bytes()).toString('hex');
  const payment=await chain.generateTransaction(extracted.eventId,TransactionType.payment,order,[],[],[hex(trigger)],[hex(guard)]);
  const normalize=rows=>rows.map(row=>({...row,address:tree(row.address)}));
  assert.deepEqual(normalize(await chain.extractTransactionOrder(payment)),normalize(order));
  const signed=await chain.signTransaction(payment,2);
  const tx=wasm.Transaction.sigma_parse_bytes(signed.txBytes);
  const id=await rpc('/transactions',JSON.parse(tx.to_json()));assert.equal(id,tx.id().to_str());
  const confirmedTx=await confirmed(id);
  const box=confirmedTx.outputs.find(o=>o.ergoTree===tree(observation.toAddress)&&o.assets.some(a=>a.tokenId===d.tokens.Asset&&BigInt(a.amount)===amount-fee));assert(box);
  assert.equal((await rpc('/utxo/byId/'+box.boxId)).boxId,box.boxId);
  const eventResult=extractor.extractEventResult(confirmedTx);assert.equal(eventResult.result,'successful');
  const receipt={observation,trigger:triggerJSON,event:extracted,order,transaction:confirmedTx,box,eventResult};save('credit-'+label+'.json',receipt);return receipt;
}
export async function redeem(creditReceipt,terms,label) {
  assert.match(label,/^[a-z0-9-]+$/);assert(!fs.existsSync(runtime+'/redemption-'+label+'.json'),'Existing redemption receipt');
  for(const field of ['bridgeFee','networkFee'])assert.match(terms[field],/^(0|[1-9][0-9]*)$/);
  assert(typeof terms.toAddress==='string'&&terms.toAddress.length>0);
  const d=JSON.parse(fs.readFileSync(runtime+'/rosen-deployment.json'));
  const live=await rpc('/utxo/byId/'+creditReceipt.box.boxId);
  assert.equal(live.transactionId,creditReceipt.transaction.id);
  assert.equal(live.ergoTree,tree(recipient()));assert.equal(live.assets.length,1);assert.equal(live.assets[0].tokenId,d.tokens.Asset);
  const quantity=BigInt(live.assets[0].amount);assert(quantity>BigInt(terms.bridgeFee)+BigInt(terms.networkFee));
  const input=wasm.ErgoBox.from_json(JSON.stringify(live));const boxes=wasm.ErgoBoxes.empty();boxes.add(input);
  const fee=wasm.BoxValue.from_i64(wasm.I64.from_str('1100000'));
  const value=BigInt(live.value)-1100000n;assert(value>=1000000n);
  const candidate=new wasm.ErgoBoxCandidateBuilder(wasm.BoxValue.from_i64(wasm.I64.from_str(value.toString())),wasm.Contract.pay_to_address(wasm.Address.from_base58(d.contracts.Lock.address)),(await rpc('/info')).fullHeight);
  candidate.add_token(wasm.TokenId.from_str(d.tokens.Asset),wasm.TokenAmount.from_i64(wasm.I64.from_str(quantity.toString())));
  candidate.set_register_value(4,wasm.Constant.from_coll_coll_byte(['monero',terms.toAddress,terms.networkFee,terms.bridgeFee,recipient()].map(s=>Buffer.from(s))));
  const outputs=new wasm.ErgoBoxCandidates(candidate.build());
  const selector=new wasm.SimpleBoxSelector();const tokens=new wasm.Tokens();tokens.add(new wasm.Token(wasm.TokenId.from_str(d.tokens.Asset),wasm.TokenAmount.from_i64(wasm.I64.from_str(quantity.toString()))));
  const selection=selector.select(boxes,wasm.BoxValue.from_i64(wasm.I64.from_str(String(live.value))),tokens);
  const unsigned=wasm.TxBuilder.new(selection,outputs,(await rpc('/info')).fullHeight,fee,wasm.Address.from_base58(recipient())).build();
  const {default:ErgoNodeNetwork}=await import(rosenURL('packages/networks/ergo-node/lib/index.ts'));
  const context=await new ErgoNodeNetwork({nodeBaseUrl:'http://127.0.0.1:19051'}).getStateContext();
  const keys=new wasm.SecretKeys();keys.add(wasm.SecretKey.dlog_from_bytes(Buffer.from(JSON.parse(fs.readFileSync(runtime+'/recipient-private.json')).key,'hex')));
  const signed=wasm.Wallet.from_secrets(keys).sign_transaction(context,unsigned,boxes,wasm.ErgoBoxes.empty());
  assert(wasm.verify_tx_input_proof(0,context,signed,boxes,wasm.ErgoBoxes.empty()));
  const tx=await confirmed(await rpc('/transactions',JSON.parse(signed.to_json())));
  assert.equal(tx.inputs.length,1);assert.equal(tx.inputs[0].boxId,creditReceipt.box.boxId);
  const {TokenMap}=await import(pathToFileURL(require.resolve('@rosen-bridge/tokens')));const map=new TokenMap();
  const mapping=[{ergo:{tokenId:d.tokens.Asset,name:'Local rsXMR',decimals:12,type:'EIP-004',residency:'wrapped',extra:{}},monero:{tokenId:terms.moneroTokenId||'XMR',name:'XMR',decimals:12,type:'native',residency:'native',extra:{}}}];await map.updateConfigByJson(mapping);
  const {ErgoNodeRosenExtractor}=await import(rosenURL('node_modules/@rosen-bridge/rosen-extractor/dist/getRosenData/ergo/ergoNodeRosenExtractor.js'));
  const extracted=new ErgoNodeRosenExtractor(d.contracts.Lock.address,map).extractData(tx);assert(extracted);assert.equal(extracted.sourceTxId,tx.id);assert.equal(extracted.amount,quantity.toString());assert.equal(extracted.toAddress,terms.toAddress);assert.equal(extracted.sourceChainTokenId,d.tokens.Asset);
  const receipt={creditTransactionId:creditReceipt.transaction.id,consumedCreditBoxId:creditReceipt.box.boxId,transaction:tx,extracted,tokenMapping:mapping};save('redemption-'+label+'.json',receipt);return receipt;
}
if(process.argv[2]==='deploy')deploy().then(d=>console.log(JSON.stringify({stage:'deployed',transactionId:d.transactionId,guard:d.guard.boxId,lock:d.lock.boxId}))).catch(e=>{console.error(e.message);process.exitCode=1;});
