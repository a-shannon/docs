import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {config} from '../tools/config.mjs';
import {setupAuthorityFixture} from '../ergo-node/authority-fixture.mjs';
import {tree} from '../ergo-node/rosen-node.mjs';
import {redeemAuthorizedCredit} from '../ergo-node/authority-return.mjs';
import {createWatcherProcessTransport} from '../ergo-node/watcher-process-transport.mjs';
import {issueProcessBackingClaim,assertBackingSettlement,reserveBackingSettlement} from './backingClaim.mjs';
import {settleAuthorityReturn} from './authorityRoundtrip.ts';
import {recipient} from './projectionFixture.ts';
import {reconcileEconomicOperations} from './economicReconciliation.mjs';
import {captureWithdrawalFeeAuthority,effectiveWithdrawalFees} from '../ergo-node/v2-withdrawal-authority.mjs';
import {verifyReturnAuthority} from '../ergo-node/return-authority.mjs';
import {settleReward,RewardSubmissionReplyLostError} from '../ergo-node/reward-settlement.mjs';

/** Complete owned-node V2 campaign, using the same custody and native payment consumers. */
export async function runV2ReturnScenario({node,vault,source,directory,deployment,publicDeployment,guards,snapshot,assignment,record,credit,guardHomes,proofBytes,syncSource}){
  const stage=(name,detail={})=>console.log(JSON.stringify({stage:'v2-return-'+name,...detail}));
  const terms={toAddress:recipient,bridgeFee:'100',networkFee:'20',moneroTokenId:'XMR'};
  const redemption=await redeemAuthorizedCredit({directory:path.join(directory,'redemption'),authorized:{...record,status:'confirmed'},deployment,terms});
  const liveDeployment=await setupAuthorityFixture(),publicReturn=structuredClone(liveDeployment);
  delete publicReturn.guardSecrets;for(const watcher of publicReturn.watchers)delete watcher.secretKey;
  const watcherRoot=path.join(directory,'return-watchers');fs.mkdirSync(watcherRoot);
  const configFiles=liveDeployment.watchers.map((watcher,index)=>{
    const home=path.join(watcherRoot,String(index));fs.mkdirSync(home);
    const file=path.join(home,'participant.json');fs.writeFileSync(file,JSON.stringify({version:1,index,roundtripConfig:process.env.ROUNDTRIP_CONFIG,
      dependencyRoot:config.rosenRoot,watcher,deployment:publicReturn,databasePath:path.join(home,'watcher.sqlite'),returnTerms:terms}),{flag:'wx',mode:0o600});return file;
  });
  const watchers=await createWatcherProcessTransport({configFiles,directory:watcherRoot});
  try{
    const returned=await watchers.publish(redemption);assert.equal(returned.commitments.length,2);
    const pids=[...watchers.pids];assert.equal(new Set([...pids,...guards.pids,process.pid]).size,7);
    await Promise.all([watchers.restart(0),watchers.restart(1)]);
    assert.equal((await watchers.publish(redemption)).transaction.id,returned.transaction.id);
    stage('redemption-confirmed',{creditTxId:credit.id,redemptionTxId:redemption.txId,triggerTxId:returned.transaction.id});
    const trusted=await verifyReturnAuthority({returnReceipt:returned,redemption,terms,deployment:publicDeployment});
    const feeAuthority=await captureWithdrawalFeeAuthority(publicDeployment,trusted.event),charges=effectiveWithdrawalFees(trusted.event,feeAuthority.feeConfig);
    const context={assignment,snapshot,credit:record,returnReceipt:returned,redemption,terms,feeAuthority,deployment:publicDeployment,
      sourceContext:{genesis:vault.genesis,vaultSpend:vault.groupKey,vaultAddress:vault.vaultAddress,
        nativeNetwork:'testnet',sourceNetwork:'testnet',maxMinerFeeAtomic:'1000000000000'}};
    const backingClaim=await issueProcessBackingClaim(guards,assignment,context),backing=assignment.backing;
    const tokens=box=>box.assets.filter(a=>a.tokenId===deployment.tokens.Asset);
    const users=credit.outputs.filter(box=>box.ergoTree===tree(backing.recipient)&&tokens(box).length===1);
    const fees=credit.outputs.filter(box=>box.ergoTree===tree(deployment.fundingAddress)&&tokens(box).length===1);
    assert.equal(users.length,1);assert.equal(fees.length,1);
    const facts={operationId:assignment.binding.obligationId,genesis:vault.genesis,vaultSpend:vault.groupKey,assetId:deployment.tokens.Asset,
      deposit:{txId:backing.txId,outputIndex:backing.outputIndex,publicKey:backing.outputKey,amountAtomic:backing.amountAtomic},
      credit:{txId:credit.id,boxId:users[0].boxId,depositId:assignment.binding.obligationId,recipientAtomic:String(tokens(users[0])[0].amount),
        bridgeFeeAtomic:'100',networkFeeAtomic:'20',issuedFeeTokenAtomic:String(tokens(fees[0])[0].amount)},
      redemption:{txId:redemption.txId,creditTxId:redemption.creditTransactionId,creditBoxId:redemption.consumedCreditBoxId,
        amountAtomic:redemption.observation.amount,bridgeFeeAtomic:charges.bridgeFee,networkFeeAtomic:charges.networkFee},withdrawal:null};
    const accounting=[{stage:'redeemed',report:reconcileEconomicOperations([facts])}],faults=[];
    let postSubmissionPids,retainedAnchor;
    const withdrawal=await settleAuthorityReturn({node,vault,source,returnReceipt:returned,redemption,returnTerms:terms,directory,deployment,backingClaim,feeAuthority,
      async onReserved(anchor,counts){
        retainedAnchor=anchor;assert.equal(counts.shares,0);
        const before=await guards.stats();assert(before.every(row=>row.checkpoint.settlements===1));
        const altered=structuredClone(anchor);altered.reservation.reservationId='ff'.repeat(32);
        await assert.rejects(()=>reserveBackingSettlement(backingClaim,altered),/settlement:conflict/);faults.push('competing-reservation');
        fs.unlinkSync(guardHomes[2].proof);
        try{await assert.rejects(()=>assertBackingSettlement(backingClaim,anchor,{fresh:true}),/ENOENT/);}
        finally{fs.writeFileSync(guardHomes[2].proof,proofBytes);}
        faults.push('missing-proof-before-native-approval');
        await assertBackingSettlement(backingClaim,anchor,{fresh:true});
        assert.deepEqual((await guards.stats()).map(s=>s.checkpoint),before.map(s=>s.checkpoint));
        stage('reserved',{guards:4,nativeShares:counts.shares});
      },
      async afterSubmission(anchor,counts){
        assert.equal(counts.shares,2);await guards.restartAll();postSubmissionPids=guards.pids;
        await assertBackingSettlement(backingClaim,anchor);
        await assert.rejects(()=>assertBackingSettlement(backingClaim,anchor,{fresh:true}));
        const restarted=await guards.stats();assert(restarted.every(row=>row.checkpoint.settlements===1&&row.counts.commitments===0&&row.counts.partialSigns===0));
        faults.push('new-authorization-after-spend');stage('guards-reopened-after-payout',{guards:4,newCreditContributions:0});
      },
      async onAccounting(value){facts.withdrawal=value;const report=reconcileEconomicOperations([facts]);
        accounting.push({stage:value.settlement?.rewardState==='completed'?'rewarded':value.settlement?'settled':'reserved',report});stage('accounting',{state:report.operations[0].state,totals:report.totals});},
      async completeReward({anchor,paymentTxId}){
        stage('reward-started');
        const options={anchor,context,paymentTxId,guards,directory:path.join(directory,'return-reward'),syncSource,simulateLostSubmissionReply:true};
        await assert.rejects(()=>settleReward(options),error=>error instanceof RewardSubmissionReplyLostError);
        faults.push('reward-submission-reply-lost');await guards.restartAll();
        const reward=await settleReward(options);
        const recovered=await settleReward(options);
        assert.equal(recovered.transaction.toJson(),reward.transaction.toJson());
        assert.equal(recovered.controls.signCalls,1);assert.equal(recovered.controls.noResignAfterConfirmed,true);
        assert.equal(reward.controls.restartedGuards,4);faults.push('reward-confirmed-restart');
        stage('reward-confirmed',{txId:reward.receipt.id});return reward;
      }
    });
    await assertBackingSettlement(backingClaim,retainedAnchor);
    const final=accounting.at(-1).report;assert.equal(final.totals.settledCount,1);assert.equal(final.totals.outstandingUserAtomic,'0');assert.equal(final.totals.pendingPayoutAtomic,'0');
    assert.equal(withdrawal.controls.signCalls,1);assert.equal(withdrawal.controls.submissions,1);
    assert.equal(withdrawal.reward.eventStatus,'completed');assert.equal(final.totals.retainedReturnFeeAtomic,'0');
    assert.equal(final.totals.issuedReturnFeeTokenAtomic,String(BigInt(charges.bridgeFee)+BigInt(charges.networkFee)));
    const result={profile:'local-multiprocess-v2-roundtrip',redemptionTxId:redemption.txId,returnTriggerTxId:returned.transaction.id,
      returnWatcherPids:pids,returnWatcherStats:await watchers.stats(),returnWatcherCounts:watchers.counts,
      postSubmissionGuardPids:postSubmissionPids,withdrawal,accounting,faults};
    fs.writeFileSync(path.join(directory,'v2-return-result.json'),JSON.stringify(result,null,2),{flag:'wx'});stage('settled',{finalTxId:withdrawal.finalTxId});return result;
  }finally{await watchers.close();}
}
