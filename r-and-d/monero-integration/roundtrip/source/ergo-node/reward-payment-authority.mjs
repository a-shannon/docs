import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {retainCreditRecord} from './credit-recovery.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=value=>assert(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),'Reward payment hash');
function wire(value,cap){assert(typeof value==='string'&&value.length>0&&value.length<=cap*2&&/^(?:[0-9a-f]{2})+$/.test(value),'Reward transcript bytes');return Buffer.from(value,'hex');}
function read(file,cap){const fd=fs.openSync(file,'r');try{const stat=fs.fstatSync(fd);assert(stat.isFile()&&stat.size>0&&stat.size<=cap,'Reward transcript size');
  const bytes=Buffer.alloc(stat.size+1),n=fs.readSync(fd,bytes,0,bytes.length,0);assert.equal(n,stat.size,'Reward transcript drift');return bytes.subarray(0,n);}finally{fs.closeSync(fd);}}

/** Export verification transcripts only. No signing shares or nonce state. */
export function exportRewardPaymentEvidence(anchor){
  const expectation=read(path.join(anchor.nativeDirectory,'expectation.private'),65536),terminal=read(path.join(anchor.nativeDirectory,'terminal.private'),32768);
  assert.equal(hash(expectation),anchor.expectationDigest,'Reward expectation anchor');
  return {expectationHex:expectation.toString('hex'),terminalHex:terminal.toString('hex')};
}
async function nodeRpc(endpoint,method,params={}){
  const direct=method==='get_transactions',route=direct?'/get_transactions':'/json_rpc';
  const response=await fetch(endpoint+route,{method:'POST',headers:{'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(20000),
    body:JSON.stringify(direct?params:{jsonrpc:'2.0',id:'reward-audit',method,params})});assert(response.ok,'Reward daemon HTTP');
  const reader=response.body.getReader(),parts=[];let size=0;
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2_097_152){await reader.cancel();throw Error('Reward daemon response bound');}parts.push(value);}
  const json=JSON.parse(Buffer.concat(parts).toString('utf8'));assert(!json.error,'Reward daemon RPC');return direct?json:json.result;
}
const local=info=>{assert(info.status==='OK'&&info.nettype==='fakechain'&&info.offline===true&&info.untrusted===false&&
  info.mainnet===false&&info.testnet===false&&info.stagenet===false&&info.incoming_connections_count===0&&info.outgoing_connections_count===0,'Reward daemon isolation');
  assert(Number.isSafeInteger(info.height)&&info.height>0,'Reward daemon height');};

/** Caller must bind anchor to its own retained settlement before and after this read. */
export async function verifyRewardPayment({anchor,evidence,source,binary,sha256,directory,paymentTxId},ports={}){
  const a=structuredClone(anchor),e=structuredClone(evidence),s=structuredClone(source);
  for(const value of [a.reservation.reservationId,a.expectationDigest,a.bindingDigest,a.requestDigest,paymentTxId,s.genesis])id(value);
  assert(path.isAbsolute(directory),'Reward custody directory');assert(Array.isArray(s.endpoints)&&s.endpoints.length===2&&new Set(s.endpoints).size===2,'Reward endpoints');
  const endpoints=s.endpoints.map(value=>{const u=new URL(value);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port&&u.pathname==='/'&&!u.username&&!u.password&&!u.search&&!u.hash,'Reward local endpoint');return u;});
  assert.deepEqual(Object.keys(e).sort(),['expectationHex','terminalHex'],'Reward transcript schema');
  const expectation=wire(e.expectationHex,65536),terminal=wire(e.terminalHex,32768);assert.equal(hash(expectation),a.expectationDigest,'Reward expectation anchor');
  const request=JSON.parse(a.reservation.requestJson);assert.equal(hash(request.canonicalRequest),a.requestDigest,'Reward retained request');
  assert.equal(request.requestDigest,a.requestDigest,'Reward request digest');const doc=JSON.parse(request.canonicalRequest);
  const home=path.join(directory,a.reservation.reservationId);fs.mkdirSync(home,{recursive:true});
  for(const [name,bytes] of [['expectation.private',expectation],['terminal.private',terminal]]){
    const file=path.join(home,name);if(fs.existsSync(file))assert.deepEqual(read(file,65536),bytes,'Reward retained transcript conflict');else retainCreditRecord(file,bytes);
  }
  const recover=ports.recover??(await import('../consumer/participantSigning.mjs')).recoverParticipantFinal;
  const observe=ports.observe??(await import('../consumer/roundtripPayment.ts')).nativeObserve,rpc=ports.rpc??nodeRpc;
  const final=await recover({binary,sha256,directory:home,expectationDigest:a.expectationDigest});
  assert.equal(final.expectationDigest,a.expectationDigest,'Reward recovered expectation');assert.equal(final.binding,a.bindingDigest,'Reward recovered binding');
  assert.equal(final.txId,paymentTxId,'Reward recovered payment');assert.equal(hash(wire(final.bytesHex,32768)),final.byteDigest,'Reward final bytes');
  const observations=[];
  for(const endpoint of endpoints){
    const opening=await rpc(endpoint.origin,'get_info');local(opening);
    const genesis=await rpc(endpoint.origin,'get_block_header_by_height',{height:0});assert.equal(genesis.block_header.hash,s.genesis,'Reward daemon genesis');
    const scanned=await observe(binary,sha256,home,a.expectationDigest,endpoint.port);
    assert.equal(scanned.txId,paymentTxId,'Reward observed payment');assert.equal(scanned.recipientAtomic,doc.netAtomicAmount,'Reward paid amount');
    const result=await rpc(endpoint.origin,'get_transactions',{txs_hashes:[paymentTxId],decode_as_json:false,prune:false});
    assert.equal(result.txs?.length,1,'Reward observed transaction');const row=result.txs[0];
    assert.equal(row.tx_hash,paymentTxId,'Reward daemon payment');assert.equal(row.as_hex,final.bytesHex,'Reward daemon bytes');
    assert.equal(row.in_pool,false,'Reward payment unconfirmed');assert.equal(row.block_height,scanned.blockHeight,'Reward payment inclusion');
    assert(Number.isSafeInteger(row.block_height)&&row.block_height>=0,'Reward inclusion height');
    assert(opening.height-row.block_height>=2,'Reward payment confirmations');
    const header=await rpc(endpoint.origin,'get_block_header_by_height',{height:row.block_height});assert.equal(header.block_header.hash,scanned.blockHash,'Reward canonical payment');
    const closing=await rpc(endpoint.origin,'get_info');local(closing);assert(closing.height>=opening.height,'Reward chain regression');
    const closingHeader=await rpc(endpoint.origin,'get_block_header_by_height',{height:row.block_height});assert.equal(closingHeader.block_header.hash,scanned.blockHash,'Reward canonical payment changed');
    assert.equal((await rpc(endpoint.origin,'get_block_header_by_height',{height:0})).block_header.hash,s.genesis,'Reward daemon genesis changed');
    observations.push(scanned);
  }
  assert.deepEqual(observations[0],observations[1],'Reward endpoint disagreement');
  return Object.freeze({paymentTxId,byteDigest:final.byteDigest,expectationDigest:a.expectationDigest,...observations[0]});
}
