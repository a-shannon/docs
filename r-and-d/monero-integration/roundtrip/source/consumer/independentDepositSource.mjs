import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {spawn} from 'node:child_process';
import {canonical} from './participantHarness.mjs';
import {captureAuthenticatedDepositSource} from './authenticatedDepositSource.mjs';
import {decodeDepositMemo,extractDepositMemo,verifyMemoIntent} from './depositDelivery.mjs';

const MAX_FRAME=65536;
const fields=(value,expected)=>{assert(value!==null&&typeof value==='object'&&!Array.isArray(value),'Observer object');assert.deepEqual(Object.keys(value).sort(),[...expected].sort(),'Observer closed schema');};
const hex32=value=>assert(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)&&value!=='00'.repeat(32),'Observer nonzero hash');
const integer=value=>assert(Number.isSafeInteger(value)&&value>=0&&value<=0xffffffff,'Observer bounded integer');
const decimal=value=>assert(typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=0xffffffffffffffffn,'Observer canonical amount');
export function observerRequest(publicScan,observerNonce){
  const opted=Object.hasOwn(publicScan,'sourcePolicy');if(opted)assert.equal(publicScan.sourcePolicy,'authenticated-backing-v1','Observer source policy');
  fields(publicScan,['groupPublicKey','genesis','snapshot','source','keyImage',...(opted?['sourcePolicy']:[])]);hex32(observerNonce);for(const key of ['groupPublicKey','genesis','keyImage'])hex32(publicScan[key]);
  fields(publicScan.snapshot,['height','hash']);integer(publicScan.snapshot.height);assert(publicScan.snapshot.height>0&&publicScan.snapshot.height<=4096);hex32(publicScan.snapshot.hash);
  const source=publicScan.source;fields(source,['kind','startHeight','blockHashes','ringIndices','outputIds','deposit']);assert.equal(source.kind,'deposit');integer(source.startHeight);assert(source.startHeight+18<=publicScan.snapshot.height);
  assert(Array.isArray(source.blockHashes)&&source.blockHashes.length===18);source.blockHashes.forEach(hex32);assert(Array.isArray(source.ringIndices)&&source.ringIndices.length===16);source.ringIndices.forEach(integer);assert(Array.isArray(source.outputIds)&&source.outputIds.length===2);
  for(const id of source.outputIds){fields(id,['transaction','index','chainIndex']);hex32(id.transaction);integer(id.index);integer(id.chainIndex);}
  const deposit=source.deposit;fields(deposit,['txId','txBytes','blockHash','blockHeight','outputKey','outputIndex','chainIndex','amountAtomic','feeAtomic']);for(const key of ['txId','blockHash','outputKey'])hex32(deposit[key]);assert(typeof deposit.txBytes==='string'&&/^(?:[0-9a-f]{2})+$/.test(deposit.txBytes));for(const key of ['blockHeight','outputIndex','chainIndex'])integer(deposit[key]);assert(deposit.blockHeight+60<=publicScan.snapshot.height);decimal(deposit.amountAtomic);decimal(deposit.feeAtomic);
  const request={observerNonce,...structuredClone(publicScan)},frame=canonical(request)+'\n';assert(Buffer.byteLength(frame)<=MAX_FRAME&&/^[\x00-\x7f]*$/.test(frame),'Observer input frame bound');return request;
}
export function observerRequestDigest(request){return createHash('sha256').update('rosen-monero/public-source-observer/v1').update(Buffer.from([0])).update(canonical(request)).digest('hex');}
export function validateObserverResult(frame,request){
  const bytes=Buffer.isBuffer(frame)?frame:Buffer.from(frame);assert(bytes.length<=MAX_FRAME&&bytes.at(-1)===10&&!bytes.some(b=>b>127),'Observer output frame bound');const text=bytes.subarray(0,-1).toString('ascii'),result=JSON.parse(text);assert.equal(canonical(result),text,'Observer canonical output');
  const opted=Object.hasOwn(request,'sourcePolicy');if(opted)assert.equal(request.sourcePolicy,'authenticated-backing-v1','Observer source policy');
  fields(result,['type','observerNonce','observerKind','genesis','snapshot','vaultAddress','sourceRequestDigest','outputs','suppliedKeyImage','suppliedKeyImageSpentStatus','imageAssociationVerified',...(opted?['sourcePolicy']:[])]);
  if(opted)assert.equal(result.sourcePolicy,request.sourcePolicy,'Observer policy binding');
  assert.equal(result.type,'public-source-observation');assert.equal(result.observerKind,'local-fixture-fixed-view-v1');assert.equal(result.observerNonce,request.observerNonce,'Observer nonce binding');assert.equal(result.sourceRequestDigest,observerRequestDigest(request),'Observer exact source request binding');assert.equal(result.genesis,request.genesis);assert.deepEqual(result.snapshot,request.snapshot);assert.equal(result.suppliedKeyImage,request.keyImage);assert.equal(result.suppliedKeyImageSpentStatus,0);assert.equal(result.imageAssociationVerified,false,'Public reader cannot attest image association');
  assert(typeof result.vaultAddress==='string'&&/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{95}$/.test(result.vaultAddress),'Observer vault address');assert(Array.isArray(result.outputs)&&result.outputs.length===1,'Observer qualifying output count');
  const output=result.outputs[0],deposit=request.source.deposit;fields(output,['txId','blockHash','blockHeight','publicKey','outputIndex','chainIndex','amountAtomic','feeAtomic','owned','maturity','historyOccurrences']);
  for(const field of ['txId','blockHash','blockHeight','outputIndex','chainIndex','amountAtomic','feeAtomic'])assert.equal(output[field],deposit[field],'Observer deposit '+field);assert.equal(output.publicKey,deposit.outputKey,'Observer output key');assert.equal(output.owned,true);assert.equal(output.maturity,'unlocked');
  if(opted){integer(output.historyOccurrences);assert(output.historyOccurrences>0,'Observer positive occurrence count');}else assert.equal(output.historyOccurrences,1,'Observer full-history output uniqueness');return Object.freeze(result);
}

/** A fresh process reconstructs public fixed-view source evidence for every call. */
export async function independentlyVerifyDeposit({binary,sha256,publicScan,runtimeDirectory,observerId}){
  assert(isAbsolute(binary)&&isAbsolute(runtimeDirectory)&&statSync(runtimeDirectory).isDirectory(),'Observer absolute runtime');assert(typeof observerId==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(observerId),'Observer identity');assert.match(sha256,/^[0-9a-f]{64}$/);assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'),sha256,'Observer binary pin');
  const port=process.env.MONERO_LOCAL_RPC_PORT;assert(typeof port==='string'&&/^[1-9][0-9]{0,4}$/.test(port)&&Number(port)<=65535,'Observer owned local RPC port');
  const request=observerRequest(publicScan,randomBytes(32).toString('hex'));
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,['scan-source'],{cwd:runtimeDirectory,env:{...process.env,MONERO_LOCAL_RPC_PORT:port},windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});let output=Buffer.alloc(0),stderrBytes=0,failed=false;
    const fail=()=>{failed=true;child.kill();},timer=setTimeout(fail,60000);child.once('error',fail);child.stdin.on('error',fail);
    child.stdout.on('data',chunk=>{if(output.length+chunk.length>MAX_FRAME){fail();return;}output=Buffer.concat([output,chunk]);});child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>4096)fail();});
    child.once('close',code=>{clearTimeout(timer);try{assert(!failed&&code===0,'Observer process refused');resolve(validateObserverResult(output,request));}catch(error){reject(error);}});
    // The native reader reads through EOF. No request or key file is created.
    child.stdin.end(canonical(request)+'\n');
  });
}

/** Keeps actual fresh proof/address ports and replaces the prior cached receipt port. */
export function makeIndependentDepositProviders({source,publicScan=source.publicScan,binary,sha256,runtimeDirectory,observerId}){
  const authenticated=()=>{if(source.context?.configuration?.outputHistoryPolicy!==undefined||publicScan?.sourcePolicy!==undefined){captureAuthenticatedDepositSource(source);assert.equal(source.context.configuration.outputHistoryPolicy,'authenticated-backing-v1');assert.equal(publicScan.sourcePolicy,'authenticated-backing-v1');assert.equal(source.publicScan.sourcePolicy,publicScan.sourcePolicy);}};
  authenticated();
  assert(source?.providers&&typeof source.current==='function');const scan=structuredClone(publicScan),receipts=[],counts={proofCalls:0,receiptCalls:0,addressCalls:0};
  observerRequest(scan,'01'.repeat(32));assert.deepEqual(scan.source.deposit,source.deposit,'Independent source seed binding');assert.equal(scan.genesis,source.publicScan.genesis);assert.equal(scan.keyImage,source.observation.keyImage,'Original-holder supplied image binding');
  const providers={
    proof:{identity:source.providers.proof.identity,async verify(request){authenticated();counts.proofCalls++;return source.providers.proof.verify(request);}},
    addresses:{identity:source.providers.addresses.identity,async verify(request){counts.addressCalls++;return source.providers.addresses.verify(request);}},
    receipt:{identity:{kind:'independent',id:'fresh-local-fixed-view-'+observerId,sourcePin:source.providers.receipt.identity.sourcePin},async reconstruct(intent,_evidence,snapshot){
      authenticated();counts.receiptCalls++;await source.current();
      if(source.context.configuration.depositData!==undefined){
        const memo=await extractDepositMemo({binary,sha256,txId:scan.source.deposit.txId,txBytes:scan.source.deposit.txBytes});
        assert(memo,'Missing transaction deposit memo');
        assert.deepEqual(memo,decodeDepositMemo(Buffer.from(source.context.configuration.depositData,'hex')),'Reader memo agreement');
        verifyMemoIntent(memo,intent,{genesis:scan.genesis,vaultSpend:scan.groupPublicKey});
      }
      const result=await independentlyVerifyDeposit({binary,sha256,publicScan:scan,runtimeDirectory,observerId});await source.current();authenticated();
      const deposit=scan.source.deposit;assert.equal(intent.txid,deposit.txId);assert.equal(intent.vault_address,result.vaultAddress);assert.equal(result.vaultAddress,source.context.configuration.vaultAddress);assert.equal(snapshot.id,source.context.snapshot.id);assert.equal(snapshot.network,'mainnet');assert.equal(snapshot.txid,deposit.txId);assert.equal(snapshot.blockHash,deposit.blockHash);assert.equal(snapshot.blockHeight,BigInt(deposit.blockHeight));assert.equal(snapshot.chainHeight,BigInt(scan.snapshot.height));
      receipts.push(result);return {status:'verified',value:{network:'mainnet',txid:deposit.txId,vaultAddress:result.vaultAddress,blockHash:deposit.blockHash,blockHeight:BigInt(deposit.blockHeight),snapshotId:snapshot.id,inPool:false,outputs:result.outputs.map(output=>({index:BigInt(output.outputIndex),publicKey:output.publicKey,amount:BigInt(output.amountAtomic),owned:output.owned,maturity:output.maturity,spent:'unspent',keyOccurrences:BigInt(output.historyOccurrences)}))}};
    }}
  };
  return {providers,stats:()=>Object.freeze({...counts}),receipts:()=>structuredClone(receipts)};
}

/** Each watcher or guard invokes policy again on the exact raw supplied request. */
export async function independentlyDecideDeposit({source,rawRequest,providers}){
  if(source.context?.configuration?.outputHistoryPolicy!==undefined||source.publicScan?.sourcePolicy!==undefined)captureAuthenticatedDepositSource(source);
  const {verifyDeposit}=await import('../packages/monero-deposit/lib/depositPolicy.ts');
  return verifyDeposit(rawRequest.intentBytes,rawRequest.proof,rawRequest.receiptEvidence,{...source.context.configuration,snapshot:source.context.snapshot,creditedDepositIds:new Set(),creditedOutputIds:new Set()},source.context.feePolicy,providers);
}
