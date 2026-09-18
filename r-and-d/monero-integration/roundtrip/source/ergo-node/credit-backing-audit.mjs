import assert from 'node:assert/strict';

/** Point-in-time source audit of an existing claim, never signing authority.
 * Availability failures hold the audit; agreement on a replaced anchor permanently
 * invalidates the claim without releasing its output/image or undoing Ergo credit.
 * The caller supplies its own frozen verifier assignment and source connections. */
export async function auditCreditBacking({assignment,ledger,readAnchor,readBacking,assertCurrent}){
  const expected=structuredClone(assignment);
  assert.equal(expected.backing?.version,2,'Backing audit requires V2');
  const observe=()=>{assertCurrent();return ledger.observeAssignment(expected);};
  const result=(status,reason)=>{
    const claim=observe();
    return Object.freeze({status:claim.status==='invalidated'?'quarantined':status,
      reason:claim.status==='invalidated'?claim.reason:reason,claim});
  };
  if(observe().status==='invalidated')return result('quarantined','claim-invalidated');
  let anchor;
  try{
    anchor=await readAnchor(expected.backing.blockHeight);
    assert.equal(anchor?.height,expected.backing.blockHeight,'Backing audit anchor height');
    assert.match(anchor?.hash??'',/^[0-9a-f]{64}$/,'Backing audit anchor hash');
  }catch{
    return result('held','source-unavailable');
  }
  if(observe().status==='invalidated')return result('quarantined','claim-invalidated');
  if(anchor.hash!==expected.backing.blockHash){
    assert.equal(ledger.invalidate(expected.binding.obligationId,'source-block-changed').status,'invalidated');
    return result('quarantined','source-block-changed');
  }
  try{
    const fresh=await readBacking();
    assert.deepEqual(fresh?.backing,expected.backing,'Backing audit source changed');
  }catch{
    return result('held','backing-unavailable');
  }
  return result('checked','source-current');
}
