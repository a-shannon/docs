import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {MoneroCreditAssignment,canonicalAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {freshCreditConfigurations} from './credit-custody.mjs';

const hash=value=>assert(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),'Fresh source scope');
function freeze(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const item of Object.values(value))freeze(item);
    Object.freeze(value);
  }
  return value;
}
const copy=value=>freeze(structuredClone(value));

/** Observe each in-process guard's existing custody; never create a ledger here. */
export function createInProcessClaimReader({directory,deployment,freshAdmission}){
  assert(path.isAbsolute(directory),'Credit custody directory');
  const candidateScope=freshAdmission?.candidate?.scope,readers=freshAdmission?.readers;
  assert(Array.isArray(readers)&&readers.length===4,'Credit source readers');
  const genesis=readers[0]?.genesis;
  hash(candidateScope);hash(genesis);
  assert(readers.every(reader=>reader.scope===candidateScope&&reader.genesis===genesis),'Credit source configuration');
  const configs=freshCreditConfigurations({deployment,scope:candidateScope,genesis});
  const guardDirectory=path.join(directory,'guards'),candidateFile=path.join(directory,'candidate.json'),
    signedFile=path.join(directory,'signed-credit.json');
  return (obligationId,index)=>{
    assert(Number.isInteger(index)&&index>=0&&index<4,'Credit guard index');
    if(!fs.existsSync(guardDirectory)){
      assert(!fs.existsSync(candidateFile)&&!fs.existsSync(signedFile),'Credit retained custody missing');
      return {status:'missing'};
    }
    const stat=fs.lstatSync(guardDirectory);
    assert(stat.isDirectory()&&!stat.isSymbolicLink(),'Credit retained custody directory');
    const manifest=path.join(guardDirectory,'committee-bootstrap.json');
    assert(fs.existsSync(manifest),'Credit retained custody incomplete');
    const manifestStat=fs.lstatSync(manifest);
    assert(manifestStat.isFile()&&!manifestStat.isSymbolicLink(),'Credit retained custody manifest');
    const files=configs.map((_,i)=>path.join(guardDirectory,`guard-${i}.sqlite`));
    assert(files.every(file=>fs.existsSync(file)),'Credit retained custody incomplete');
    const ledger=MoneroCreditAssignment.openReadOnly(files[index],configs[index]);
    try{return ledger.readClaim(obligationId);}finally{ledger.close();}
  };
}

/** An assigned source may authorize only its original trigger and reduced transaction. */
export function assertExactCreditClaim({readClaim,index,decision,assignment}){
  if(!readClaim)return;
  const claim=readClaim(decision.depositId,index);
  assert(claim&&['missing','assigned','invalidated'].includes(claim.status),'Guard claim state');
  assert.notEqual(claim.status,'invalidated','Guard claim invalidated');
  if(decision.status==='retained')assert.equal(claim.status,'assigned','Guard retained claim missing');
  if(claim.status==='assigned')assert.equal(canonicalAssignment(claim.request),canonicalAssignment(assignment),'Guard retained claim mismatch');
}

function semantic(result,retained=false){
  assert(result&&result.status===(retained?'retained':'accepted'),'Fresh source not accepted');
  assert(result.backing?.version===2&&Number.isSafeInteger(result.backing.blockHeight)&&result.backing.blockHeight>=0,'Fresh source backing');
  assert(result.decision?.status===(retained?'retained':'accepted'),'Fresh source decision');
  if(retained)assert.equal(result.decision.authority,'assigned-claim-source-only','Retained source authority');
  const observation=structuredClone(result.observation);
  assert(observation&&Object.getPrototypeOf(observation)===Object.prototype&&
    Object.hasOwn(observation,'rawData')&&observation.rawData===''&&!Object.hasOwn(observation,'height'),'Fresh source observation');
  delete observation.rawData;observation.height=result.backing.blockHeight;
  const backing=result.backing,decision=result.decision;
  assert.equal(observation.sourceTxId,backing.txId,'Fresh source binding');assert.equal(observation.sourceBlockId,backing.blockHash,'Fresh source binding');
  assert.equal(observation.toAddress,backing.recipient,'Fresh source binding');assert.equal(observation.targetChainTokenId,backing.destinationAsset,'Fresh source binding');
  assert.equal(observation.amount,backing.amountAtomic,'Fresh source binding');assert.equal(decision.intentHash,backing.intentHash,'Fresh source binding');
  assert.equal(decision.txid,backing.txId,'Fresh source binding');assert.equal(decision.blockHash,backing.blockHash,'Fresh source binding');
  assert.equal(decision.blockHeight,BigInt(backing.blockHeight),'Fresh source binding');assert.equal(decision.recipient,backing.recipient,'Fresh source binding');
  assert.equal(decision.sourceNetwork,'mainnet','Fresh source binding');assert.equal(decision.evidenceMode,'independent','Fresh source binding');
  assert.equal(decision.destinationNetwork,backing.destinationNetwork,'Fresh source binding');assert.equal(decision.destinationAsset,backing.destinationAsset,'Fresh source binding');
  assert.equal(decision.amount.toString(),backing.amountAtomic,'Fresh source binding');assert.equal(decision.destinationAmount.toString(),backing.creditedAtomic,'Fresh source binding');
  assert.equal(decision.netAmount,decision.destinationAmount,'Fresh source binding');assert.equal(decision.retainedAtomicRemainder,0n,'Fresh source binding');
  assert.equal(observation.bridgeFee,decision.bridgeFee.toString(),'Fresh source binding');assert.equal(observation.networkFee,decision.networkFee.toString(),'Fresh source binding');
  assert.equal(decision.depositId,`monero:deposit:mainnet:${backing.txId}`,'Fresh source binding');
  assert(Array.isArray(decision.outputs)&&decision.outputs.length===1&&decision.outputs[0].publicKey===backing.outputKey,'Fresh source binding');
  return freeze({observation,backing:structuredClone(result.backing),decision:structuredClone(result.decision)});
}

/** Four configured readers joined to one candidate; retained reads require an exact durable claim. */
export async function captureFreshCreditSource({freshAdmission,watcherReceipt,readClaim}){
  const supplied=freshAdmission?.readers;
  assert(Array.isArray(supplied)&&supplied.length===4,'Fresh source requires four readers');
  const readers=Object.freeze([...supplied]),candidate=copy(freshAdmission?.candidate);
  assert(new Set(readers).size===4,'Fresh source requires distinct readers');
  hash(candidate?.scope);
  assert(readClaim===undefined||typeof readClaim==='function','Fresh source claim reader');
  const identities=Object.freeze(readers.map(reader=>Object.freeze({reader,scope:reader?.scope,inspect:reader?.inspect,
    retained:reader?.readRetainedBacking})));
  const expected=copy(watcherReceipt?.observation);
  assert(expected&&Object.getPrototypeOf(expected)===Object.prototype&&!Object.hasOwn(expected,'rawData'),'Fresh watcher observation');
  if(readClaim)hash(watcherReceipt?.trigger?.boxId);
  const obligationId=`monero:deposit:mainnet:${candidate.txId}`;
  function current(){
    hash(candidate.scope);
    for(let i=0;i<readers.length;i++){const reader=readers[i],identity=identities[i];
      assert(reader===identity.reader&&reader?.scope===identity.scope&&reader.scope===candidate.scope&&
        reader.inspect===identity.inspect&&typeof identity.inspect==='function'&&
        (!readClaim||(reader.readRetainedBacking===identity.retained&&typeof identity.retained==='function')),'Fresh source scope');}
  }
  function claim(index){
    if(!readClaim)return {status:'missing'};
    const found=structuredClone(readClaim(obligationId,index));
    assert(found&&['missing','assigned','invalidated'].includes(found.status),'Fresh source claim state');
    if(found.status==='missing')return found;
    assert.equal(found.request?.binding?.obligationId,obligationId,'Fresh source claim binding');
    assert.equal(found.request.binding.triggerBoxId,watcherReceipt.trigger.boxId,'Fresh source claim trigger');
    return found;
  }
  async function inspect(index){
    current();assert(Number.isSafeInteger(index)&&index>=0&&index<4,'Fresh source reader');
    const prior=claim(index);assert.notEqual(prior.status,'invalidated','Fresh source claim invalidated');
    const retained=prior.status==='assigned';
    const result=semantic(retained
      ?await identities[index].retained.call(readers[index],candidate,prior.request.backing,new AbortController().signal)
      :await identities[index].inspect.call(readers[index],candidate,new AbortController().signal),retained);
    const latest=claim(index);
    if(retained){assert.equal(latest.status,'assigned','Fresh source claim changed');
      assert.deepEqual(latest.request,prior.request,'Fresh source claim changed');
      assert.deepEqual(result.backing,prior.request.backing,'Fresh source claim backing');
      assert.equal(result.decision.intentHash,prior.request.binding.sourceIntentDigest,'Fresh source claim intent');}
    else assert.equal(latest.status,'missing','Fresh source claim changed');
    assert.deepEqual(result.observation,expected,'Fresh source watcher receipt');
    current();return result;
  }
  const initial=await inspect(0);hash(initial.backing.genesis);
  const stable=freeze({observation:initial.observation,backing:initial.backing});
  async function read(index){
    const result=await inspect(index);
    assert.deepEqual(result.observation,stable.observation,'Fresh source observation');
    assert.deepEqual(result.backing,stable.backing,'Fresh source backing');
    return result;
  }
  async function revalidate(index,prior){
    assert.deepEqual(prior?.observation,stable.observation,'Fresh source observation');
    assert.deepEqual(prior?.backing,stable.backing,'Fresh source backing');
    return read(index);
  }
  return Object.freeze({scope:candidate.scope,genesis:initial.backing.genesis,candidate,readers,initial,read,revalidate,current});
}
