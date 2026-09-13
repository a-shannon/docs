import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {encodeIntent} from '../packages/monero-deposit/lib/intentCodec';
import {verifyDeposit} from '../packages/monero-deposit/lib/depositPolicy';
import {NATIVE_SOURCE_PIN,type VerificationProviders} from '../packages/monero-deposit/lib/evidence';
import {inspectParticipantDeposit} from './participantSigning.mjs';
import type {LocalMonero} from './localMonero';
import type {DepositContext} from '../guard-service/src/deposit/depositAdmission';

const require=createRequire(import.meta.url),wasm=require('ergo-lib-wasm-nodejs');
const root=resolve(new URL('..',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'));
const wslPath=(path:string)=>{const p=path.replaceAll('\\','/');if(!/^[A-Za-z]:\//.test(p))throw Error('Proof local path');return '/mnt/'+p[0].toLowerCase()+p.slice(2);};
export async function nativeProof(mode:'produce'|'verify',request:any,runtime:string,keyPath?:string):Promise<any>{
  const dir=mkdtempSync(join(runtime,'proof-')),file=join(dir,'request.json');
  writeFileSync(file,JSON.stringify(request),{flag:'wx'});
  const args=['-d',config.wslDistro,'--','python3',wslPath(join(root,'proof/run.py')),mode,wslPath(file)];
  if(mode==='produce'){if(!keyPath)throw Error('Proof key capability');args.push(wslPath(keyPath));}
  return new Promise((resolve,reject)=>{
    const child=spawn('wsl.exe',args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let out=Buffer.alloc(0),failed=false;
    const timer=setTimeout(()=>{failed=true;child.kill();},45000);
    child.once('error',()=>{failed=true;});child.stderr.resume();
    child.stdout.on('data',chunk=>{out=Buffer.concat([out,chunk]);if(out.length>100000){failed=true;child.kill();}});
    child.once('close',code=>{clearTimeout(timer);try{
      if(code!==0||failed)throw Error();const value=JSON.parse(out.toString('utf8'));
      if(Object.keys(value).sort().join(',')!=='good,messageHex,proof,received,sourcePin,txId,vaultAddress'||
        value.sourcePin!==NATIVE_SOURCE_PIN||value.txId!==request.txId||value.vaultAddress!==request.vaultAddress||
        value.messageHex!==request.messageHex||typeof value.good!=='boolean'||!/^(0|[1-9][0-9]{0,19})$/.test(value.received)||
        typeof value.proof!=='string'||value.proof.length>65546||(mode==='verify'&&value.proof!==request.proof))throw Error();
      resolve(value);
    }catch{reject(Error('Native transaction proof refused'));}});
  });
}

/** Fresh local-chain composition: fixed snapshot, native ownership and actual OutProofV2. */
export async function buildDepositSource(vault:any,node:LocalMonero,runtime:string,recipient:string,asset:string){
  const inspected=await inspectParticipantDeposit(vault),d=inspected.deposit,o=inspected.observation;
  if(wasm.Address.from_base58(recipient).to_base58(wasm.NetworkPrefix.Testnet)!==recipient||!/^[0-9a-f]{64}$/.test(asset))throw Error('Ergo source configuration');
  const snapshot={id:createHash('sha256').update(vault.genesis+o.snapshot.hash).digest('hex'),network:'mainnet' as const,
    txid:d.txId,blockHash:d.blockHash,blockHeight:BigInt(d.blockHeight),chainHeight:BigInt(o.snapshot.height),minConfirmations:2n};
  const context:DepositContext={id:'local-roundtrip-'+vault.genesis,revision:1n,configurationRevision:'local-protocol16-v1',
    configuration:{version:2,domain:'rosen-monero-deposit',sourceNetwork:'mainnet',vaultEpoch:'1',vaultAddress:vault.vaultAddress,
      destinationNetwork:'ergo-testnet',destinationAsset:asset,nativeSourcePin:NATIVE_SOURCE_PIN},
    feePolicy:{bridgeFee:'100',networkFee:'20',sourceDecimals:12,destinationDecimals:12,remainder:'reject'},snapshot};
  const intentBytes=encodeIntent({version:2,domain:context.configuration.domain,source_network:'mainnet',vault_epoch:'1',vault_address:vault.vaultAddress,
    destination_network:'ergo-testnet',destination_asset:asset,bridge_fee:'100',network_fee:'20',txid:d.txId,to_address:recipient,
    amount:d.amountAtomic,expiry_height:snapshot.chainHeight+100n,outputs:[{output_index:BigInt(d.outputIndex),output_public_key:d.outputKey,amount:d.amountAtomic}]});
  const proofRequest={txHex:d.txBytes,txId:d.txId,vaultAddress:vault.vaultAddress,messageHex:Buffer.from(intentBytes).toString('hex'),proof:''};
  const generated=await nativeProof('produce',proofRequest,runtime,inspected.donorProofKeyPath);
  if(!generated.good||generated.received!==d.amountAtomic)throw Error('Generated deposit proof');
  async function current(){
    const info=await node.isolated(),genesis=await node.rpc('get_block_header_by_height',{height:0}),tip=await node.rpc('get_block_header_by_height',{height:o.snapshot.height-1});
    if(info.height!==o.snapshot.height||genesis.block_header.hash!==vault.genesis||tip.block_header.hash!==o.snapshot.hash)throw Error('Deposit snapshot changed');
    const found=(await node.transaction(d.txId)).txs;
    if(found.length!==1||found[0].in_pool||found[0].as_hex!==d.txBytes||found[0].block_height!==d.blockHeight)throw Error('Deposit inclusion changed');
    const block=await node.rpc('get_block',{height:d.blockHeight});
    if(block.block_header.hash!==d.blockHash||!block.tx_hashes.includes(d.txId))throw Error('Deposit canonical block');
    const spent=await node.call('/is_key_image_spent',{key_images:[o.keyImage]});
    if(spent.status!=='OK'||spent.spent_status.length!==1||spent.spent_status[0]!==0)throw Error('Deposit spent state changed');
    const closingGenesis=await node.rpc('get_block_header_by_height',{height:0}),closingTip=await node.rpc('get_block_header_by_height',{height:o.snapshot.height-1}),
      closingBlock=await node.rpc('get_block_header_by_height',{height:d.blockHeight}),after=await node.isolated();
    const finalTip=await node.rpc('get_last_block_header');
    if(finalTip.block_header.height!==o.snapshot.height-1||finalTip.block_header.hash!==o.snapshot.hash||
      after.height!==o.snapshot.height||closingGenesis.block_header.hash!==vault.genesis||closingTip.block_header.hash!==o.snapshot.hash||
      closingBlock.block_header.hash!==d.blockHash)throw Error('Deposit snapshot changed');
  }
  const identity=(id:string)=>({kind:'independent' as const,id,sourcePin:NATIVE_SOURCE_PIN});
  const providers:VerificationProviders={
    proof:{identity:identity('actual-core-outproof-v2'),async verify(request){
      await current();
      const result=await nativeProof('verify',{...proofRequest,txId:request.txid,vaultAddress:request.vaultAddress,
        messageHex:Buffer.from(request.messageBytes).toString('hex'),proof:request.proof},runtime);
      await current();return {status:'verified',value:{...request,good:result.good,received:BigInt(result.received),inPool:false,confirmations:snapshot.chainHeight-snapshot.blockHeight}};
    }},
    receipt:{identity:identity('two-original-holders-full-local-history'),async reconstruct(intent,_evidence,requested){
      await current();if(intent.txid!==d.txId||intent.vault_address!==vault.vaultAddress||requested.id!==snapshot.id)throw Error('Receipt request binding');
      return {status:'verified',value:{network:'mainnet',txid:d.txId,vaultAddress:vault.vaultAddress,blockHash:d.blockHash,blockHeight:BigInt(d.blockHeight),
        snapshotId:snapshot.id,inPool:false,outputs:[{index:BigInt(d.outputIndex),publicKey:d.outputKey,amount:BigInt(d.amountAtomic),owned:true,
          maturity:'unlocked',spent:'unspent',keyOccurrences:BigInt(o.historyOccurrences)}]}};
    }},
    addresses:{identity:identity('native-vault-and-ergo-wasm-address'),async verify(request){
      if(request.sourceNetwork!=='mainnet'||request.vaultAddress!==vault.vaultAddress||request.destinationNetwork!=='ergo-testnet'||
        request.destinationAsset!==asset||request.recipient!==recipient||wasm.Address.from_base58(request.recipient).to_base58(wasm.NetworkPrefix.Testnet)!==request.recipient)throw Error('Deposit address binding');
      return {status:'verified',value:request};
    }},
  };
  const request={intentBytes,proof:generated.proof,receiptEvidence:{txid:d.txId}};
  const decision=await verifyDeposit(intentBytes,generated.proof,request.receiptEvidence,{...context.configuration,snapshot,
    creditedDepositIds:new Set(),creditedOutputIds:new Set()},context.feePolicy,providers);
  if(decision.status!=='accepted')throw Error('Deposit policy '+decision.status+':'+decision.reason);
  return {context,request,providers,decision,observation:o,deposit:d,current,proofRequest:{...proofRequest,proof:generated.proof}};
}
