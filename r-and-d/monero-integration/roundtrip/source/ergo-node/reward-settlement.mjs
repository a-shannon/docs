import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {canonicalAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {snapshotCreditSigning} from '../guard-service/src/deposit/moneroCreditSigner.mjs';
import {retainCreditRecord} from './credit-recovery.mjs';
import {openReturnRewardVerifier} from './return-reward.mjs';
import {exportRewardPaymentEvidence} from './reward-payment-authority.mjs';
import {rewardSettlement} from './reward-contribution.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const hex=value=>Buffer.from(value.sigma_serialize_bytes()).toString('hex');
const compact=s=>Object.fromEntries(['digest','txId','reducedHex','inputHex','dataHex','requiredSign'].map(key=>[key,s[key]]));
const safe=value=>JSON.parse(JSON.stringify(value,(_,item)=>typeof item==='bigint'?String(item):item));
const encode=value=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?{$rewardBigInt:String(item)}:item);
const decode=value=>JSON.parse(value,(_,item)=>item&&Object.getPrototypeOf(item)===Object.prototype&&Object.keys(item).join(',')==='$rewardBigInt'?BigInt(item.$rewardBigInt):item);
const same=(a,b,label)=>assert.equal(canonicalAssignment(safe(a)),canonicalAssignment(safe(b)),label);
const id=(value,label)=>assert(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),label);
const signedName='reward-signed.json',candidateName='reward-candidate.json',confirmedName='reward-confirmed.json';

function contextBinding(context,paymentTxId,settlement){
  assert(context&&Object.keys(context).sort().join(',')==='assignment,credit,deployment,feeAuthority,redemption,returnReceipt,snapshot,sourceContext,terms','Reward settlement context schema');
  id(paymentTxId,'Reward settlement payment ID');
  return hash(canonicalAssignment(safe({domain:'rosen-monero-reward-settlement-owner-v1',context,paymentTxId,settlement})));
}
function readExact(file){
  const stat=fs.statSync(file);assert(stat.isFile()&&stat.size>0&&stat.size<=4_000_000,'Reward retained record size');
  const value=fs.readFileSync(file,'utf8');assert.equal(Buffer.byteLength(value),stat.size,'Reward retained record drift');return value;
}
function readCandidate(file){
  const text=readExact(file),value=JSON.parse(text);assert(value&&Object.keys(value).sort().join(',')==='binding,transaction','Reward candidate schema');
  assert(typeof value.binding==='string'&&typeof value.transaction==='string','Reward candidate encoding');return {text,...value};
}
function readSigned(file){
  const value=decode(readExact(file));
  assert(value&&Object.keys(value).sort().join(',')==='assignment,binding,candidateText,contextDigest,order,paymentTxId,policyDigest,settlement,signCalls,signedHex,signedJson,snapshot,txId,version','Reward signed record schema');
  assert.equal(value.version,1);assert.equal(value.signCalls,1);id(value.txId,'Reward retained transaction ID');id(value.paymentTxId,'Reward retained payment ID');
  id(value.policyDigest,'Reward retained policy');id(value.contextDigest,'Reward retained context');assert(typeof value.binding==='string');
  assert(typeof value.candidateText==='string'&&value.candidateText.length>0&&value.candidateText.length<=2_000_000,'Reward retained candidate');
  assert(typeof value.signedHex==='string'&&/^(?:[0-9a-f]{2})+$/.test(value.signedHex)&&value.signedHex.length<=2_000_000,'Reward retained signed bytes');
  return value;
}
function explicitNotFound(error){return error?.status===404||/^Ergo HTTP 404 at (?:\/|https?:\/\/)/.test(String(error?.message??error));}
async function lookup(api,txId){try{return await api.rpc('/blockchain/transaction/byId/'+txId);}catch(error){if(explicitNotFound(error))return undefined;throw error;}}
async function waitConfirmed(api,txId){
  const attempts=api.confirmationAttempts??100,intervalMs=api.confirmationIntervalMs??200;
  assert(Number.isSafeInteger(attempts)&&attempts>0&&attempts<=1000,'Reward confirmation attempts');
  assert(Number.isSafeInteger(intervalMs)&&intervalMs>=0&&intervalMs<=10000,'Reward confirmation interval');
  for(let attempt=0;attempt<attempts;attempt++){
    const found=await lookup(api,txId);if(found&&Number(found.numConfirmations)>0)return found;
    if(found)assert.equal(found.id,txId,'Reward observed ID');
    if(attempt+1<attempts&&intervalMs)await new Promise(resolve=>setTimeout(resolve,intervalMs));
  }
  throw Error('Reward confirmation timeout '+txId);
}

export class RewardSubmissionReplyLostError extends Error{
  constructor(txId){super('Controlled reward submission reply loss '+txId);this.name='RewardSubmissionReplyLostError';this.code='REWARD_SUBMISSION_REPLY_LOST';this.txId=txId;}
}

async function defaultPorts(){
  const [{wasm,rpc,confirmed},{stateContext},{config}]=await Promise.all([import('./rosen-node.mjs'),import('./authority-fixture.mjs'),import('../tools/config.mjs')]);
  const {ErgoTransaction}=await import(pathToFileURL(path.join(config.rosenRoot,'packages/chains/ergo/dist/index.js')).href);
  return {wasm,rpc,confirmed,stateContext,ErgoTransaction,openVerifier:openReturnRewardVerifier,exportEvidence:exportRewardPaymentEvidence};
}
function candidateSnapshot(api,candidate){
  const box=value=>api.wasm.ErgoBox.sigma_parse_bytes(Buffer.from(value));
  return compact(snapshotCreditSigning(api.wasm.ReducedTransaction.sigma_parse_bytes(candidate.txBytes),3,candidate.inputBoxes.map(box),candidate.dataInputs.map(box)));
}
async function nativeSigned(api,record,expected,{fresh}){
  const candidate=api.ErgoTransaction.fromJson(JSON.parse(record.candidateText).transaction),captured=candidateSnapshot(api,candidate);
  assert.deepEqual(captured,expected,'Reward retained candidate/snapshot');assert.equal(candidate.txId,expected.txId,'Reward retained candidate ID');
  const signed=api.wasm.Transaction.sigma_parse_bytes(Buffer.from(record.signedHex,'hex'));
  assert.equal(hex(signed),record.signedHex,'Reward signed canonical bytes');assert.equal(signed.id().to_str(),expected.txId,'Reward signed native ID');
  const signedJson=JSON.parse(signed.to_json());assert.deepEqual(signedJson,record.signedJson,'Reward signed JSON drift');
  const proofs=signedJson.inputs.map(input=>{const proof=input.spendingProof?.proofBytes;assert(typeof proof==='string'&&/^(?:[0-9a-f]{2})*$/.test(proof),'Reward proof encoding');return Buffer.from(proof,'hex');});
  const reduced=api.wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(expected.reducedHex,'hex'));
  const unsigned=api.wasm.UnsignedTransaction.from_json(reduced.unsigned_tx().to_json());
  assert.equal(hex(api.wasm.Transaction.from_unsigned_tx(unsigned,proofs)),record.signedHex,'Reward signed/unsigned binding');
  if(fresh){
    const context=await api.stateContext(),boxes=expected.inputHex.map(value=>api.wasm.ErgoBox.sigma_parse_bytes(Buffer.from(value,'hex'))),data=expected.dataHex.map(value=>api.wasm.ErgoBox.sigma_parse_bytes(Buffer.from(value,'hex')));
    assert.equal(signed.inputs().len(),boxes.length,'Reward signed input count');
    for(let index=0;index<boxes.length;index++)assert(api.wasm.verify_tx_input_proof(index,context,signed,(()=>{const x=api.wasm.ErgoBoxes.empty();boxes.forEach(v=>x.add(v));return x;})(),(()=>{const x=api.wasm.ErgoBoxes.empty();data.forEach(v=>x.add(v));return x;})()),'Reward native input proof '+index);
  }
  return {native:signed,signedJson,candidate};
}
function signedWrapper(api,record,candidateText){
  const candidate=api.ErgoTransaction.fromJson(JSON.parse(candidateText).transaction);
  return new api.ErgoTransaction(record.txId,candidate.eventId,Buffer.from(record.signedHex,'hex'),candidate.txType,candidate.inputBoxes,candidate.dataInputs);
}
async function canonicalConfirmed(api,found,record){
  assert.equal(found.id,record.txId,'Reward confirmed ID');assert(Number.isSafeInteger(found.numConfirmations)&&found.numConfirmations>0,'Reward confirmation');
  id(found.blockId,'Reward confirmation block');assert(Number.isSafeInteger(found.inclusionHeight)&&found.inclusionHeight>=0,'Reward inclusion height');
  assert.equal(hex(api.wasm.Transaction.from_json(JSON.stringify(found))),record.signedHex,'Reward canonical node bytes');
  assert.deepEqual(await api.rpc('/blocks/at/'+found.inclusionHeight),[found.blockId],'Reward canonical block');
  const closing=await api.rpc('/blockchain/transaction/byId/'+record.txId);assert.equal(closing.id,record.txId,'Reward closing ID');
  assert.equal(closing.blockId,found.blockId,'Reward canonical block changed');assert.equal(closing.inclusionHeight,found.inclusionHeight,'Reward canonical height changed');
  assert.equal(hex(api.wasm.Transaction.from_json(JSON.stringify(closing))),record.signedHex,'Reward closing node bytes');
  assert.deepEqual(await api.rpc('/blocks/at/'+closing.inclusionHeight),[closing.blockId],'Reward closing canonical block');return closing;
}
function attempts(directory){return fs.readdirSync(directory).filter(name=>/^reward-submit-attempt-[1-9][0-9]*\.json$/.test(name)).sort((a,b)=>Number(a.match(/[0-9]+/)[0])-Number(b.match(/[0-9]+/)[0]));}
function markSubmission(directory,record){
  const sequence=attempts(directory).length+1,file=path.join(directory,`reward-submit-attempt-${sequence}.json`);
  retainCreditRecord(file,JSON.stringify({version:1,sequence,txId:record.txId,signedDigest:hash(Buffer.from(record.signedHex,'hex')),contextDigest:record.contextDigest}));return sequence;
}
function retainConfirmation(directory,record,receipt){
  const file=path.join(directory,confirmedName),body=JSON.stringify({version:1,txId:record.txId,signedDigest:hash(Buffer.from(record.signedHex,'hex')),
    blockId:receipt.blockId,inclusionHeight:receipt.inclusionHeight});
  if(fs.existsSync(file))assert.equal(readExact(file),body,'Reward retained confirmation conflict');else retainCreditRecord(file,body);
}
function restarted(guards){const starts=guards.counts?.starts;return Array.isArray(starts)?starts.filter(value=>Number.isSafeInteger(value)&&value>1).length:0;}
async function rewardState(guards,context,anchor,expected){
  const state=await guards.rewardState(structuredClone(context.assignment),structuredClone(anchor));
  assert(state&&['assigned','unassigned'].includes(state.status),'Reward guard state');
  if(expected){assert.equal(state.status,'assigned','Reward guard assignment missing');same(state.assignment,expected,'Reward guard assignment changed');}
  return state;
}
function verifyStatic(record,{candidate,contextDigest,paymentTxId,settlement,verifier}){
  assert.equal(record.contextDigest,contextDigest,'Reward retained owner context');assert.equal(record.paymentTxId,paymentTxId,'Reward retained payment');
  assert.equal(record.policyDigest,verifier.policyDigest,'Reward retained policy');assert.equal(record.binding,verifier.binding,'Reward retained verifier binding');
  assert.equal(record.candidateText,candidate.text,'Reward retained candidate bytes');assert.equal(candidate.binding,record.binding,'Reward candidate binding');
  assert.equal(record.txId,record.snapshot.txId,'Reward retained snapshot ID');same(record.settlement,settlement,'Reward retained settlement');
  assert.equal(record.assignment.binding?.creditTransactionDigest,record.snapshot.digest,'Reward retained assignment candidate');
  assert.equal(record.assignment.rewardTransactionId,record.txId,'Reward retained assignment transaction');
  assert.equal(record.assignment.paymentTxId,record.paymentTxId,'Reward retained assignment payout');
  assert.equal(record.assignment.rewardPolicyDigest,record.policyDigest,'Reward retained assignment policy');
  same(record.assignment.settlement,record.settlement,'Reward retained assignment settlement');
}
function compareCreated(created,record,candidate){
  assert.equal(created.policyDigest,record.policyDigest,'Reward fresh policy');assert.equal(created.binding,record.binding,'Reward fresh binding');
  assert.deepEqual(compact(created.snapshot),record.snapshot,'Reward fresh snapshot');same(created.order,record.order,'Reward fresh order');
  assert.equal(created.transaction.toJson(),candidate.transaction,'Reward fresh candidate');
}
function result(api,verifier,record,receipt,controls){
  const candidate=JSON.parse(record.candidateText).transaction;
  const transaction=api.buildSignedTransaction?api.buildSignedTransaction(record,candidate):signedWrapper(api,record,record.candidateText);
  assert.equal(transaction.txId,record.txId,'Reward returned transaction ID');
  assert.equal(Buffer.from(transaction.txBytes).toString('hex'),record.signedHex,'Reward returned signed bytes');
  return Object.freeze({transaction,receipt:structuredClone(receipt),snapshot:structuredClone(record.snapshot),order:structuredClone(record.order),policyDigest:record.policyDigest,
    assignment:structuredClone(record.assignment),controls:Object.freeze(controls),chain:verifier.chain,verifier});
}

/** Local-only reward execution. Signing and submission remain injected capabilities. */
export async function settleReward(options,trustedPorts){
  const schema=options&&Object.keys(options).sort().join(',');
  assert(schema==='anchor,context,directory,guards,paymentTxId,syncSource'||schema==='anchor,context,directory,guards,paymentTxId,simulateLostSubmissionReply,syncSource','Reward settlement options schema');
  const {anchor,context,paymentTxId,guards,directory,syncSource,simulateLostSubmissionReply=false}=options;
  assert.equal(typeof simulateLostSubmissionReply,'boolean','Reward lost-reply simulation');
  assert(path.isAbsolute(directory),'Reward settlement directory');assert(guards&&typeof guards.sign==='function'&&typeof guards.rewardState==='function'&&typeof guards.verifyReward==='function','Reward settlement guards');
  assert.equal(typeof syncSource,'function','Reward settlement source synchronizer');fs.mkdirSync(directory,{recursive:true});
  const api=trustedPorts??await defaultPorts(),settlement=rewardSettlement(anchor),ownerDigest=contextBinding(context,paymentTxId,settlement);
  const verifier=await api.openVerifier({...context,paymentTxId,directory}),signedFile=path.join(directory,signedName),candidateFile=path.join(directory,candidateName);
  const verifySigned=async(record,fresh)=>api.verifySignedRecord?api.verifySignedRecord(record,record.snapshot,{fresh}):nativeSigned(api,record,record.snapshot,{fresh});
  const verifyConfirmed=async(found,record)=>api.verifyConfirmed?api.verifyConfirmed(found,record):canonicalConfirmed(api,found,record);
  const finish=(record,receipt,existing,knownBefore,hadConfirmation)=>result(api,verifier,record,receipt,{signCalls:record.signCalls,submissions:attempts(directory).length,
    recoveredLostReply:existing&&knownBefore&&!hadConfirmation&&attempts(directory).length>0,restartedGuards:restarted(guards),sameSignedBytes:true,noResignAfterConfirmed:existing&&knownBefore});
  if(fs.existsSync(signedFile)){
    assert(fs.existsSync(candidateFile),'Reward recovery missing candidate');const candidate=readCandidate(candidateFile),record=readSigned(signedFile),hadConfirmation=fs.existsSync(path.join(directory,confirmedName));
    verifyStatic(record,{candidate,contextDigest:ownerDigest,paymentTxId,settlement,verifier});await rewardState(guards,context,anchor,record.assignment);await verifySigned(record,false);
    const known=await lookup(api,record.txId);
    if(known&&Number(known.numConfirmations)>0){const receipt=await verifyConfirmed(known,record);await rewardState(guards,context,anchor,record.assignment);retainConfirmation(directory,record,receipt);return finish(record,receipt,true,true,hadConfirmation);}
    if(known){assert.equal(known.id,record.txId,'Reward observed ID');if(api.verifyObserved)await api.verifyObserved(known,record);else assert.equal(hex(api.wasm.Transaction.from_json(JSON.stringify(known))),record.signedHex,'Reward observed node bytes');}
    await syncSource();const evidence=(api.exportEvidence??exportRewardPaymentEvidence)(anchor);
    const reward={anchor:structuredClone(anchor),context:structuredClone(context),evidence:structuredClone(evidence),paymentTxId};
    const revalidated=await guards.verifyReward(record.snapshot,reward);same(revalidated,record.assignment,'Reward fresh guard assignment');
    const created=await verifier.create(directory);compareCreated(created,record,candidate);await rewardState(guards,context,anchor,record.assignment);await verifySigned(record,true);
    assert.equal(await api.rpc('/transactions/check',record.signedJson),record.txId,'Reward node check ID');
    await rewardState(guards,context,anchor,record.assignment);
    if(!known){markSubmission(directory,record);assert.equal(await api.rpc('/transactions',record.signedJson),record.txId,'Reward submission ID');}
    const receipt=await verifyConfirmed(await waitConfirmed(api,record.txId),record);await rewardState(guards,context,anchor,record.assignment);retainConfirmation(directory,record,receipt);return finish(record,receipt,true,false,hadConfirmation);
  }
  const opening=await rewardState(guards,context,anchor);assert.equal(opening.status,'unassigned','Reward guards assigned without signed record');
  const created=await verifier.create(directory),candidate=readCandidate(candidateFile);assert.equal(candidate.binding,verifier.binding,'Reward candidate binding');
  assert.equal(created.transaction.toJson(),candidate.transaction,'Reward candidate bytes');const snapshot=compact(created.snapshot);
  await syncSource();const evidence=(api.exportEvidence??exportRewardPaymentEvidence)(anchor);
  const signed=await guards.sign(snapshot,{reward:{anchor:structuredClone(anchor),context:structuredClone(context),evidence:structuredClone(evidence),paymentTxId}});
  assert.equal(signed.txId,snapshot.txId,'Reward guard signed ID');assert(typeof signed.signedHex==='string','Reward guard signed bytes');
  const assigned=await rewardState(guards,context,anchor);assert.equal(assigned.status,'assigned','Reward guards did not retain assignment');
  const provisional={version:1,binding:verifier.binding,contextDigest:ownerDigest,paymentTxId,settlement:structuredClone(settlement),policyDigest:verifier.policyDigest,
    candidateText:candidate.text,snapshot,order:structuredClone(created.order),assignment:structuredClone(assigned.assignment),txId:snapshot.txId,
    signedHex:signed.signedHex,signedJson:null,signCalls:1};
  const checked=api.verifySignedRecord?await api.verifySignedRecord({...provisional,signedJson:{}},snapshot,{fresh:true}):await nativeSigned(api,{...provisional,signedJson:JSON.parse(api.wasm.Transaction.sigma_parse_bytes(Buffer.from(signed.signedHex,'hex')).to_json())},snapshot,{fresh:true});
  provisional.signedJson=structuredClone(checked.signedJson);const body=encode(provisional);retainCreditRecord(signedFile,body);const record=readSigned(signedFile);
  verifyStatic(record,{candidate,contextDigest:ownerDigest,paymentTxId,settlement,verifier});
  assert.equal(await api.rpc('/transactions/check',record.signedJson),record.txId,'Reward node check ID');await rewardState(guards,context,anchor,record.assignment);markSubmission(directory,record);
  assert.equal(await api.rpc('/transactions',record.signedJson),record.txId,'Reward submission ID');
  if(simulateLostSubmissionReply)throw new RewardSubmissionReplyLostError(record.txId);
  const receipt=await verifyConfirmed(await waitConfirmed(api,record.txId),record);await rewardState(guards,context,anchor,record.assignment);retainConfirmation(directory,record,receipt);return finish(record,receipt,false,false,false);
}
