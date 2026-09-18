import {randomBytes,createHash} from 'node:crypto';
import {openSync,readSync,fstatSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {prepareParticipantSigning,recoverParticipantFinal} from './participantSigning.mjs';
import {captureUnapprovedMoneroPayoutRequest} from '../guard-service/src/withdrawal/moneroWithdrawalNativeProjection';
import {decodeNativeSelection} from '../guard-service/src/withdrawal/moneroWithdrawalSelection';
import {MoneroWithdrawalReservation} from '../guard-service/src/db/moneroWithdrawalReservation';
import {retainedRequest,retainedReceipt} from './retainedCodec';
import {frame,canonical,decimal,U64} from './codec';
import {captureAuthority,decodeApprovalDescriptor,bindVerifiedAgreement,ownData} from './approvalAuthority';
import {revalidateBackingClaim,assertBackingOccurrence,assertBackingSelection,reserveBackingSettlement,assertBackingSettlement} from './backingClaim.mjs';
import {WithdrawalJournal,type WithdrawalJournalAnchor} from './withdrawalJournal';
import type {AuthorizedWithdrawalSetup} from './retainedIssuer';

function boundedExpectation(path:string){
  const fd=openSync(path,'r');try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size<1||stat.size>65536)throw Error('distributed:expectation-bound');
    const buffer=Buffer.alloc(65537);let count=0,n=0;while(count<buffer.length&&(n=readSync(fd,buffer,count,buffer.length-count,null))>0)count+=n;
    if(count!==stat.size)throw Error('distributed:expectation-drift');return buffer.subarray(0,count);
  }finally{closeSync(fd);}
}

export async function openDistributedWithdrawal(vault:any,requestValue:unknown,setup:AuthorizedWithdrawalSetup,timestamp:number){
  const backingClaim=ownData(setup).backingClaim;
  if(backingClaim!==undefined)await revalidateBackingClaim(backingClaim);
  const authority=captureAuthority(setup.authority),authorityJson=JSON.stringify(authority);
  const currentAuthority=()=>{if(ownData(setup).backingClaim!==backingClaim||JSON.stringify(captureAuthority(setup.authority))!==authorityJson)throw Error('distributed:authority-changed');};
  const projection=await captureUnapprovedMoneroPayoutRequest(requestValue);
  const request=retainedRequest(projection,randomBytes(32).toString('hex'));
  currentAuthority();
  const held=await prepareParticipantSigning(vault,{request:request.hex,rosenKeys:[...authority.publicKeys],timestamp,backingClaim});
  let registry:MoneroWithdrawalReservation|undefined,closed=false;
  const live=()=>{if(closed)throw Error('distributed:retired');currentAuthority();};
  const close=async()=>{closed=true;try{await held.close();}finally{await registry?.close();registry=undefined;}};
  try{
    live();const c=held.candidate,selection=decodeNativeSelection(c.selection),f=frame(c.candidate);
    if(!/^[0-9a-f]{64}$/.test(c.changeOutputKey)||!Number.isSafeInteger(c.changeOutputIndex)||c.changeOutputIndex<0)throw Error('distributed:change-identity');
    const backingDigest=backingClaim===undefined?undefined:assertBackingSelection(backingClaim,{selection,genesis:vault.genesis,
      vaultSpend:vault.groupKey,vaultAddress:vault.vaultAddress,changeIdentity:c.changeOutputKey});
    const receipt=retainedReceipt(Buffer.from(c.receipt,'ascii').toString('hex'),projection,request.fields,selection.inputs.length);
    const payment=decimal(projection.amount),input=decimal(c.inputAtomic),change=decimal(c.changeAtomic),fee=decimal(receipt.necessaryFeeAtomic),ceiling=decimal(projection.ceiling);
    if(selection.network!==projection.network||selection.vaultSpend!==vault.groupKey||f.eventId!==projection.eventId||
      f.bytes.subarray(71,103).toString('hex')!==projection.instructionDigest||f.bytes.subarray(103,135).toString('hex')!==projection.requestDigest||
      input!==selection.inputs.reduce((n,p)=>n+BigInt(p.amount),0n)||input>U64||input!==payment+change+fee||fee>ceiling||
      c.txJson!==canonical(f.eventId,c.candidate,f.id))throw Error('distributed:semantic-binding');
    const snapshot=Object.freeze({...f,json:c.txJson,recipient:projection.address,payment,input,change,fee,ceiling,
      spend:selection.vaultSpend,view:selection.vaultView,count:selection.inputs.length,live});
    const descriptor=decodeApprovalDescriptor(Buffer.from(c.descriptor,'ascii').toString('hex'),snapshot,authority,vault.genesis);
    registry=await MoneroWithdrawalReservation.open(setup.database,{sourceNetwork:projection.sourceNetwork,network:projection.network,
      vaultSpend:selection.vaultSpend,vaultView:selection.vaultView},setup.clock,setup.fault);live();
    const reserved=await registry.reserve(projection.request,selection.bytes);live();
    if(reserved.status!=='created')throw Error('distributed:reservation-not-new');
    const owner=randomBytes(32).toString('hex'),claimed=await registry.claim(reserved.reservation.reservationId,owner,setup.leaseDuration);live();
    if(claimed.status!=='claimed')throw Error('distributed:claim');let callbacks=0;
    const committed=await registry.construct(claimed.fence,async record=>{
      live();if(++callbacks!==1||record.requestJson!==JSON.stringify(projection.request)||record.selectionBytes!==selection.bytes||
        record.owner!==owner||record.reservationHash!==reserved.reservation.reservationHash||record.eventId!==projection.eventId)throw Error('distributed:reservation-binding');
      return receipt;
    });live();
    if(committed.status!=='completed'||callbacks!==1)throw Error('distributed:reservation-commit');
    const reservation=committed.reservation;await registry.close();registry=undefined;live();
    // Native snapshots are immutable files. The independent journal retains this digest;
    // recovery never accepts a file's echoed digest as its own authority.
    for(const directory of held.directories){const bytes=boundedExpectation(join(directory,'expectation.private'));
      if(bytes.length>65536||createHash('sha256').update(bytes).digest('hex')!==c.expectationDigest)throw Error('distributed:expectation-custody');}
    const anchor:WithdrawalJournalAnchor=Object.freeze({reservation,requestDigest:projection.requestDigest,nativeDirectory:held.directories[0],
      descriptorDigest:descriptor.digest,bindingDigest:c.binding,expectationDigest:c.expectationDigest,hostGeneration:'1',reservationGeneration:reservation.generation,
      ...(backingDigest===undefined?{}:{backingDigest})});
    if(backingClaim!==undefined)await reserveBackingSettlement(backingClaim,anchor);
    const settlementCurrent=async()=>{if(backingClaim!==undefined)await assertBackingSettlement(backingClaim,anchor,{fresh:true});};
    await settlementCurrent();
    let approvalStarted=false,signStarted=false,approval:undefined|{certificate:unknown;current:()=>Promise<void>};
    const approve=async(receiptValue:unknown)=>{
      if(approvalStarted)throw Error('distributed:approval-used');approvalStarted=true;
      try{live();await settlementCurrent();const {consumeVerifiedAgreement,assertVerifiedAgreementCurrent}=await import('../guard-service/src/agreement/txAgreement');live();await settlementCurrent();
        const verified=consumeVerifiedAgreement(receiptValue),current=async()=>{live();await settlementCurrent();live();assertVerifiedAgreementCurrent(verified);};await current();
        const txDataHash=bindVerifiedAgreement(verified,projection.request.canonicalRequest,snapshot.json,snapshot.id,authority);
        if(txDataHash!==c.txDataHash||verified.certificate.timestamp!==timestamp)throw Error('distributed:agreement-binding');
        approval={certificate:verified.certificate,current};
        return Object.freeze({status:'approved-retained-native' as const,requestDigest:projection.requestDigest,txDataHash,descriptorDigest:descriptor.digest,bindingDigest:c.binding});
      }catch(error){await close();throw error;}
    };
    const sign=async()=>{
      if(signStarted)throw Error('distributed:sign-used');signStarted=true;const owned=approval;approval=undefined;
      if(!owned){await close();throw Error('distributed:unapproved');}
      let journal:WithdrawalJournal|undefined;
      try{await owned.current();journal=await WithdrawalJournal.open(setup.database,setup.journalFault);await owned.current();
        await journal.prepare(anchor);await owned.current();await journal.markSigning(reservation.reservationId);await owned.current();
        const final=await held.sign(owned.certificate,owned.current);await owned.current();
        const completed=await journal.complete(reservation.reservationId,{expectationDigest:final.expectationDigest,bindingDigest:final.binding,
          txId:final.txId,byteHash:final.byteDigest,bytesHex:final.bytesHex});await owned.current();return completed;
      }finally{await journal?.close();await close();await settlementCurrent();}
    };
    const disposition=Object.freeze({inputReferences:Object.freeze(selection.inputs.map(i=>i.publicKey)),changeIdentity:c.changeOutputKey,
      changeOutputIndex:c.changeOutputIndex,recipientAtomic:payment.toString(),changeAtomic:change.toString()});
    return Object.freeze({snapshot,approve,sign,close,reservationId:reservation.reservationId,anchor,disposition,
      backingClaim,directories:held.directories,counts:held.counts});
  }catch(error){await close();throw error;}
}

export async function recoverDistributedWithdrawal(database:string,reservationId:string,binary:string,sha256:string,backingClaim?:object){
  const journal=await WithdrawalJournal.open(database);
  let beforeDelivery:(()=>Promise<void>)|undefined;
  try{const entry=await journal.read(reservationId);
    if(entry.state!=='signing'&&entry.state!=='completed')throw Error('distributed:not-recoverable');
    if((entry.anchor.backingDigest!==undefined)!==(backingClaim!==undefined))throw Error('distributed:recovery-backing-required');
    const settlementCurrent=async()=>{
      if(backingClaim===undefined)return;
      const {request}=await revalidateBackingClaim(backingClaim),backing=request.backing;
      // Retained claim context is custody, not a fresh observation of the node.
      assertBackingOccurrence(backingClaim,{selection:decodeNativeSelection(entry.anchor.reservation.selectionBytes),
        genesis:backing.genesis,vaultSpend:entry.anchor.reservation.vaultSpend,vaultAddress:backing.vaultAddress});
      await assertBackingSettlement(backingClaim,entry.anchor);
    };
    await settlementCurrent();
    const final:any=await recoverParticipantFinal({binary,sha256,directory:entry.anchor.nativeDirectory,expectationDigest:entry.anchor.expectationDigest});
    await settlementCurrent();
    const completed=await journal.complete(reservationId,{expectationDigest:final.expectationDigest,bindingDigest:final.binding,
      txId:final.txId,byteHash:final.byteDigest,bytesHex:final.bytesHex});
    await settlementCurrent();beforeDelivery=settlementCurrent;return completed;
  }finally{await journal.close();await beforeDelivery?.();}
}
