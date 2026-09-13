import {createHash} from 'node:crypto';
import {canonicalAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {captureCreditCommittee} from '../ergo-node/credit-committee.mjs';

const claims=new WeakMap();
const hash=value=>createHash('sha256').update(value).digest('hex');
const lookup=handle=>{const claim=claims.get(handle);if(!claim)throw Error('backing:unissued');return claim;};

/** Issued only from four matching retained guard claims, never from a JSON verdict. */
export function issueBackingClaim(committee,request){
  const custody=captureCreditCommittee(committee);
  if(custody.backingPolicy!=='single-deposit-v1' || request?.binding?.committeeDigest!==custody.committeeDigest || !request.backing)
    throw Error('backing:profile');
  custody.assertAssigned(request);
  const captured=structuredClone(request),bytes=canonicalAssignment(captured);
  const digest=hash('rosen-monero/backing-claim/v1\0'+bytes),handle=Object.freeze({});
  claims.set(handle,{custody,request:captured,digest});return handle;
}

export function captureBackingClaim(handle){
  const claim=lookup(handle);claim.custody.assertAssigned(claim.request);
  return {request:structuredClone(claim.request),digest:claim.digest};
}

/** The native decoder owns ring/commitment validation; this closes admitted identity. */
export function assertBackingOccurrence(handle,{selection,genesis,vaultSpend,vaultAddress}){
  const {request}=captureBackingClaim(handle),backing=request.backing;
  if(genesis!==backing.genesis || vaultSpend!==backing.vaultSpend || vaultAddress!==backing.vaultAddress ||
    selection?.network!=='testnet' || selection.vaultSpend!==backing.vaultSpend || !Array.isArray(selection.inputs) || selection.inputs.length!==2)
    throw Error('backing:selection-context');
  const matching=selection.inputs.filter(input=>input.publicKey===backing.publicKey);
  if(matching.length!==1)throw Error('backing:selection-class');
  const input=matching[0];
  for(const [field,expected] of Object.entries({txid:backing.txid,outputIndex:backing.outputIndex,globalIndex:backing.globalIndex,publicKey:backing.publicKey,amount:backing.amountAtomic}))
    if(input[field]!==expected)throw Error('backing:selection-'+field);
  return captureBackingClaim(handle).digest;
}

export function assertBackingSelection(handle,{selection,genesis,vaultSpend,vaultAddress,changeIdentity}){
  const digest=assertBackingOccurrence(handle,{selection,genesis,vaultSpend,vaultAddress});
  if(typeof changeIdentity!=='string' || !/^[0-9a-f]{64}$/.test(changeIdentity) || selection.inputs.some(input=>input.publicKey===changeIdentity))
    throw Error('backing:change-alias');
  return digest;
}

export function backingSettlement(anchor){
  return {reservationId:anchor.reservation.reservationId,reservationHash:anchor.reservation.reservationHash,
    requestDigest:anchor.requestDigest,selectionDigest:hash(anchor.reservation.selectionBytes),
    bindingDigest:anchor.bindingDigest,expectationDigest:anchor.expectationDigest};
}

export function reserveBackingSettlement(handle,anchor){
  const claim=lookup(handle);
  if(anchor.backingDigest!==claim.digest)throw Error('backing:anchor');
  return claim.custody.reserveSettlement(claim.request,backingSettlement(anchor));
}

export function assertBackingSettlement(handle,anchor){
  const claim=lookup(handle);
  if(anchor.backingDigest!==claim.digest)throw Error('backing:anchor');
  return claim.custody.assertSettlement(claim.request,backingSettlement(anchor));
}
