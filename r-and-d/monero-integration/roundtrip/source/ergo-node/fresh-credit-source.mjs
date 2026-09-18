import assert from 'node:assert/strict';

const hash=value=>assert(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),'Fresh source scope');
function freeze(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const item of Object.values(value))freeze(item);
    Object.freeze(value);
  }
  return value;
}
const copy=value=>freeze(structuredClone(value));

function semantic(result){
  assert(result&&result.status==='accepted','Fresh source not accepted');
  assert(result.backing?.version===2&&Number.isSafeInteger(result.backing.blockHeight)&&result.backing.blockHeight>=0,'Fresh source backing');
  assert(result.decision?.status==='accepted','Fresh source decision');
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

/** Four configured fresh admission readers joined to one exact captured candidate. */
export async function captureFreshCreditSource({freshAdmission,watcherReceipt}){
  const supplied=freshAdmission?.readers;
  assert(Array.isArray(supplied)&&supplied.length===4,'Fresh source requires four readers');
  const readers=Object.freeze([...supplied]),candidate=copy(freshAdmission?.candidate);
  assert(new Set(readers).size===4,'Fresh source requires distinct readers');
  hash(candidate?.scope);
  const identities=Object.freeze(readers.map(reader=>Object.freeze({reader,scope:reader?.scope,inspect:reader?.inspect})));
  const expected=copy(watcherReceipt?.observation);
  assert(expected&&Object.getPrototypeOf(expected)===Object.prototype&&!Object.hasOwn(expected,'rawData'),'Fresh watcher observation');
  function current(){
    hash(candidate.scope);
    for(let i=0;i<readers.length;i++){const reader=readers[i],identity=identities[i];
      assert(reader===identity.reader&&reader?.scope===identity.scope&&reader.scope===candidate.scope&&
        reader.inspect===identity.inspect&&typeof identity.inspect==='function','Fresh source scope');}
  }
  async function inspect(index){
    current();assert(Number.isSafeInteger(index)&&index>=0&&index<4,'Fresh source reader');
    const result=semantic(await identities[index].inspect.call(readers[index],candidate,new AbortController().signal));
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
