import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {verifyRewardPayment} from './reward-payment-authority.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b,label)=>assert.equal(canonicalAssignment(a),canonicalAssignment(b),label);
export const rewardSettlement=anchor=>({reservationId:anchor.reservation.reservationId,reservationHash:anchor.reservation.reservationHash,
  requestDigest:anchor.requestDigest,selectionDigest:hash(anchor.reservation.selectionBytes),bindingDigest:anchor.bindingDigest,expectationDigest:anchor.expectationDigest});

/** Local guard composition. All authority comes from selected config and its ledger. */
export async function openRewardContribution({input,selected,configuration,ledger,current},ports={}){
  const value=structuredClone(input);assert.deepEqual(Object.keys(value).sort(),['anchor','context','evidence','paymentTxId'],'Reward contribution schema');
  const {anchor,context,evidence,paymentTxId}=value,original=context.assignment,tuple=rewardSettlement(anchor);
  same(context.deployment,selected.deployment,'Reward configured deployment');
  same(context.sourceContext,{genesis:selected.source.genesis,vaultSpend:selected.source.configuration.vaultSpend,
    vaultAddress:selected.source.configuration.vaultAddress,nativeNetwork:'testnet',sourceNetwork:'testnet',maxMinerFeeAtomic:'1000000000000'},'Reward configured source');
  assert(/^[0-9a-f]{64}$/.test(tuple.reservationId),'Reward reservation');
  const custody=()=>{current();ledger.assertAssigned(original);ledger.assertSettlement(original,tuple);};custody();
  const verifyWithdrawal=ports.verifyWithdrawal??(await import('./v2-withdrawal-authority.mjs')).verifyV2RewardWithdrawal;
  const openVerifier=ports.openVerifier??(await import('./return-reward.mjs')).openReturnRewardVerifier;
  const verifier=await openVerifier({deployment:context.deployment,returnReceipt:context.returnReceipt,redemption:context.redemption,terms:context.terms,
    feeAuthority:context.feeAuthority,paymentTxId,directory:path.join(selected.directory,'reward-verification',tuple.reservationId)});
  const verifyPayment=ports.verifyPayment??verifyRewardPayment;
  let expected,assigned=false;
  function assertRetained(){custody();assert(expected,'Reward verification absent');
    const retained=ledger.observeReward(original,tuple);
    if(retained.status==='assigned')same(retained.assignment,expected,'Reward retained assignment conflict');
    else assert.equal(retained.status,'unassigned','Reward retained assignment status');
    if(assigned)ledger.assertReward(original,tuple,expected);}
  function assign(request){assertRetained();same(request,expected,'Reward contribution assignment');
    const result=ledger.reserveReward(original,tuple,expected);assigned=true;
    ledger.assertReward(original,tuple,expected);assertRetained();return result;
  }
  async function verify(snapshot){
    // A confirmed payout alone cannot authorize rewards for an unrelated return.
    // This verifier joins the retained native request/selection to the exact
    // original credit, recipient redemption and still-unspent return trigger.
    // It deliberately does not ask whether Monero payout inputs remain unspent.
    custody();const withdrawal=await verifyWithdrawal({...context,selection:anchor.reservation.selectionBytes,
      request:JSON.parse(anchor.reservation.requestJson)});custody();
    assert.equal(withdrawal.requestDigest,tuple.requestDigest,'Reward withdrawal request');
    assert.equal(withdrawal.selectionDigest,tuple.selectionDigest,'Reward withdrawal selection');
    const payment=await verifyPayment({anchor,evidence,source:selected.source,binary:configuration.nativeBinary,sha256:configuration.nativeSha256,
      directory:path.join(selected.directory,'reward-payment'),paymentTxId});custody();
    await verifier.verifyRaw(snapshot);custody();
    const assignment={binding:{creditTransactionDigest:snapshot.digest},domain:'rosen-monero-reward-assignment-v1',
      creditAssignmentDigest:hash(canonicalAssignment(original)),settlement:tuple,paymentTxId,paymentByteDigest:payment.byteDigest,
      rewardTransactionId:snapshot.txId,rewardPolicyDigest:verifier.policyDigest};
    if(expected)same(assignment,expected,'Reward verification changed');else expected=structuredClone(assignment);
    assertRetained();return {assignment,assertCurrent:assertRetained,revalidate:()=>verify(snapshot)};
  }
  return Object.freeze({verify,assign});
}
