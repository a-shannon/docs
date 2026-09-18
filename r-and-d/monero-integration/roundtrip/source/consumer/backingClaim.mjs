import {createHash} from 'node:crypto';
import {canonicalAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {captureCreditCommittee} from '../ergo-node/credit-committee.mjs';
import {captureGuardProcessCustody} from '../ergo-node/guard-process-committee.mjs';

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
  const claim=lookup(handle);
  if(claim.context)claim.custody.current();else claim.custody.assertAssigned(claim.request);
  return {request:structuredClone(claim.request),digest:claim.digest};
}

/** V2 issuance is asynchronous and requires the actual four process-owned ledgers.
 * Synchronous capture checks local handle identity only; consumers must await
 * revalidation at every deciding asynchronous boundary. */
export async function issueProcessBackingClaim(committee,request,context){
  const custody=captureGuardProcessCustody(committee),captured=structuredClone(request),retained=structuredClone(context);
  if(captured.backing?.version!==2||captured.binding?.committeeDigest!==custody.committeeDigest||
    canonicalAssignment(retained.assignment)!==canonicalAssignment(captured))throw Error('backing:profile');
  await custody.assertAssigned(captured);custody.current();
  const digest=hash('rosen-monero/backing-claim/v2\0'+canonicalAssignment(captured)),handle=Object.freeze({});
  claims.set(handle,{custody,request:captured,digest,context:retained});return handle;
}

export async function revalidateBackingClaim(handle){
  const claim=lookup(handle);await claim.custody.assertAssigned(claim.request);
  return captureBackingClaim(handle);
}

/** The native decoder owns ring/commitment validation; this closes admitted identity. */
export function assertBackingOccurrence(handle,{selection,genesis,vaultSpend,vaultAddress}){
  const {request}=captureBackingClaim(handle),original=request.backing;
  const backing=original.version===2?{...original,txid:original.txId,publicKey:original.outputKey,
    outputIndex:String(original.outputIndex),globalIndex:String(original.globalIndex)}:original;
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
  return claim.context?claim.custody.reserveSettlement(claim.request,anchor,claim.context)
    :claim.custody.reserveSettlement(claim.request,backingSettlement(anchor));
}

export function assertBackingSettlement(handle,anchor,options={}){
  const claim=lookup(handle);
  if(anchor.backingDigest!==claim.digest)throw Error('backing:anchor');
  return claim.context?claim.custody.assertSettlement(claim.request,anchor,claim.context,options)
    :claim.custody.assertSettlement(claim.request,backingSettlement(anchor));
}
