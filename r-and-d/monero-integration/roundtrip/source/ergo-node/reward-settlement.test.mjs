import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {RewardSubmissionReplyLostError,settleReward} from './reward-settlement.mjs';

const h=n=>n.toString(16).padStart(64,'0');
const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(value).digest('hex');

function fixture(t,{lostReply=false,lostBeforeEffect=false}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'reward-settlement-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const anchor={reservation:{reservationId:h(1),reservationHash:h(2),selectionBytes:'selection',requestJson:JSON.stringify({requestDigest:h(3),canonicalRequest:'{}'})},
    requestDigest:h(3),bindingDigest:h(4),expectationDigest:h(5),nativeDirectory:path.join(directory,'private-native')};
  const context={assignment:{binding:{obligationId:'credit',creditTransactionDigest:h(6)}},snapshot:{txId:h(7)},credit:{txId:h(7)},
    returnReceipt:{eventId:h(8)},redemption:{txId:h(9)},terms:{toAddress:'recipient'},feeAuthority:{digest:h(10)},
    deployment:{profile:'fixture'},sourceContext:{genesis:h(11)}};
  const paymentTxId=h(12),snapshot={digest:h(13),txId:h(14),reducedHex:'aa',inputHex:['bb'],dataHex:['cc'],requiredSign:3};
  const order=[{address:'reward',assets:{nativeToken:'1',tokens:[]}}],policyDigest=h(15),binding=h(16),candidateTransaction='{"candidate":"exact"}';
  const candidateText=JSON.stringify({binding,transaction:candidateTransaction}),signedHex='deadbeef',signedJson={id:snapshot.txId,bytes:signedHex};
  const rewardAssignment={binding:{creditTransactionDigest:snapshot.digest},domain:'rosen-monero-reward-assignment-v1',creditAssignmentDigest:h(17),
    settlement:{reservationId:h(1),reservationHash:h(2),requestDigest:h(3),selectionDigest:hash('selection'),bindingDigest:h(4),expectationDigest:h(5)},
    paymentTxId,paymentByteDigest:h(19),rewardTransactionId:snapshot.txId,rewardPolicyDigest:policyDigest};
  const state={createCalls:0,verifyRawCalls:0,signCalls:0,guardVerifyCalls:0,syncCalls:0,checks:0,submits:0,
    lookupError:undefined,confirmationError:undefined,sourceConflict:false,invalidateDuringCheck:false,
    assignment:undefined,chain:undefined,starts:[1,1,1,1],lostReply,lostBeforeEffect};
  const transaction={eventId:h(8),txId:snapshot.txId,txType:'reward',txBytes:Buffer.from('aa','hex'),inputBoxes:[Buffer.from('bb','hex')],dataInputs:[Buffer.from('cc','hex')],toJson:()=>candidateTransaction};
  const verifier={policyDigest,binding,chain:{id:'reward-chain'},async create(target){
    state.createCalls++;state.verifyRawCalls++;if(state.sourceConflict)throw Error('controlled-source-proof-conflict');
    assert.equal(target,directory);if(!fs.existsSync(path.join(directory,'reward-candidate.json')))fs.writeFileSync(path.join(directory,'reward-candidate.json'),candidateText);
    return {transaction,snapshot:clone(snapshot),order:clone(order),policyDigest,binding};
  },async verifyRaw(){state.verifyRawCalls++;}};
  const guards={
    get counts(){return {starts:[...state.starts]};},
    async rewardState(request,supplied){assert.deepEqual(request,context.assignment);assert.deepEqual(supplied,anchor);
      return state.assignment?{status:'assigned',assignment:clone(state.assignment)}:{status:'unassigned'};},
    async verifyReward(received,reward){state.guardVerifyCalls++;assert.deepEqual(received,snapshot);
      assert.deepEqual(reward,{anchor,context,evidence:{sealed:'evidence'},paymentTxId});
      if(state.sourceConflict)throw Error('controlled-source-proof-conflict');return clone(state.assignment);},
    async sign(received,{reward}){state.signCalls++;assert.deepEqual(received,snapshot);assert.deepEqual(reward,{anchor,context,evidence:{sealed:'evidence'},paymentTxId});
      state.assignment=clone(rewardAssignment);return {txId:snapshot.txId,signedHex};},
    async restartAll(){state.starts.fill(2);}
  };
  const receipt=()=>({id:snapshot.txId,signedHex,blockId:h(20),inclusionHeight:100,numConfirmations:2});
  const ports={
    openVerifier:async()=>verifier,exportEvidence:()=>({sealed:'evidence'}),
    verifySignedRecord(record,expected,{fresh}){assert.equal(record.signedHex,signedHex);assert.deepEqual(record.snapshot,expected);assert.equal(typeof fresh,'boolean');return {native:{id:snapshot.txId},signedJson};},
    buildSignedTransaction(record,candidate){assert.equal(record.signedHex,signedHex);assert.equal(candidate,candidateTransaction);return {...transaction,txBytes:Buffer.from(record.signedHex,'hex'),toJson:()=>JSON.stringify(signedJson)};},
    async verifyConfirmed(found,record){assert.equal(found.id,record.txId);assert.equal(found.signedHex,record.signedHex);return clone(found);},
    async rpc(route){
      if(route==='/blockchain/transaction/byId/'+snapshot.txId){if(state.lookupError)throw state.lookupError;if(!state.chain){const e=Error('Ergo HTTP 404 at '+route);e.status=404;throw e;}return clone(state.chain);}
      if(route==='/transactions/check'){state.checks++;if(state.invalidateDuringCheck)state.assignment={...rewardAssignment,paymentByteDigest:h(99)};return snapshot.txId;}
      if(route==='/transactions'){state.submits++;const suppress=state.lostReply&&state.lostBeforeEffect;if(!suppress)state.chain=receipt();
        if(state.lostReply&&state.lostBeforeEffect){state.lostReply=false;throw Error('controlled-lost-submission-reply');}return snapshot.txId;}
      throw Error('Unexpected RPC '+route);
    },
    confirmationAttempts:2,confirmationIntervalMs:0
  };
  const options={anchor,context,paymentTxId,guards,directory,syncSource:async()=>{state.syncCalls++;},
    ...(lostReply&&!lostBeforeEffect?{simulateLostSubmissionReply:true}:{})};
  return {directory,anchor,context,paymentTxId,snapshot,order,policyDigest,binding,candidateText,signedHex,rewardAssignment,state,guards,ports,options};
}

test('signs once with four fresh guard checks, submits exact bytes, and confirmed reopen never rebuilds or resigns',async t=>{
  const f=fixture(t),first=await settleReward(f.options,f.ports);
  assert.equal(first.transaction.txId,f.snapshot.txId);assert.equal(first.receipt.id,f.snapshot.txId);assert.deepEqual(first.snapshot,f.snapshot);
  assert.deepEqual(first.order,f.order);assert.equal(first.policyDigest,f.policyDigest);assert.deepEqual(first.assignment,f.rewardAssignment);
  assert.deepEqual(first.chain,{id:'reward-chain'});assert.equal(first.verifier.chain,first.chain);
  assert.deepEqual({...first.controls},{signCalls:1,submissions:1,recoveredLostReply:false,restartedGuards:0,sameSignedBytes:true,noResignAfterConfirmed:false});
  const reopened=await settleReward(f.options,f.ports);
  assert.equal(f.state.createCalls,1);assert.equal(f.state.verifyRawCalls,1);assert.equal(f.state.signCalls,1);assert.equal(f.state.syncCalls,1);
  assert.equal(f.state.checks,1);assert.equal(f.state.submits,1);assert.equal(reopened.controls.noResignAfterConfirmed,true);assert.equal(reopened.controls.recoveredLostReply,false);
});

test('lost submission reply recovers the exact confirmed record after all guards restart',async t=>{
  const f=fixture(t,{lostReply:true});await assert.rejects(settleReward(f.options,f.ports),error=>error instanceof RewardSubmissionReplyLostError&&error.code==='REWARD_SUBMISSION_REPLY_LOST');
  const before=fs.readFileSync(path.join(f.directory,'reward-signed.json'),'utf8');await f.guards.restartAll();
  const recovered=await settleReward(f.options,f.ports);assert.equal(fs.readFileSync(path.join(f.directory,'reward-signed.json'),'utf8'),before);
  assert.equal(f.state.signCalls,1);assert.equal(f.state.submits,1);assert.equal(recovered.controls.recoveredLostReply,true);
  assert.equal(recovered.controls.restartedGuards,4);assert.equal(recovered.controls.noResignAfterConfirmed,true);
});

test('unconfirmed retained recovery fresh-verifies and may resubmit, but never signs a replacement',async t=>{
  const f=fixture(t,{lostReply:true,lostBeforeEffect:true});await assert.rejects(settleReward(f.options,f.ports),/lost-submission-reply/);
  await f.guards.restartAll();const recovered=await settleReward(f.options,f.ports);
  assert.equal(f.state.createCalls,2);assert.equal(f.state.verifyRawCalls,2);assert.equal(f.state.signCalls,1);assert.equal(f.state.syncCalls,2);
  assert.equal(f.state.submits,2);assert.equal(recovered.controls.submissions,2);assert.equal(recovered.controls.noResignAfterConfirmed,false);
});

test('retained recovery refuses changed context, signed bytes, guard assignment, payout, and absent candidate',async t=>{
  for(const mutation of ['context','signed','assignment','payout','missing-candidate']){
    const f=fixture(t);await settleReward(f.options,f.ports);
    if(mutation==='context')f.options.context.terms.toAddress='changed';
    if(mutation==='signed'){const file=path.join(f.directory,'reward-signed.json'),record=JSON.parse(fs.readFileSync(file));record.signedHex='00';fs.writeFileSync(file,JSON.stringify(record));}
    if(mutation==='assignment')f.state.assignment={...f.rewardAssignment,paymentByteDigest:h(99)};
    if(mutation==='payout')f.state.chain.signedHex='00';
    if(mutation==='missing-candidate')fs.unlinkSync(path.join(f.directory,'reward-candidate.json'));
    await assert.rejects(settleReward(f.options,f.ports),undefined,mutation);
    assert.equal(f.state.signCalls,1,mutation);assert.equal(f.state.submits,1,mutation);
  }
});

test('only an explicit RPC 404 enters unconfirmed recovery; other lookup failures stop before fresh verification or submission',async t=>{
  const f=fixture(t,{lostReply:true,lostBeforeEffect:true});await assert.rejects(settleReward(f.options,f.ports),/lost-submission-reply/);
  const before={create:f.state.createCalls,submit:f.state.submits,sync:f.state.syncCalls};const error=Error('Ergo HTTP 500 at lookup');error.status=500;f.state.lookupError=error;
  await assert.rejects(settleReward(f.options,f.ports),/HTTP 500/);assert.deepEqual({create:f.state.createCalls,submit:f.state.submits,sync:f.state.syncCalls},before);
});

test('source-proof conflict during retained fresh verification refuses before resubmission',async t=>{
  const f=fixture(t,{lostReply:true,lostBeforeEffect:true});await assert.rejects(settleReward(f.options,f.ports),/lost-submission-reply/);
  f.state.sourceConflict=true;await assert.rejects(settleReward(f.options,f.ports),/source-proof-conflict/);
  assert.equal(f.state.guardVerifyCalls,1);assert.equal(f.state.createCalls,1);assert.equal(f.state.signCalls,1);assert.equal(f.state.submits,1);
});

test('assignment invalidated during node check is refused by the gate adjacent to broadcast',async t=>{
  const f=fixture(t);f.state.invalidateDuringCheck=true;
  await assert.rejects(settleReward(f.options,f.ports),/Reward guard assignment changed/);
  assert.equal(f.state.checks,1);assert.equal(f.state.submits,0);assert.equal(f.state.signCalls,1);
});

test('confirmation polling propagates a non-404 response even when its body mentions 404',async t=>{
  const f=fixture(t);let reads=0;const rpc=f.ports.rpc;
  f.ports.rpc=async(route,body)=>{if(route==='/blockchain/transaction/byId/'+f.snapshot.txId&&++reads===1)throw Error('Ergo HTTP 500 at '+route+': upstream mentioned 404');return rpc(route,body);};
  await assert.rejects(settleReward(f.options,f.ports),/HTTP 500/);
  assert.equal(f.state.submits,1);assert.equal(f.state.signCalls,1);
});
