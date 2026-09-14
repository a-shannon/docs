import assert from 'node:assert/strict';
import {join} from 'node:path';
import {config} from '../tools/config.mjs';
import {launchDistributedNative,MoneroChain} from './adapter';
import {createRoundtripPayment} from './roundtripPayment';
import {terms} from './projectionFixture';
import {configureFixtureTokens} from './fixturePorts';
import {buildUnapprovedMoneroPayout} from '../guard-service/src/withdrawal/moneroWithdrawalOrder';
import {getTxDataHash,verify} from './integration';
import {setupAgreement,state,closeAgreementDatabase} from './agreementPorts';
import {FixtureAgreement,votes} from './agreementFixture';
import {lifecycleState} from './lifecyclePorts';
import ChainHandler from '../guard-service/src/handlers/chainHandler';
import TransactionProcessor from '../guard-service/src/transaction/transactionProcessor';
import EventSerializer from '../guard-service/src/event/eventSerializer';
import {setFixtureChain} from './resolver';
import {verifyReturnAuthority} from '../ergo-node/return-authority.mjs';
import {decodeNativeSelection} from '../guard-service/src/withdrawal/moneroWithdrawalSelection';

/** Same reviewed withdrawal owner/lifecycle; its input is the actual two-watcher return. */
export async function settleAuthorityReturn({node,vault,source,returnReceipt,redemption,returnTerms,directory,deployment,backingClaim,onAccounting}:any){
  assert(onAccounting===undefined || typeof onAccounting==='function');
  const verifySource=()=>verifyReturnAuthority({returnReceipt,redemption,deployment,terms:returnTerms});
  const trusted=await verifySource(),returnTx=trusted.transaction,returnBox=trusted.trigger,event=trusted.event;
  assert.equal(event.WIDsCount,2);
  assert(returnTx.numConfirmations>0);assert(returnTx.outputs.some((b:any)=>b.boxId===returnBox.boxId));
  const projectedEvent=EventSerializer.fromEntity({...event,height:returnTx.inclusionHeight});
  assert.equal(EventSerializer.getId(projectedEvent),event.eventId);
  const data=terms();data.source={event:projectedEvent,triggerTransactionId:returnTx.id,triggerBoxId:returnBox.boxId,wids:returnReceipt.commitments.map((row:any)=>row.WID)};
  data.profile.configurationId='local-authority-roundtrip-v1';
  data.profile.tokens[0].ergo.tokenId=deployment.tokens.Asset;data.profile.tokens[0].ergo.name='Local rsXMR';data.profile.maxMinerFeeAtomic='1000000000000';
  await configureFixtureTokens(data.profile.tokens);const chain=await MoneroChain.create(data.profile.tokens);setFixtureChain(chain);
  ChainHandler.initializeScoped(new Map([['monero',chain]]),undefined!);
  const request=await buildUnapprovedMoneroPayout(data.source,data.profile);await setupAgreement(request.eventId,data);lifecycleState.database=state.database;
  try{
    const timestamp=Math.floor(Date.now()/1000),database=join(directory,'withdrawal.sqlite');
    const authority={epoch:'1',publicKeys:state.keys,requiredSign:3,nativeParticipants:[1,2,3,4],nativeThreshold:2,nativeSelected:[1,2]};
    const beforeConstruction=await verifySource();assert.deepEqual(beforeConstruction.event,event);assert.equal(beforeConstruction.trigger.boxId,returnBox.boxId);
    const owner=await launchDistributedNative(vault,request,{database,clock:()=>1000n,leaseDuration:1000000n,authority,backingClaim},timestamp);
    assert(owner.disposition.inputReferences.includes(source.deposit.outputKey));assert.equal(owner.disposition.recipientAtomic,'500000000');assert(await verify(owner.transaction));
    const selection=decodeNativeSelection(owner.anchor.reservation.selectionBytes);
    const accounting={reservationId:owner.reservationId,proposalId:owner.transaction.txId,redemptionTxId:redemption.txId,
      inputs:selection.inputs.map(input=>({txId:input.txid,outputIndex:Number(input.outputIndex),publicKey:input.publicKey,amountAtomic:input.amount})),
      recipientAtomic:owner.disposition.recipientAtomic,minerFeeAtomic:owner.anchor.reservation.receipt!.necessaryFeeAtomic,
      changeAtomic:owner.disposition.changeAtomic,changePublicKey:owner.disposition.changeIdentity,settlement:null as any};
    // Observation only: the callback receives no owner, approval or signing capability.
    if(onAccounting)await onAccounting(structuredClone(accounting));
    const agreement=new FixtureAgreement();await agreement.prepare();const signatures=await votes(owner.transaction,timestamp);
    const current=await verifySource();assert.deepEqual(current.event,event);assert.equal(current.trigger.boxId,returnBox.boxId);
    await agreement.approve(owner.transaction,[...signatures.slice(0,3),''],timestamp);
    const approval=agreement.takeVerifiedAgreement(getTxDataHash(owner.transaction));assert(approval);await owner.approve(approval);
    const payment=createRoundtripPayment({node,binary:config.nativeBinary,sha256:config.nativeSha256,vault,owner,database,dataSource:state.database!.dataSource,lostSubmissionReply:true});
    const processor=payment.create();await processor.initialize();ChainHandler.initializeScoped(new Map([['monero',chain]]),processor);
    await processor.attachApproved(payment.binding,{sign:payment.sign});await TransactionProcessor.processTransactions();
    assert.equal(payment.counts().signCalls,1);assert.equal(owner.counts().shares,2);assert.equal(payment.counts().submissions,1);
    const final=await payment.recover();assert((await node.transaction(final.finalTxId)).txs[0].in_pool);
    assert.equal((await state.database!.getTxById(owner.transaction.txId))!.status,'signed');
    const restarted=payment.create();await restarted.initialize();ChainHandler.initializeScoped(new Map([['monero',chain]]),restarted);
    await TransactionProcessor.processTransactions();assert.equal(payment.counts().signCalls,1);assert.equal(payment.counts().submissions,1);
    await assert.rejects(restarted.attachApproved(payment.binding,{sign:payment.sign}));
    await node.mine(1,vault.vaultAddress);await TransactionProcessor.processTransactions();
    assert.equal((await state.database!.getTxById(owner.transaction.txId))!.status,'sent');
    await node.mine(1,vault.vaultAddress);await TransactionProcessor.processTransactions();
    const row=(await state.database!.getTxById(owner.transaction.txId))!,storedEvent=(await state.database!.getEventById(request.eventId))!;
    assert.equal(row.status,'completed');assert.equal(row.txJson,payment.binding.originalTxJson);assert.equal(storedEvent.status,'pending-reward');
    assert.deepEqual(await state.database!.dataSource.query('SELECT state FROM monero_payment_disposition'),[{state:'settled'}]);
    assert.deepEqual(await state.database!.dataSource.query('SELECT state FROM monero_payment_input'),[{state:'spent'},{state:'spent'}]);
    await TransactionProcessor.processTransactions();assert.equal(payment.counts().signCalls,1);assert.equal(payment.counts().submissions,1);
    assert.deepEqual((await node.call('/is_key_image_spent',{key_images:[source.observation.keyImage]})).spent_status,[1]);
    const scan=payment.observations().at(-1);assert.equal(scan.recipientAtomic,'500000000');
    accounting.settlement={txId:final.finalTxId,proposalId:owner.transaction.txId,reservationId:owner.reservationId,
      inputAtomic:scan.inputAtomic,recipientAtomic:scan.recipientAtomic,minerFeeAtomic:scan.feeAtomic,
      changeAtomic:scan.changeAtomic,changePublicKey:scan.changeOutputKey,rewardState:storedEvent.status};
    if(onAccounting)await onAccounting(structuredClone(accounting));
    return {sourceEventId:request.eventId,proposalId:owner.transaction.txId,finalTxId:final.finalTxId,byteDigest:final.byteDigest,...scan,
      accounting,
      controls:{separateHolderCount:4,nativeThreshold:2,selected:[1,2],shares:owner.counts().shares,lostSubmissionReplyRecovered:true,
        originalProposalPreserved:true,sourceOutputSpent:true,settlement:'settled',...payment.counts()}};
  }finally{lifecycleState.database=undefined;await closeAgreementDatabase();}
}
