import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {decodeDepositData} from './depositDelivery.mjs';

const hash=value=>assert(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),'Discovery hash');
const policyKeys=['genesis','vaultSpend','vaultEpoch','destinationAsset'];
const capturePolicy=policy=>{
  assert(policy&&Object.keys(policy).sort().join(',')===[...policyKeys].sort().join(','),'Discovery policy');
  for(const key of ['genesis','vaultSpend','destinationAsset'])hash(policy[key]);
  assert(typeof policy.vaultEpoch==='string'&&/^[1-9][0-9]{0,19}$/.test(policy.vaultEpoch)&&BigInt(policy.vaultEpoch)<=0xffffffffffffffffn,'Discovery epoch');
  return Object.freeze({...policy});
};

/** Classification only: a candidate still needs fresh inclusion/ownership/proof
 * and permanent output admission. Unsupported on-chain memos cannot stall the
 * unrelated scanner stream; malformed parser responses and source bytes can. */
export function discoveredCandidate(transaction,result,policy){
  assert(result&&Object.keys(result).sort().join(',')==='data,txId','Discovery response');
  assert.equal(result.txId,transaction.txId,'Discovery transaction binding');
  assert(Array.isArray(result.data)&&result.data.length<=1060&&result.data.every(value=>
    typeof value==='string'&&/^(?:[0-9a-f]{2}){1,254}$/.test(value)),'Discovery data shape');
  let memo;try{memo=decodeDepositData(result.data);}catch{return undefined;}
  if(!memo||memo.sourceNetwork!=='mainnet'||memo.destinationNetwork!=='ergo-testnet'||
      policyKeys.some(key=>memo[key]!==policy[key]))return undefined;
  return {txId:transaction.txId,transactionHex:transaction.transactionHex};
}

async function binaryDigest(binary){
  const stat=await lstat(binary);assert(stat.isFile()&&!stat.isSymbolicLink(),'Discovery binary file');
  const digest=createHash('sha256');for await(const bytes of createReadStream(binary))digest.update(bytes);
  return digest.digest('hex');
}
export function createNativeDepositDecoder({binary,sha256,policy,timeoutMs=15000}){
  assert(isAbsolute(binary??''),'Discovery binary path');hash(sha256);
  assert(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=30000,'Discovery timeout');
  const retained=capturePolicy(policy);
  return async transaction=>{
    hash(transaction?.txId);
    assert(typeof transaction.transactionHex==='string'&&transaction.transactionHex.length<=2*1024*1024&&
      /^(?:[0-9a-f]{2})+$/.test(transaction.transactionHex),'Discovery transaction bytes');
    const selected=Object.freeze({txId:transaction.txId,transactionHex:transaction.transactionHex});
    assert.equal(await binaryDigest(binary),sha256,'Discovery binary pin');
    const input=JSON.stringify({txBytes:selected.transactionHex,txId:selected.txId})+'\n';
    const output=await new Promise((resolve,reject)=>{
      const child=execFile(binary,['discover-deposit'],{windowsHide:true,shell:false,timeout:timeoutMs,
        killSignal:'SIGKILL',maxBuffer:8192,encoding:'utf8'},(error,stdout,stderr)=>{
        if(error||stderr)reject(Error('Discovery native parser failed'));else resolve(stdout);
      });
      child.stdin.once('error',()=>{});child.stdin.end(input);
    });
    assert.equal(await binaryDigest(binary),sha256,'Discovery binary pin');
    let result;try{
      assert(/^[\x00-\x7f]*\n$/.test(output),'Discovery frame');result=JSON.parse(output);
      assert.equal(JSON.stringify({data:result.data,txId:result.txId})+'\n',output,'Discovery canonical response');
    }catch{throw Error('Discovery native response failed');}
    return discoveredCandidate(selected,result,retained);
  };
}
