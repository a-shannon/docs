import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,openSync,readSync,closeSync,fstatSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {spawn} from 'node:child_process';

// Experimental single-output XMR -> Ergo-testnet profile. All amounts are atomic.
// Fixed-width unsigned fields are big-endian; neither txid nor output key exists
// when this memo is constructed. The later canonical intent binds those fields.
const MAGIC=Buffer.from('RMD1'),NETWORKS=['mainnet','testnet','stagenet'];
const KEYS=['genesis','vaultSpend','sourceNetwork','destinationNetwork','vaultEpoch',
  'destinationAsset','amount','bridgeFee','networkFee','expiryHeight','recipient'];
const NUMBERS=['vaultEpoch','amount','bridgeFee','networkFee','expiryHeight'];
const hex32=value=>assert(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),'Delivery hash');
const uint=value=>{assert(typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=0xffffffffffffffffn,'Delivery uint64');return BigInt(value);};
export function encodeDepositMemo(value){
  assert(value&&Object.getPrototypeOf(value)===Object.prototype,'Memo object');
  assert.deepEqual(Object.keys(value).sort(),[...KEYS].sort(),'Memo schema');
  assert(NETWORKS.includes(value.sourceNetwork),'Memo source network');
  assert.equal(value.destinationNetwork,'ergo-testnet','Memo destination network');
  assert(typeof value.recipient==='string'&&/^[\x21-\x7e]{1,110}$/.test(value.recipient),'Memo recipient');
  const chunks=[MAGIC,Buffer.from([NETWORKS.indexOf(value.sourceNetwork),1])];
  for(const key of ['genesis','vaultSpend','destinationAsset']){hex32(value[key]);chunks.push(Buffer.from(value[key],'hex'));}
  for(const key of NUMBERS){const bytes=Buffer.alloc(8);bytes.writeBigUInt64BE(uint(value[key]));chunks.push(bytes);}
  assert(uint(value.amount)>uint(value.bridgeFee)+uint(value.networkFee),'Memo positive net amount');
  assert(uint(value.vaultEpoch)>0n,'Memo vault epoch');
  chunks.push(Buffer.from([value.recipient.length]),Buffer.from(value.recipient,'ascii'));
  const result=Buffer.concat(chunks);assert(result.length<=254,'Memo size');return result;
}
export function decodeDepositMemo(input){
  assert(input instanceof Uint8Array,'Memo bytes');const bytes=Buffer.from(input);
  assert(bytes.length>=144&&bytes.length<=254,'Memo size');
  assert(bytes.subarray(0,4).equals(MAGIC),'Memo version');
  assert(bytes[4]<NETWORKS.length&&bytes[5]===1,'Memo network');
  let offset=6;const value={sourceNetwork:NETWORKS[bytes[4]],destinationNetwork:'ergo-testnet'};
  for(const key of ['genesis','vaultSpend','destinationAsset']){value[key]=bytes.subarray(offset,offset+32).toString('hex');offset+=32;}
  for(const key of NUMBERS){value[key]=bytes.readBigUInt64BE(offset).toString();offset+=8;}
  const length=bytes[offset++];assert.equal(bytes.length,offset+length,'Memo trailing/truncated bytes');
  assert(bytes.subarray(offset).every(byte=>byte>=0x21&&byte<=0x7e),'Memo recipient ASCII');
  value.recipient=bytes.subarray(offset).toString('ascii');
  assert(encodeDepositMemo(value).equals(bytes),'Memo canonical bytes');return Object.freeze(value);
}
export function verifyMemoIntent(memo,intent,{genesis,vaultSpend}){
  assert.equal(memo.genesis,genesis,'Memo genesis');assert.equal(memo.vaultSpend,vaultSpend,'Memo vault spend key');
  assert.equal(intent.version,2,'Memo intent version');assert.equal(intent.domain,'rosen-monero-deposit','Memo intent domain');
  const fields={sourceNetwork:'source_network',destinationNetwork:'destination_network',vaultEpoch:'vault_epoch',destinationAsset:'destination_asset',
    amount:'amount',bridgeFee:'bridge_fee',networkFee:'network_fee',expiryHeight:'expiry_height',recipient:'to_address'};
  for(const [key,name]of Object.entries(fields))assert.equal(String(intent[name]),memo[key],'Memo intent '+name);
  assert.equal(intent.outputs.length,1,'Memo single output');
}
export function verifyDeliveryMode(depositData,loadRequest){
  assert(loadRequest===undefined||typeof loadRequest==='function','Guard delivery reader');
  assert.equal(depositData!==undefined,loadRequest!==undefined,'Guard memo/delivery mode');
  if(depositData!==undefined){
    assert(typeof depositData==='string'&&/^(?:[0-9a-f]{2}){1,254}$/.test(depositData),'Guard memo encoding');
    decodeDepositMemo(Buffer.from(depositData,'hex'));
  }
}
export function decodeDepositData(data){
  assert(Array.isArray(data)&&data.length<=1060,'Delivery data count');
  for(const item of data)assert(typeof item==='string'&&/^(?:[0-9a-f]{2}){1,254}$/.test(item),'Delivery memo encoding');
  // Unrelated wallet data is not a bridge deposit. A bridge memo uses exactly
  // one arbitrary-data field; recognized but unsupported versions fail closed.
  if(!data.some(item=>item.startsWith('524d44')))return undefined;
  assert.equal(data.length,1,'Delivery ambiguous memo');
  return decodeDepositMemo(Buffer.from(data[0],'hex'));
}

const MAX_ENVELOPE=74000;
function proofShape(proof){assert(typeof proof==='string'&&/^OutProofV2[1-9A-HJ-NP-Za-km-z]+$/.test(proof)&&proof.length<=65546&&(proof.length-10)>=132&&(proof.length-10)%132===0,'Delivery proof encoding');}
export function encodeDepositEnvelope(request){
  assert(request.intentBytes instanceof Uint8Array&&request.intentBytes.length>0&&request.intentBytes.length<=4096,'Delivery intent size');
  proofShape(request.proof);return Buffer.from(JSON.stringify([Buffer.from(request.intentBytes).toString('hex'),request.proof]));
}
export async function decodeDepositEnvelope(bytes,txId,memo,context){
  hex32(txId);assert(bytes instanceof Uint8Array&&bytes.length>0&&bytes.length<=MAX_ENVELOPE,'Delivery envelope size');
  const raw=Buffer.from(bytes),value=JSON.parse(raw.toString('utf8'));
  assert(Array.isArray(value)&&value.length===2&&typeof value[0]==='string'&&/^(?:[0-9a-f]{2}){1,4096}$/.test(value[0]),'Delivery envelope schema');
  const request={intentBytes:Uint8Array.from(Buffer.from(value[0],'hex')),proof:value[1],receiptEvidence:{txid:txId}};
  assert(encodeDepositEnvelope(request).equals(raw),'Delivery canonical envelope');
  const {decodeIntent}=await import('../packages/monero-deposit/lib/intentCodec.ts');
  const intent=decodeIntent(request.intentBytes);assert.equal(intent.txid,txId,'Delivery transaction');verifyMemoIntent(memo,intent,context);
  return request;
}
// Bounded filesystem transport for the experiment. A configured directory is
// the only delivery source; no depositor-supplied URL is ever fetched. The file
// is merely evidence input: callers must still verify proof and source afresh.
export async function loadDepositEnvelope(directory,txId,memo,context){
  assert(isAbsolute(directory),'Delivery directory');hex32(txId);
  const fd=openSync(join(directory,txId+'.proof'),'r');
  try{
    const st=fstatSync(fd);assert(st.isFile()&&st.size>0&&st.size<=MAX_ENVELOPE,'Delivery file size');
    const bytes=Buffer.alloc(st.size+1),length=readSync(fd,bytes,0,bytes.length,0);
    assert.equal(length,st.size,'Delivery file changed');return await decodeDepositEnvelope(bytes.subarray(0,length),txId,memo,context);
  }finally{closeSync(fd);}
}

/** Decode exact transaction bytes with the pinned Rust parser; chain authority
 * remains with each reader's existing native inclusion/ownership verification. */
export async function extractDepositMemo({binary,sha256,txId,txBytes}){
  hex32(txId);hex32(sha256);assert(isAbsolute(binary),'Delivery parser path');
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'),sha256,'Delivery parser pin');
  assert(typeof txBytes==='string'&&/^(?:[0-9a-f]{2})+$/.test(txBytes)&&txBytes.length<=60000,'Delivery transaction bytes');
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,['deposit-data'],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    let output=Buffer.alloc(0),failed=false;const fail=()=>{failed=true;child.kill();},timer=setTimeout(fail,15000);
    child.once('error',fail);child.stdin.on('error',fail);child.stderr.resume();
    child.stdout.on('data',chunk=>{if(output.length+chunk.length>8192){fail();return;}output=Buffer.concat([output,chunk]);});
    child.once('close',code=>{clearTimeout(timer);try{
      assert(!failed&&code===0,'Delivery native parser');const result=JSON.parse(output.toString('utf8'));
      assert.deepEqual(Object.keys(result).sort(),['data','txId'],'Delivery parser schema');assert.equal(result.txId,txId);
      resolve(decodeDepositData(result.data));
    }catch(error){reject(error);}});
    child.stdin.end(JSON.stringify({txBytes,txId})+'\n');
  });
}
