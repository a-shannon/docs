import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {config,sourceRoot} from '../tools/config.mjs';
import {wasm,rpc,confirmed,tree,digest} from './rosen-node.mjs';
import {watcherSetupRequests} from './watcher-setup.mjs';
import {isUnregisteredFundingBox} from './funding-candidates.mjs';

const directory=path.join(config.runtimeDirectory,'ergo-authority');
fs.mkdirSync(directory,{recursive:true});
const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
const put=(name,value)=>fs.writeFileSync(path.join(directory,name),JSON.stringify(value,null,2),{flag:'wx'});
const exists=name=>fs.existsSync(path.join(directory,name));
const boxValue=n=>wasm.BoxValue.from_i64(wasm.I64.from_str(String(n)));
const hex=value=>Buffer.from(value.sigma_serialize_bytes()).toString('hex');
const b64=value=>Buffer.from(value,'hex').toString('base64');
export async function stateContext(){const h=wasm.BlockHeaders.from_json((await rpc('/blocks/lastHeaders/10')).map(JSON.stringify));return new wasm.ErgoStateContext(wasm.PreHeader.from_block_header(h.get(0)),h);}
async function local(){const info=await rpc('/info');assert.equal(info.network,'devnet');assert.equal(info.appVersion,'6.0.3');assert.equal(info.peersCount,0);return info;}
function fundingKey(){
  const saved=JSON.parse(fs.readFileSync(path.join(config.ergoRuntime,'wallet-private.json'),'utf8'));
  const master=wasm.ExtSecretKey.derive_master(wasm.Mnemonic.to_seed(saved.mnemonic,''));
  return wasm.SecretKey.dlog_from_bytes(master.derive(wasm.DerivationPath.new(0,new Uint32Array([0]))).secret_key_bytes());
}

/** Controlled fixture funding; signed bytes are retained before local submission. */
export async function fund(stage,requests,mint){
  assert.match(stage,/^[a-z0-9-]+$/);await local();
  const saved=stage+'-signed.json';let record;
  if(exists(saved))record=read(saved);
  else {
    const key=fundingKey(),address=key.get_address().to_base58(wasm.NetworkPrefix.Testnet),addressTree=tree(address);
    const needed=new Map();for(const r of requests)for(const a of r.assets??[])needed.set(a.tokenId,(needed.get(a.tokenId)??0n)+BigInt(a.amount));
    const choices=new Map();
    for(const tokenId of needed.keys()){
      const found=await rpc('/blockchain/box/unspent/byTokenId/'+tokenId+'?offset=0&limit=100');
      for(const box of found)if(box.ergoTree===addressTree&&isUnregisteredFundingBox(box))choices.set(box.boxId,box);
    }
    const ordinary=await rpc('/blockchain/box/unspent/byAddress?offset=0&limit=100',address);
    for(const box of ordinary)if(box.ergoTree===addressTree&&isUnregisteredFundingBox(box))choices.set(box.boxId,box);
    const available=wasm.ErgoBoxes.empty();for(const box of choices.values())available.add(wasm.ErgoBox.from_json(JSON.stringify(box)));
    const target=new wasm.Tokens();for(const [id,amount]of needed)target.add(new wasm.Token(wasm.TokenId.from_str(id),wasm.TokenAmount.from_i64(wasm.I64.from_str(String(amount)))));
    const fee=1100000n,total=requests.reduce((n,r)=>n+BigInt(r.value),fee);
    const selected=new wasm.SimpleBoxSelector().select(available,boxValue(total),target),inputs=selected.boxes();
    for(let i=0;i<inputs.len();i++){const box=inputs.get(i),fresh=wasm.ErgoBox.from_json(JSON.stringify(await rpc('/utxo/byId/'+box.box_id().to_str())));assert.equal(hex(box),hex(fresh));}
    const height=(await local()).fullHeight,outputs=wasm.ErgoBoxCandidates.empty();
    const mintId=mint?inputs.get(0).box_id().to_str():undefined;
    for(let i=0;i<requests.length;i++){
      const r=requests[i],builder=new wasm.ErgoBoxCandidateBuilder(boxValue(r.value),wasm.Contract.pay_to_address(wasm.Address.from_base58(r.address)),height);
      for(const a of [...(r.assets??[]),...(mint&&i===0?[{tokenId:mintId,amount:mint.amount}]:[])])builder.add_token(wasm.TokenId.from_str(a.tokenId),wasm.TokenAmount.from_i64(wasm.I64.from_str(String(a.amount))));
      for(const [register,encoded]of Object.entries(r.registers??{}))builder.set_register_value(Number(register.slice(1)),wasm.Constant.decode_from_base16(encoded));
      outputs.add(builder.build());
    }
    const unsigned=wasm.TxBuilder.new(selected,outputs,height,boxValue(fee),wasm.Address.from_base58(address)).build();
    const keys=new wasm.SecretKeys();keys.add(key);const state=await stateContext();
    const signed=wasm.Wallet.from_secrets(keys).sign_transaction(state,unsigned,inputs,wasm.ErgoBoxes.empty());
    for(let i=0;i<inputs.len();i++)assert(wasm.verify_tx_input_proof(i,state,signed,inputs,wasm.ErgoBoxes.empty()));
    record={txId:signed.id().to_str(),signedHex:hex(signed),transaction:JSON.parse(signed.to_json()),mintId};put(saved,record);
  }
  const retained=wasm.Transaction.sigma_parse_bytes(Buffer.from(record.signedHex,'hex'));
  assert.equal(retained.id().to_str(),record.txId);assert.equal(hex(retained),hex(wasm.Transaction.from_json(JSON.stringify(record.transaction))));
  let tx;try{tx=await rpc('/blockchain/transaction/byId/'+record.txId);}catch(error){if(!String(error).includes('404'))throw error;}
  if(!tx){await local();try{assert.equal(await rpc('/transactions',record.transaction),record.txId);}catch(error){tx=await confirmed(record.txId);}}
  tx=await confirmed(record.txId);assert(tx.numConfirmations>0);return {...record,transaction:tx};
}

async function compile(name,parameters){
  let source=fs.readFileSync(path.join(sourceRoot,'ergo-node/contracts',name+'.es'),'utf8');
  for(const [from,to]of Object.entries(parameters))source=source.replaceAll(from,to);
  assert(!/"[A-Z_]+"/.test(source));const result=await rpc('/script/p2sAddress',{source,treeVersion:0});
  return {address:result.address,tree:tree(result.address),sourceSha256:crypto.createHash('sha256').update(source).digest('hex')};
}
function fixtureKeys(){
  const file='fixture-keys.private.json';if(!exists(file))put(file,{guards:Array.from({length:4},()=>crypto.randomBytes(32).toString('hex')),watchers:Array.from({length:2},()=>crypto.randomBytes(32).toString('hex'))});return read(file);
}
export async function setupAuthorityFixture(){
  await local();const privateKeys=fixtureKeys();
  if(exists('deployment.json')){
    const d=read('deployment.json'),permits=await rpc('/blockchain/box/unspent/byAddress?offset=0&limit=100',d.contracts.Permit.address);
    const watchers=await Promise.all(d.watchers.map(async(w,i)=>{
      const own=await rpc('/blockchain/box/unspent/byAddress?offset=0&limit=100',w.address);
      const wid=own.filter(b=>b.assets.some(a=>a.tokenId===w.WID));assert.equal(wid.length,1,'Fixture WID successor');
      return {...w,secretKey:privateKeys.watchers[i],WIDBox:wid[0],feeBoxes:own.filter(b=>b.assets.length===0),
        permitBoxes:permits.filter(b=>Buffer.from(wasm.ErgoBox.from_json(JSON.stringify(b)).register_value(4).to_byte_array()).toString('hex')===w.WID)};
    }));return {...d,watchers,guardSecrets:privateKeys.guards};
  }
  const fundingAddress=fundingKey().get_address().to_base58(wasm.NetworkPrefix.Testnet),tokens={};
  for(const [name,amount]of Object.entries({GuardNFT:1,CleanupNFT:1,RWTRepoNFT:1,RepoConfigNFT:1,MinFeeNFT:1,RWT:1000000,Asset:1000000000,WID1:2,WID2:2})){
    const issued=await fund('issue-'+name.toLowerCase(),[{address:fundingAddress,value:10000000,assets:[]}],{amount});tokens[name]=issued.mintId;
    console.log(JSON.stringify({stage:'issued-fixture-token',name,txId:issued.txId}));
  }
  const contracts={};contracts.GuardSign=await compile('GuardSign',{});contracts.Lock=await compile('Lock',{GUARD_NFT:b64(tokens.GuardNFT)});
  contracts.Fraud=await compile('Fraud',{RWT_REPO_NFT:b64(tokens.RWTRepoNFT),CLEANUP_NFT:b64(tokens.CleanupNFT)});
  contracts.EventTrigger=await compile('EventTrigger',{CLEANUP_NFT:b64(tokens.CleanupNFT),CLEANUP_CONFIRMATION:'720',LOCK_SCRIPT_HASH:b64(digest(contracts.Lock.tree)),FRAUD_SCRIPT_HASH:b64(digest(contracts.Fraud.tree))});
  contracts.Commitment=await compile('Commitment',{EVENT_TRIGGER_SCRIPT_HASH:b64(digest(contracts.EventTrigger.tree)),RWT_REPO_NFT:b64(tokens.RWTRepoNFT),REPO_CONFIG_NFT:b64(tokens.RepoConfigNFT)});
  contracts.Permit=await compile('Permit',{RWT_REPO_NFT:b64(tokens.RWTRepoNFT),COMMITMENT_SCRIPT_HASH:b64(digest(contracts.Commitment.tree))});
  const guardPublicKeys=privateKeys.guards.map(k=>Buffer.from(wasm.SecretKey.dlog_from_bytes(Buffer.from(k,'hex')).get_address().content_bytes()).toString('hex'));
  const feeRegisters={R4:wasm.Constant.from_coll_coll_byte(['ergo','monero'].map(v=>Buffer.from(v))).encode_to_base16(),
    R5:wasm.Constant.from_js([[0,0]]).encode_to_base16(),R6:wasm.Constant.from_js([['100','101']]).encode_to_base16(),
    R7:wasm.Constant.from_js([['20','21']]).encode_to_base16(),R8:wasm.Constant.from_js([[['0','100'],['0','100']]]).encode_to_base16(),
    R9:wasm.Constant.from_js([['0','1']]).encode_to_base16()};
  await fund('deploy-minimum-fee',[{address:fundingAddress,value:10000000,
    assets:[{tokenId:tokens.MinFeeNFT,amount:1},{tokenId:tokens.Asset,amount:1}],registers:feeRegisters}]);
  const seed={tokens,contracts,fundingAddress,minimumFee:{nft:tokens.MinFeeNFT,ergoTree:tree(fundingAddress),minConfirmations:1}};
  const watchers=privateKeys.watchers.map((k,i)=>({WID:tokens['WID'+(i+1)],address:wasm.SecretKey.dlog_from_bytes(Buffer.from(k,'hex')).get_address().to_base58(wasm.NetworkPrefix.Testnet)}));
  const setup=watcherSetupRequests({deployment:seed,watchers,wasm});
  const requests=[{address:contracts.GuardSign.address,value:10000000,assets:[{tokenId:tokens.GuardNFT,amount:1}],registers:{R4:wasm.Constant.from_coll_coll_byte(guardPublicKeys.map(k=>Buffer.from(k,'hex'))).encode_to_base16(),R5:wasm.Constant.from_i32_array(Int32Array.from([3,3])).encode_to_base16()}},
    {address:contracts.Lock.address,value:1000000000,assets:[{tokenId:tokens.Asset,amount:999999999}]},...setup.requests];
  const done=await fund('deploy-authority',requests),outputs=done.transaction.outputs;
  const withToken=id=>outputs.find(b=>b.assets.some(a=>a.tokenId===id));
  const deployment={...seed,threshold:3,guardPublicKeys,guard:withToken(tokens.GuardNFT),lock:outputs.find(b=>b.ergoTree===contracts.Lock.tree),
    repoConfigBox:withToken(tokens.RepoConfigNFT),RWTRepoBox:withToken(tokens.RWTRepoNFT),
    watchers:watchers.map(w=>({...w,WIDBox:withToken(w.WID),permitBoxes:outputs.filter(b=>b.ergoTree===contracts.Permit.tree&&Buffer.from(wasm.ErgoBox.from_json(JSON.stringify(b)).register_value(4).to_byte_array()).toString('hex')===w.WID),feeBoxes:outputs.filter(b=>b.ergoTree===tree(w.address)&&b.assets.length===0)})),
    transactionId:done.txId,sourceCommit:'1b892c43f2d45eb6916f35e2edbb7560a4569f8e'};
  put('deployment.json',deployment);return {...deployment,watchers:deployment.watchers.map((w,i)=>({...w,secretKey:privateKeys.watchers[i]})),guardSecrets:privateKeys.guards};
}
