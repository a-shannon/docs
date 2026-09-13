import fs from 'node:fs';
import assert from 'node:assert/strict';

/** Exclusive crash-ordered local record. Missing/torn custody never creates authority. */
export function retainCreditRecord(file,bytes){
  const body=Buffer.from(bytes),fd=fs.openSync(file,'wx');
  try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  assert.deepEqual(fs.readFileSync(file),body,'Credit durable record readback');
}

/** Retained candidate and permanent claims authorize recovery, not file consistency. */
export async function recoverCredit({record,snapshot,policyDigest,request,committee,validateSigned,lookupConfirmed,verifyFresh,submit,waitConfirmed}){
  assert.equal(record.policyDigest,policyDigest,'Credit recovery policy');
  assert.equal(record.txId,snapshot.txId,'Credit recovery candidate');
  validateSigned(record,snapshot);
  committee.observeAssignment(request);
  const known=await lookupConfirmed(record.txId);
  if(known){
    validateSigned({...record,transaction:known},snapshot);
    return {transaction:known,status:committee.observeAssignment(request).every(r=>r.status==='assigned')?'confirmed':'quarantined'};
  }
  committee.assertAssigned(request);
  await verifyFresh(snapshot,request);
  // No asynchronous work may intervene between this terminal-state check and submit.
  committee.assertAssigned(request);
  await submit(record);
  const confirmed=await waitConfirmed(record.txId);
  validateSigned({...record,transaction:confirmed},snapshot);
  return {transaction:confirmed,status:committee.observeAssignment(request).every(r=>r.status==='assigned')?'confirmed':'quarantined'};
}
