import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {observeRedemption} from './authority-return.mjs';

const text=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v);
const hex=value=>Buffer.from(value.sigma_serialize_bytes()).toString('hex');
const sourceFields=['sourceTxId','fromChain','toChain','fromAddress','toAddress','amount','bridgeFee','networkFee','sourceChainTokenId','targetChainTokenId','sourceBlockId'];
const observationFields=[...sourceFields,'height','requestId'];
const u64=value=>{const bytes=Buffer.alloc(8);bytes.writeBigUInt64BE(BigInt(value));return bytes;};

/** Explicit trusted composition ports for tests/local host, never a receipt verdict. */
export function createReturnAuthorityVerifier({rpc,observeRedemption:observe,wasm,extractor,blake2b}) {
  assert(typeof rpc==='function' && typeof observe==='function' && typeof blake2b==='function');
  const transactionBytes=raw=>hex(wasm.Transaction.from_json(text(raw)));
  const boxBytes=raw=>hex(wasm.ErgoBox.from_json(text(raw)));
  const digest=value=>Buffer.from(blake2b(value,undefined,32)).toString('hex');
  const bytesReg=(box,register)=>Buffer.from(wasm.ErgoBox.from_json(text(box)).register_value(register).to_byte_array()).toString('hex');
  async function primary(claim) {
    assert(claim && typeof claim.id==='string');
    const found=await rpc('/blockchain/transaction/byId/'+claim.id);
    assert.equal(found.id,claim.id);assert(found.numConfirmations>=1,'Return authority unconfirmed transaction');
    assert.match(found.blockId,/^[0-9a-f]{64}$/);assert(Number.isSafeInteger(found.inclusionHeight) && found.inclusionHeight>=0);
    assert.equal(transactionBytes(found),transactionBytes(claim),'Return authority transaction bytes');return found;
  }
  function commitmentDigest(observation,WID) {
    return digest(Buffer.concat([Buffer.from(observation.sourceTxId),Buffer.from(observation.fromChain),Buffer.from(observation.toChain),
      Buffer.from(observation.fromAddress),Buffer.from(observation.toAddress),u64(observation.amount),u64(observation.bridgeFee),u64(observation.networkFee),
      Buffer.from(observation.sourceChainTokenId),Buffer.from(observation.targetChainTokenId),Buffer.from(observation.sourceBlockId),u64(observation.height),Buffer.from(WID,'hex')]));
  }
  return async function verify({returnReceipt,redemption,deployment,terms}) {
    const receipt=structuredClone(returnReceipt),d=structuredClone(deployment),source=structuredClone(redemption),policy=structuredClone(terms);
    const observation=await observe({receipt:source,deployment:d,terms:policy});
    assert.deepEqual(Object.keys(observation).sort(),[...observationFields].sort(),'Return complete observation');
    assert.equal(observation.fromChain,'ergo');assert.equal(observation.toChain,'monero');
    assert.equal(observation.sourceChainTokenId,d.tokens.Asset);assert.equal(observation.targetChainTokenId,'XMR');
    assert.equal(observation.requestId,digest(Buffer.from(observation.sourceTxId,'utf8')),'Return event identity');
    assert.deepEqual(receipt.observation,observation,'Return claimed observation');
    assert.equal(receipt.watcherObservations.length,2);receipt.watcherObservations.forEach(row=>assert.deepEqual(row,observation));
    assert.equal(d.watchers.length,2);assert.equal(receipt.commitments.length,2);assert.equal(receipt.commitmentTransactions.length,2);
    const wids=receipt.commitments.map(row=>row.WID);assert.equal(new Set(wids).size,2);assert.deepEqual(wids,d.watchers.map(row=>row.WID));
    wids.forEach(WID=>assert.match(WID,/^[0-9a-f]{64}$/));
    const transaction=await primary(receipt.transaction);
    assert.equal(new Set(transaction.inputs.map(row=>row.boxId)).size,transaction.inputs.length);
    const trigger=transaction.outputs.find(row=>row.boxId===receipt.trigger.boxId);assert(trigger,'Return trigger absent from primary transaction');
    assert.equal(trigger.transactionId,transaction.id);assert.equal(boxBytes(trigger),boxBytes(receipt.trigger),'Return claimed trigger bytes');
    assert.equal(trigger.ergoTree,d.contracts.EventTrigger.tree);assert.deepEqual(trigger.assets,[{tokenId:d.tokens.RWT,amount:20}]);
    assert.equal(boxBytes(await rpc('/utxo/byId/'+trigger.boxId)),boxBytes(trigger),'Return trigger not canonical/unspent');
    const widHash=digest(Buffer.concat(wids.map(WID=>Buffer.from(WID,'hex'))));assert.equal(bytesReg(trigger,4),widHash);
    const extracted=extractor.extractBoxData(trigger);assert(extracted,'Return trigger extraction');
    for(const field of sourceFields)assert.equal(extracted[field],observation[field],'Return source '+field);
    assert.equal(extracted.sourceChainHeight,observation.height);assert.equal(extracted.eventId,observation.requestId);
    assert.equal(extracted.WIDsCount,2);assert.equal(extracted.WIDsHash,widHash);assert.equal(extracted.txId,transaction.id);assert.equal(extracted.identifier,trigger.boxId);
    for(let i=0;i<2;i++) {
      const row=receipt.commitments[i],created=await primary(receipt.commitmentTransactions[i]);
      const box=created.outputs.find(output=>output.boxId===row.boxId);assert(box,'Return primary commitment absent');
      assert.equal(box.transactionId,created.id);assert.equal(box.ergoTree,d.contracts.Commitment.tree);
      assert.deepEqual(box.assets,[{tokenId:d.tokens.RWT,amount:10}]);
      assert.equal(transaction.inputs.filter(input=>input.boxId===box.boxId).length,1,'Return trigger did not consume commitment');
      assert.equal(bytesReg(box,4),wids[i]);assert.equal(bytesReg(box,5),observation.requestId);
      const expected=commitmentDigest(observation,wids[i]);assert.equal(bytesReg(box,6),expected);
      assert.equal(row.commitment,expected);assert.equal(row.requestId,observation.requestId);assert.equal(BigInt(row.rwtCount),10n);
    }
    assert.equal(new Set(receipt.commitments.map(row=>row.boxId)).size,2);
    assert.deepEqual(await observe({receipt:source,deployment:d,terms:policy}),observation,'Return source changed during admission');
    const closing=await primary(transaction);assert.equal(closing.blockId,transaction.blockId);assert.equal(closing.inclusionHeight,transaction.inclusionHeight);
    assert.equal(boxBytes(await rpc('/utxo/byId/'+trigger.boxId)),boxBytes(trigger),'Return trigger spent during admission');
    return {transaction:closing,trigger,event:{...extracted,height:closing.inclusionHeight},observation,wids};
  };
}

/** Actual primary/node/native extractor composition. No signing or submission. */
export async function verifyReturnAuthority(input) {
  const {config}=await import('../tools/config.mjs'),{rpc,wasm}=await import('./rosen-node.mjs');
  const info=await rpc('/info');assert.equal(info.network,'devnet');assert.equal(info.appVersion,'6.0.3');assert.equal(info.peersCount,0);
  const require=createRequire(path.join(config.rosenRoot,'package.json'));
  const load=relative=>import(pathToFileURL(path.join(config.rosenRoot,relative)).href);
  const {DataSource}=await load('node_modules/@rosen-bridge/extended-typeorm/dist/index.js');
  const {default:EventTriggerExtractor}=await load('node_modules/@rosen-bridge/watcher-data-extractor/dist/extractor/eventTriggerExtractor.js');
  const c=input.deployment.contracts;
  const extractor=new EventTriggerExtractor('local-return-authority',new DataSource({type:'sqlite',database:':memory:'}),'node','',c.EventTrigger.address,input.deployment.tokens.RWT,c.Permit.address,c.Fraud.address,undefined,false);
  return createReturnAuthorityVerifier({rpc,wasm,extractor,blake2b:require('blakejs').blake2b,observeRedemption})(input);
}
