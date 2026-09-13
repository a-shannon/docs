import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {canonical} from './participantHarness.mjs';
import {recoverDistributedWithdrawal} from './distributedIssuer';
import {MoneroPaymentLifecycle,type MoneroFinal,type MoneroObservation,type MoneroPaymentBinding} from '../guard-service/src/transaction/moneroPaymentLifecycle';
import type {LocalMonero} from './localMonero';
import type {DataSource} from '@rosen-bridge/extended-typeorm';

const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function nativeObserve(binary:string,sha256:string,directory:string,expectationDigest:string):Promise<any>{
  if(digest(readFileSync(binary))!==sha256||!/^[0-9a-f]{64}$/.test(expectationDigest))throw Error('Observation executable anchor');
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,['observe',directory,expectationDigest],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let output=Buffer.alloc(0),failed=false;const timer=setTimeout(()=>{failed=true;child.kill();},30000);
    child.once('error',()=>{failed=true;});child.stderr.resume();
    child.stdout.on('data',chunk=>{output=Buffer.concat([output,chunk]);if(output.length>4096){failed=true;child.kill();}});
    child.once('close',code=>{clearTimeout(timer);try{
      if(code!==0||failed||output.at(-1)!==10)throw Error();const text=output.subarray(0,-1).toString('ascii'),value=JSON.parse(text);
      if(canonical(value)!==text||value.type!=='observed'||!/^[0-9a-f]{64}$/.test(value.txId)||!/^[0-9a-f]{64}$/.test(value.blockHash)||
        !Number.isSafeInteger(value.blockHeight)||value.blockHeight<0||['inputAtomic','recipientAtomic','feeAtomic','changeAtomic'].some(k=>!/^(0|[1-9][0-9]{0,19})$/.test(value[k]))||
        ['recipientOutputKey','changeOutputKey'].some(k=>!/^[0-9a-f]{64}$/.test(value[k]))||
        ['recipientOutputIndex','changeOutputIndex'].some(k=>!Number.isSafeInteger(value[k])||value[k]<0))throw Error();
      resolve(value);
    }catch{reject(Error('Native final observation refused'));}});
  });
}

export function createRoundtripPayment({node,binary,sha256,vault,owner,database,dataSource,lostSubmissionReply=false}:
  {node:LocalMonero,binary:string,sha256:string,vault:any,owner:any,database:string,dataSource:DataSource,lostSubmissionReply?:boolean}){
  const d=owner.disposition,proposalId=owner.transaction.txId,reservationId=owner.reservationId;
  const binding:MoneroPaymentBinding={reservationId,proposalId,obligationId:owner.transaction.eventId,eventId:owner.transaction.eventId,
    originalTxJson:owner.transaction.toJson(),inputReferences:[...d.inputReferences],changeIdentity:d.changeIdentity,
    requiredConfirmations:2,recipientAtomic:d.recipientAtomic,changeAtomic:d.changeAtomic};
  const counters={signCalls:0,recoveries:0,submissions:0,scans:0},submitted:string[]=[],observations:any[]=[];
  async function network(){
    const info=await node.isolated(),genesis=await node.rpc('get_block_header_by_height',{height:0});
    if(genesis.block_header.hash!==vault.genesis)throw Error('Payment network changed');return info;
  }
  async function recover():Promise<MoneroFinal>{
    counters.recoveries++;const final=await recoverDistributedWithdrawal(database,reservationId,binary,sha256);
    if(final.reservationId!==reservationId)throw Error('Payment reservation changed');
    return {reservationId,proposalId,finalTxId:final.txId,byteDigest:final.byteDigest,txBytes:final.txBytes,
      spentInputs:[...d.inputReferences],changeIdentity:d.changeIdentity};
  }
  async function observe(final:MoneroFinal):Promise<MoneroObservation>{
    const info=await network(),opening=await node.rpc('get_last_block_header');
    if(opening.block_header.height!==info.height-1||!/^[0-9a-f]{64}$/.test(opening.block_header.hash))throw Error('Payment opening snapshot');
    const result=await node.transaction(final.finalTxId),rows=result.txs??[];
    const pending={finalTxId:final.finalTxId,tipHeight:info.height-1,recipientMatches:false,inPool:false};
    if(rows.length===0)return pending;
    if(rows.length!==1||rows[0].tx_hash!==final.finalTxId||rows[0].as_hex!==Buffer.from(final.txBytes).toString('hex'))throw Error('Payment node bytes changed');
    if(rows[0].in_pool)return {...pending,inPool:true};
    const scanned=await nativeObserve(binary,sha256,owner.anchor.nativeDirectory,owner.anchor.expectationDigest);counters.scans++;
    if(scanned.txId!==final.finalTxId||scanned.changeOutputKey!==d.changeIdentity||scanned.changeOutputIndex!==d.changeOutputIndex||
      scanned.recipientOutputKey===scanned.changeOutputKey||scanned.recipientOutputIndex===scanned.changeOutputIndex||
      BigInt(scanned.inputAtomic)!==BigInt(scanned.recipientAtomic)+BigInt(scanned.feeAtomic)+BigInt(scanned.changeAtomic))throw Error('Payment observation binding');
    const header=await node.rpc('get_block_header_by_height',{height:scanned.blockHeight}),after=await network(),closing=await node.rpc('get_last_block_header');
    // The last deciding read is one tip marker: a later network read cannot conceal a same-height change.
    if(header.block_header.hash!==scanned.blockHash||after.height!==info.height||closing.block_header.height!==opening.block_header.height||
      closing.block_header.hash!==opening.block_header.hash)throw Error('Payment canonical block changed');
    observations.push(scanned);
    return {finalTxId:final.finalTxId,tipHeight:after.height-1,blockHeight:scanned.blockHeight,blockHash:scanned.blockHash,
      canonicalBlockHash:header.block_header.hash,recipientMatches:true,recipientAtomic:scanned.recipientAtomic,changeAtomic:scanned.changeAtomic,inPool:false};
  }
  const ports={dataSource,requiredConfirmations:2,recoverFinal:async(id:string)=>{if(id!==reservationId)throw Error('Payment recovery identity');return recover();},observe,
    submit:async(final:MoneroFinal)=>{await network();const response=await node.submit(final.txBytes);if(response.status!=='OK')throw Error('Payment submission rejected');
      counters.submissions++;submitted.push(final.byteDigest);if(lostSubmissionReply&&counters.submissions===1)throw Error('fixture-lost-submission-reply');}};
  return {binding,create:()=>new MoneroPaymentLifecycle(ports),sign:async()=>{counters.signCalls++;return owner.sign();},recover,
    counts:()=>({...counters}),submitted:()=>[...submitted],observations:()=>[...observations]};
}
