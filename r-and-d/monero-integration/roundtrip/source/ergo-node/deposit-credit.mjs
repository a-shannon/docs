import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {wasm,rpc,confirmed,tree,recipient,runtime} from './rosen-node.mjs';
import {producer} from './watcher-producer.mjs';
const base=config.rosenRoot;
const require=createRequire(base+'/package.json');
require('reflect-metadata');
const mod=relative=>import(relative.startsWith('services/guard-service/')?sourceURL(relative.replace('services/guard-service/','guard-service/')):rosenURL(relative));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const text=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
const read=name=>JSON.parse(fs.readFileSync(runtime+'/'+name));
const hex=box=>Buffer.from(box.sigma_serialize_bytes()).toString('hex');
const value=n=>wasm.BoxValue.from_i64(wasm.I64.from_str(String(n)));
export function selectTriggerFunding(boxes,fundingTree,rwtId,minimumValue,amount){
  return boxes.find(box=>box.ergoTree===fundingTree&&BigInt(box.value)>=minimumValue&&box.assets.some(asset=>asset.tokenId===rwtId&&BigInt(asset.amount)>=amount));
}
/** Fixed local custody domain; source verification providers remain trusted composition. */
export async function openDepositCredit({directory,context,providers,authorityProfile='local-operator-v1',fault,leaseMs=60000}) {
  context=structuredClone(context);
  assert(Number.isSafeInteger(leaseMs)&&leaseMs>0&&leaseMs<=60000);
  assert(path.isAbsolute(directory));fs.mkdirSync(directory,{recursive:true});
  const {DataSource}=await mod('node_modules/@rosen-bridge/extended-typeorm/dist/index.js');
  const {DepositRegistry}=await mod('services/guard-service/src/db/depositRegistry.ts');
  const {admitDeposit,contextRecord,canonicalDecision}=await mod('services/guard-service/src/deposit/depositAdmission.ts');
  const {deliverCredit}=await mod('services/guard-service/src/deposit/creditOutboxWorker.ts');
  const {Migration1789218000000}=await mod('services/guard-service/src/db/migrations/sqlite/1789218000000-migration.ts');
  const {Migration1789230000000}=await mod('services/guard-service/src/db/migrations/sqlite/1789230000000-migration.ts');
  const db=new DataSource({type:'sqlite',database:path.join(directory,'deposits.sqlite'),synchronize:false,migrations:[Migration1789218000000,Migration1789230000000]});
  await db.initialize();await db.query('PRAGMA synchronous=FULL');await db.query('PRAGMA foreign_keys=ON');await db.runMigrations();
  const registry=await DepositRegistry.open({type:'sqlite',database:path.join(directory,'deposits.sqlite')});
  const record=contextRecord(context),previous=await registry.readContext(context.id);
  if(previous)assert.equal(previous.digest,record.digest,'Context drift requires explicit successor custody');else await registry.setContext(record,null);
  const journal=new DatabaseSync(path.join(directory,'execution.sqlite'));
  journal.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  journal.exec(`CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,payloadHash TEXT NOT NULL,binding TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stages(id TEXT PRIMARY KEY,job TEXT NOT NULL,txid TEXT NOT NULL UNIQUE,signedHex TEXT NOT NULL,signedJson TEXT NOT NULL,metadata TEXT NOT NULL,confirmed TEXT,FOREIGN KEY(job) REFERENCES jobs(id));
    CREATE TABLE IF NOT EXISTS inputs(boxId TEXT PRIMARY KEY,stage TEXT NOT NULL,FOREIGN KEY(stage) REFERENCES stages(id));
    CREATE TABLE IF NOT EXISTS results(job TEXT PRIMARY KEY,result TEXT NOT NULL,FOREIGN KEY(job) REFERENCES jobs(id));`);
  const deployment=read('rosen-deployment.json');
  const {DefaultLogger,DummyLogger}=await mod('node_modules/@rosen-bridge/abstract-logger/dist/index.js');DefaultLogger.init(new DummyLogger());
  const {TokenMap}=await mod('node_modules/@rosen-bridge/tokens/dist/index.js');
  const {ErgoChain}=await mod('packages/chains/ergo/dist/index.js');
  const {default:ErgoNodeNetwork}=await mod('packages/networks/ergo-node/lib/index.ts');
  const {TransactionType}=await mod('packages/abstract-chain/dist/index.js');
  const {default:EventTriggerExtractor}=await mod('node_modules/@rosen-bridge/watcher-data-extractor/dist/extractor/eventTriggerExtractor.js');
  const {ErgoNodeRosenExtractor}=await mod('node_modules/@rosen-bridge/rosen-extractor/dist/getRosenData/ergo/ergoNodeRosenExtractor.js');
  const network=new ErgoNodeNetwork({nodeBaseUrl:'http://127.0.0.1:19051',logger:new DummyLogger()});
  const target={id:'actual-ergo-devnet',profile:hash(canonicalDecision({contracts:deployment.contracts,tokens:deployment.tokens,authorityProfile}))};
  const hit=async point=>{if(fault)await fault(point);};
  async function isolatedNode(){const info=await rpc('/info');assert.equal(info.network,'devnet');assert.equal(info.appVersion,'6.0.3');assert.equal(info.peersCount,0);}
  async function stage(job,name,build) {
    const id=job+':'+name;
    let saved=journal.prepare('SELECT * FROM stages WHERE id=?').get(id);
    if(!saved){
      await hit(name+':build-start');
      let built;try{built=await build();}catch(error){await hit(name+':build-error:'+error.message);throw error;}
      const parsed=wasm.Transaction.sigma_parse_bytes(Buffer.from(built.signedHex,'hex'));
      const json=JSON.parse(parsed.to_json());assert.equal(json.id,built.json.id);
      journal.exec('BEGIN IMMEDIATE');
      try {
        saved=journal.prepare('SELECT * FROM stages WHERE id=?').get(id);
        if(!saved){journal.prepare('INSERT INTO stages(id,job,txid,signedHex,signedJson,metadata) VALUES(?,?,?,?,?,?)').run(id,job,json.id,built.signedHex,JSON.stringify(json),text(built.metadata));for(const input of json.inputs)journal.prepare('INSERT INTO inputs(boxId,stage) VALUES(?,?)').run(input.boxId,id);}
        journal.exec('COMMIT');
      }catch(e){journal.exec('ROLLBACK');throw e;}
      saved=journal.prepare('SELECT * FROM stages WHERE id=?').get(id);
    }
    assert(saved);const tx=wasm.Transaction.sigma_parse_bytes(Buffer.from(saved.signedHex,'hex'));
    assert.equal(tx.id().to_str(),saved.txid);assert.equal(hex(tx),hex(wasm.Transaction.from_json(saved.signedJson)));
    await hit(name+':retained');
    if(saved.confirmed)return {tx:JSON.parse(saved.confirmed),metadata:JSON.parse(saved.metadata)};
    let observation;
    try{const found=await rpc('/blockchain/transaction/byId/'+saved.txid);if(found.numConfirmations>0)observation=found;}catch(e){if(!String(e).includes('404'))throw e;}
    if(!observation){
      await isolatedNode();
      try{const returned=await rpc('/transactions',JSON.parse(saved.signedJson));assert.equal(returned,saved.txid);}catch(e){
        // Unknown transport or duplicate admission may already have committed. Never rebuild.
        observation=await confirmed(saved.txid);
      }
      await hit(name+':submitted');
      if(!observation)observation=await confirmed(saved.txid);
    }
    assert.equal(observation.id,saved.txid);
    journal.prepare('UPDATE stages SET confirmed=? WHERE id=? AND confirmed IS NULL').run(JSON.stringify(observation),id);
    return {tx:observation,metadata:JSON.parse(saved.metadata)};
  }
  async function generated(requests){
    assert.equal(requests.length,1);assert.equal(requests[0].assets.length,1);assert.equal(requests[0].assets[0].tokenId,deployment.tokens.RWT);
    const required=BigInt(requests[0].assets[0].amount),minimumValue=BigInt(requests[0].value)+1100000n+1000000n;
    let funding;
    for(let offset=0;offset<10000&&!funding;offset+=100){
      await hit('funding:page:'+offset);
      const page=await rpc('/blockchain/box/unspent/byTokenId/'+deployment.tokens.RWT+'?offset='+offset+'&limit=100');
      funding=selectTriggerFunding(page,tree(deployment.fundingAddress),deployment.tokens.RWT,minimumValue,required);
      if(page.length<100)break;
    }
    assert(funding,'No confirmed wallet-owned RWT funding box with enough ERG');
    const live=await rpc('/utxo/byId/'+funding.boxId);
    assert(selectTriggerFunding([live],tree(deployment.fundingAddress),deployment.tokens.RWT,minimumValue,required));
    const request=requests[0],headers=wasm.BlockHeaders.from_json((await rpc('/blocks/lastHeaders/10')).map(h=>JSON.stringify(h)));
    const state=new wasm.ErgoStateContext(wasm.PreHeader.from_block_header(headers.get(0)),headers);
    const height=(await rpc('/info')).fullHeight;assert(Number.isSafeInteger(height));
    const output=new wasm.ErgoBoxCandidateBuilder(value(request.value),wasm.Contract.pay_to_address(wasm.Address.from_base58(request.address)),height);
    const tokens=new wasm.Tokens();
    for(const asset of request.assets){const id=wasm.TokenId.from_str(asset.tokenId),amount=wasm.TokenAmount.from_i64(wasm.I64.from_str(String(asset.amount)));output.add_token(id,amount);tokens.add(new wasm.Token(id,amount));}
    for(const [register,encoded]of Object.entries(request.registers))output.set_register_value(Number(register.slice(1)),wasm.Constant.decode_from_base16(encoded));
    const boxes=wasm.ErgoBoxes.empty();boxes.add(wasm.ErgoBox.from_json(JSON.stringify(live)));
    const selection=new wasm.SimpleBoxSelector().select(boxes,value(BigInt(request.value)+1100000n),tokens);
    const unsigned=wasm.TxBuilder.new(selection,new wasm.ErgoBoxCandidates(output.build()),height,value(1100000),wasm.Address.from_base58(deployment.fundingAddress)).build();
    // This key funds only the local watcher fixture, never the Rosen guard credit.
    const master=wasm.ExtSecretKey.derive_master(wasm.Mnemonic.to_seed(read('wallet-private.json').mnemonic,''));
    const derived=master.derive(wasm.DerivationPath.new(0,new Uint32Array([0])));
    const key=wasm.SecretKey.dlog_from_bytes(derived.secret_key_bytes());
    assert.equal(key.get_address().to_ergo_tree().to_base16_bytes(),live.ergoTree,'Local funding key does not control selected box');
    const keys=new wasm.SecretKeys();keys.add(key);
    const native=wasm.Wallet.from_secrets(keys).sign_transaction(state,unsigned,boxes,wasm.ErgoBoxes.empty());
    assert(wasm.verify_tx_input_proof(0,state,native,boxes,wasm.ErgoBoxes.empty()));
    const tx=JSON.parse(native.to_json());assert.equal(tx.inputs.length,1);assert.equal(tx.inputs[0].boxId,live.boxId);
    assert.equal(tx.outputs[0].ergoTree,tree(request.address));assert.deepEqual(tx.outputs[0].additionalRegisters,request.registers);
    return {json:tx,signedHex:hex(native),metadata:{fundingBoxId:live.boxId,fundingSigner:'local-wallet-eip3-0',inputProofVerified:true}};
  }
  async function execute(...args){try{return await executeUnchecked(...args);}catch(error){await hit('execute-error:'+error.message);throw error;}}
  async function executeUnchecked(job,observation,terms) {
    const d=deployment,c=d.contracts;
    const triggerStage=await stage(job,'trigger',async()=>{
      const encoder=await producer(d);const candidate=encoder.createTriggerEvent(2000000n,await network.getHeight(),[d.tokens.WID],observation,10n);
      const registers={};for(let i=4;i<=7;i++)registers['R'+i]=candidate.register_value(i).encode_to_base16();
      return generated([{address:c.EventTrigger.address,value:2000000,assets:[{tokenId:d.tokens.RWT,amount:10}],registers}]);
    });
    const trigger=triggerStage.tx.outputs.find(o=>o.ergoTree===c.EventTrigger.tree);assert(trigger);
    const extractor=new EventTriggerExtractor('local',new DataSource({type:'sqlite',database:':memory:'}),'node','',c.EventTrigger.address,d.tokens.RWT,c.Permit.address,c.Fraud.address,undefined,false);
    const event=extractor.extractBoxData(trigger);assert(event);
    for(const key of ['sourceTxId','sourceBlockId','toAddress','amount','bridgeFee','networkFee','targetChainTokenId'])assert.equal(event[key],observation[key]);
    const creditStage=await stage(job,'credit',async()=>{
      const keys=new wasm.SecretKeys();read('rosen-keys-private.json').slice(0,2).forEach(k=>keys.add(wasm.SecretKey.dlog_from_bytes(Buffer.from(k,'hex'))));const signer=wasm.Wallet.from_secrets(keys);
      const chain=new ErgoChain(network,{fee:1100000n,confirmations:{payment:1,cold:1,manual:1,arbitrary:1},addresses:{lock:c.Lock.address,permit:c.Permit.address,fraud:c.Fraud.address,cold:d.fundingAddress},rwtId:d.tokens.RWT,minBoxValue:1000000n,eventTxConfirmation:1},new TokenMap(),{isInSign:async()=>false,sign:async(reduced,required)=>{assert.equal(required,2);return signer.sign_reduced_transaction(reduced);}});
      const fee=BigInt(observation.bridgeFee)+BigInt(observation.networkFee),net=BigInt(observation.amount)-fee;
      const order=[{address:c.Permit.address,assets:{nativeToken:2000000n,tokens:[{id:d.tokens.RWT,value:10n}]},extra:d.tokens.WID},{address:observation.toAddress,assets:{nativeToken:10000000n,tokens:[{id:d.tokens.Asset,value:net}]}},{address:d.fundingAddress,assets:{nativeToken:1000000n,tokens:[{id:d.tokens.Asset,value:fee}]},extra:''}];
      const guard=await rpc('/utxo/byId/'+d.guard.boxId);
      const payment=await chain.generateTransaction(event.eventId,TransactionType.payment,order,[],[],[hex(wasm.ErgoBox.from_json(JSON.stringify(trigger)))],[hex(wasm.ErgoBox.from_json(JSON.stringify(guard)))]);
      const normalize=rows=>rows.map(row=>({...row,address:tree(row.address)}));assert.deepEqual(normalize(await chain.extractTransactionOrder(payment)),normalize(order));
      const signed=await chain.signTransaction(payment,2),native=wasm.Transaction.sigma_parse_bytes(signed.txBytes);
      return {json:JSON.parse(native.to_json()),signedHex:hex(native),metadata:{order,event}};
    });
    const net=BigInt(observation.amount)-BigInt(observation.bridgeFee)-BigInt(observation.networkFee);
    const creditBox=creditStage.tx.outputs.find(o=>o.ergoTree===tree(observation.toAddress)&&o.assets.some(a=>a.tokenId===d.tokens.Asset&&BigInt(a.amount)===net));assert(creditBox);
    const eventResult=extractor.extractEventResult(creditStage.tx);assert.equal(eventResult.result,'successful');
    const redemptionStage=await stage(job,'redemption',async()=>{
      const box=await rpc('/utxo/byId/'+creditBox.boxId);assert.equal(box.transactionId,creditStage.tx.id);assert.equal(box.ergoTree,tree(recipient()));
      const input=wasm.ErgoBox.from_json(JSON.stringify(box)),boxes=wasm.ErgoBoxes.empty();boxes.add(input);
      const height=await network.getHeight();const candidate=new wasm.ErgoBoxCandidateBuilder(value(BigInt(box.value)-1100000n),wasm.Contract.pay_to_address(wasm.Address.from_base58(c.Lock.address)),height);
      const amount=wasm.TokenAmount.from_i64(wasm.I64.from_str(net.toString())),tokenId=wasm.TokenId.from_str(d.tokens.Asset);candidate.add_token(tokenId,amount);
      candidate.set_register_value(4,wasm.Constant.from_coll_coll_byte(['monero',terms.toAddress,terms.networkFee,terms.bridgeFee,recipient()].map(s=>Buffer.from(s))));
      const tokens=new wasm.Tokens();tokens.add(new wasm.Token(tokenId,amount));
      const selection=new wasm.SimpleBoxSelector().select(boxes,value(box.value),tokens);
      const unsigned=wasm.TxBuilder.new(selection,new wasm.ErgoBoxCandidates(candidate.build()),height,value(1100000),wasm.Address.from_base58(recipient())).build();
      const keys=new wasm.SecretKeys();keys.add(wasm.SecretKey.dlog_from_bytes(Buffer.from(read('recipient-private.json').key,'hex')));
      const state=await network.getStateContext(),native=wasm.Wallet.from_secrets(keys).sign_transaction(state,unsigned,boxes,wasm.ErgoBoxes.empty());assert(wasm.verify_tx_input_proof(0,state,native,boxes,wasm.ErgoBoxes.empty()));
      return {json:JSON.parse(native.to_json()),signedHex:hex(native),metadata:{consumedCreditBoxId:box.boxId}};
    });
    assert.equal(redemptionStage.tx.inputs.length,1);assert.equal(redemptionStage.tx.inputs[0].boxId,creditBox.boxId);
    const map=new TokenMap();await map.updateConfigByJson([{ergo:{tokenId:d.tokens.Asset,name:'Local rsXMR',decimals:12,type:'EIP-004',residency:'wrapped',extra:{}},monero:{tokenId:terms.moneroTokenId,name:'XMR',decimals:12,type:'native',residency:'native',extra:{}}}]);
    const extracted=new ErgoNodeRosenExtractor(c.Lock.address,map).extractData(redemptionStage.tx);assert(extracted);assert.equal(extracted.amount,net.toString());assert.equal(extracted.sourceTxId,redemptionStage.tx.id);assert.equal(extracted.toAddress,terms.toAddress);
    assert.match(redemptionStage.tx.blockId,/^[0-9a-f]{64}$/);assert(Number.isSafeInteger(redemptionStage.tx.inclusionHeight));
    const returnObservation={fromChain:'ergo',toChain:'monero',fromAddress:extracted.fromAddress,toAddress:extracted.toAddress,amount:extracted.amount,bridgeFee:extracted.bridgeFee,networkFee:extracted.networkFee,sourceChainTokenId:extracted.sourceChainTokenId,targetChainTokenId:extracted.targetChainTokenId,sourceTxId:extracted.sourceTxId,sourceBlockId:redemptionStage.tx.blockId,height:redemptionStage.tx.inclusionHeight};
    const returnStage=await stage(job,'return-trigger',async()=>{
      const encoder=await producer(d);await hit('return-trigger:producer-ready');
      const height=(await rpc('/info')).fullHeight;assert(Number.isSafeInteger(height));await hit('return-trigger:height-ready');
      const candidate=encoder.createTriggerEvent(2000000n,height,[d.tokens.WID],returnObservation,10n);
      const registers={};for(let i=4;i<=7;i++)registers['R'+i]=candidate.register_value(i).encode_to_base16();
      return generated([{address:c.EventTrigger.address,value:2000000,assets:[{tokenId:d.tokens.RWT,amount:10}],registers}]);
    });
    const returnBox=returnStage.tx.outputs.find(o=>o.ergoTree===c.EventTrigger.tree);assert(returnBox);
    const returnEvent=extractor.extractBoxData(returnBox);assert(returnEvent);
    for(const key of ['sourceTxId','sourceBlockId','amount','toAddress','sourceChainTokenId','targetChainTokenId'])assert.equal(returnEvent[key],returnObservation[key]);
    assert.equal(returnEvent.sourceChainHeight,returnObservation.height);assert.equal(returnEvent.WIDsCount,1);
    const withdrawalSource={event:returnEvent,triggerTransactionId:returnStage.tx.id,triggerBoxId:returnBox.boxId,wids:[d.tokens.WID]};
    return {obligationId:job,authorityMode:'synthetic',authorityProfile,credit:{transaction:creditStage.tx,box:creditBox,event,eventResult},redemption:{transaction:redemptionStage.tx,extracted,consumedCreditBoxId:creditBox.boxId},returnTrigger:{transaction:returnStage.tx,box:returnBox},withdrawalSource};
  }
  let tail=Promise.resolve();
  async function run(input) {
    const {request,observation,redemptionTerms}=structuredClone(input);
    const admission=await admitDeposit(request,{registry,contextId:context.id,providers,authority:{profile:authorityProfile,authorize:async(_bytes,decisionDigest)=>({mode:'synthetic',profile:authorityProfile,decisionDigest})}});
    if(!['created','existing'].includes(admission.status))return {admission};
    await isolatedNode();
    const envelope=JSON.parse(admission.decision.envelope),candidate=envelope.candidate;
    assert.equal(candidate.destinationAsset,deployment.tokens.Asset);assert.equal(candidate.retainedAtomicRemainder,'0');assert.equal(candidate.destinationAmount,candidate.netAmount);
    const expected={fromChain:'monero',toChain:'ergo',fromAddress:candidate.vaultAddress,toAddress:candidate.recipient,amount:candidate.amount,bridgeFee:candidate.bridgeFee,networkFee:candidate.networkFee,sourceChainTokenId:'XMR',targetChainTokenId:candidate.destinationAsset,sourceTxId:candidate.txid,sourceBlockId:candidate.blockHash,height:Number(candidate.blockHeight)};
    assert(Number.isSafeInteger(expected.height));assert.equal(canonicalDecision(observation),canonicalDecision(expected),'Observation differs from admitted source obligation');assert.equal(tree(expected.toAddress),tree(recipient()));
    for(const name of ['bridgeFee','networkFee'])assert.match(redemptionTerms[name],/^(0|[1-9][0-9]*)$/);
    assert(typeof redemptionTerms.toAddress==='string'&&redemptionTerms.toAddress.length>0);assert.equal(redemptionTerms.moneroTokenId,'XMR');assert(BigInt(candidate.netAmount)>BigInt(redemptionTerms.bridgeFee)+BigInt(redemptionTerms.networkFee));
    const job=admission.outbox.obligationId,binding=canonicalDecision({expected,redemptionTerms,profile:target.profile});
    journal.prepare('INSERT OR IGNORE INTO jobs(id,payloadHash,binding) VALUES(?,?,?)').run(job,admission.outbox.payloadHash,binding);
    const retained=journal.prepare('SELECT * FROM jobs WHERE id=?').get(job);assert.equal(retained.payloadHash,admission.outbox.payloadHash);assert.equal(retained.binding,binding,'Existing execution binding differs');
    const destination={target,verify:async(raw,claim)=>{
      const stored=journal.prepare('SELECT result FROM results WHERE job=?').get(job);if(!stored||raw?.result!==stored.result)return;
      return {mode:'synthetic',destinationId:target.id,destinationProfile:target.profile,obligationId:claim.obligationId,payloadHash:claim.payloadHash,result:stored.result};
    }};
    let activeSend;
    const delivery=await deliverCredit({registry,destination,owner:'local-node-credit',now:()=>BigInt(Date.now()),lease:BigInt(leaseMs),timeoutMs:60000,send:claim=>activeSend=(async()=>{
      assert.equal(claim.payloadHash,admission.outbox.payloadHash);assert.equal(claim.payload,admission.outbox.payload);
      let stored=journal.prepare('SELECT result FROM results WHERE job=?').get(job);
      if(!stored){const result=await execute(job,expected,redemptionTerms);const receiptName='result-'+hash(job)+'.json';const bytes=text(result);const filename=path.join(directory,receiptName);if(!fs.existsSync(filename)){const fd=fs.openSync(filename,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}assert.equal(fs.readFileSync(filename,'utf8'),bytes);const compact=text({creditTxId:result.credit.transaction.id,creditBoxId:result.credit.box.boxId,redemptionTxId:result.redemption.transaction.id,receiptName,sha256:hash(bytes)});journal.prepare('INSERT OR IGNORE INTO results(job,result) VALUES(?,?)').run(job,compact);stored=journal.prepare('SELECT result FROM results WHERE job=?').get(job);}
      return {result:stored.result};
    })()},job);
    // Transport timeout does not cancel the sender. Keep custody open and serialize
    // subsequent attempts until the retained execution has actually settled.
    if(activeSend)await activeSend.catch(()=>{});
    const stored=journal.prepare('SELECT result FROM results WHERE job=?').get(job);
    const result=stored?JSON.parse(stored.result):undefined;
    let receipt;
    if(result){assert.equal(result.receiptName,'result-'+hash(job)+'.json');const bytes=fs.readFileSync(path.join(directory,result.receiptName),'utf8');assert.equal(hash(bytes),result.sha256);receipt=JSON.parse(bytes);}
    return {admission:{status:admission.status,obligationId:job,evidenceMode:candidate.evidenceMode,authorityMode:'synthetic',authorityProfile},delivery,result,receipt};
  }
  return {run(input){const next=tail.then(()=>run(input));tail=next.catch(()=>{});return next;},async close(){await tail;await registry.close();await db.destroy();journal.close();}};
}
