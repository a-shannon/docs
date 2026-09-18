import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {validateReturnTerms} from './authority-return.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const hex=value=>Buffer.from(value.sigma_serialize_bytes()).toString('hex');
const text=value=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?String(item):item);
const hash32=value=>assert(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),'V2 withdrawal hash');
const atomic=value=>{assert(typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=0xffffffffffffffffn,'V2 withdrawal amount');return BigInt(value);};
const eventFields=['height','fromChain','toChain','fromAddress','toAddress','amount','bridgeFee','networkFee',
  'sourceChainTokenId','targetChainTokenId','sourceTxId','sourceChainHeight','sourceBlockId','WIDsHash','WIDsCount'];

/** Read-only composition. Ports are locally configured implementations, never
 * caller verdicts. The caller owns exact ledger membership and fresh unspent
 * Monero currentness on both sides of this asynchronous verification. */
export function createV2WithdrawalAuthorityVerifier({rpc,wasm,verifyReturnAuthority,captureRequest,decodeSelection,snapshotCreditSigning,tree}){
  for(const port of [rpc,verifyReturnAuthority,captureRequest,decodeSelection,snapshotCreditSigning,tree])assert.equal(typeof port,'function');
  const nativeBox=value=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(value,'hex'));
  const txBytes=value=>hex(wasm.Transaction.from_json(text(value)));
  const boxBytes=value=>hex(wasm.ErgoBox.from_json(text(value)));
  async function isolated(){const info=await rpc('/info');assert.equal(info.network,'devnet');assert.equal(info.appVersion,'6.0.3');assert.equal(info.peersCount,0);}
  async function primaryCredit(credit){
    const found=await rpc('/blockchain/transaction/byId/'+credit.txId);
    assert.equal(found.id,credit.txId,'V2 credit primary identity');
    assert(Number.isSafeInteger(found.numConfirmations)&&found.numConfirmations>=1,'V2 credit unconfirmed');
    hash32(found.blockId);assert(Number.isSafeInteger(found.inclusionHeight)&&found.inclusionHeight>=0,'V2 credit inclusion');
    assert.equal(txBytes(found),credit.signedHex,'V2 credit primary bytes');return found;
  }
  async function inspectCredit(input){
    const {assignment,snapshot,credit,deployment,sourceContext:context}=input,backing=assignment?.backing;
    assert.equal(backing?.version,2,'V2 backing profile');
    assert(context&&Object.keys(context).sort().join(',')==='genesis,maxMinerFeeAtomic,nativeNetwork,sourceNetwork,vaultAddress,vaultSpend','V2 source context');
    for(const name of ['genesis','vaultSpend']){hash32(context[name]);assert.equal(context[name],backing[name],'V2 source '+name);}
    assert.equal(context.vaultAddress,backing.vaultAddress,'V2 source vaultAddress');
    assert(['mainnet','testnet','stagenet'].includes(context.nativeNetwork),'V2 native network');
    assert(typeof context.sourceNetwork==='string'&&context.sourceNetwork.length>0,'V2 source network');
    assert(atomic(context.maxMinerFeeAtomic)>0n,'V2 miner ceiling');
    assert.equal(backing.destinationNetwork,'ergo-testnet','V2 credit destination');
    assert.equal(backing.destinationAsset,deployment.tokens.Asset,'V2 credit asset');
    assert.equal(assignment.binding.sourceIntentDigest,backing.intentHash,'V2 source intent');
    assert.deepEqual(assignment.outputs,[{sourceNetwork:'mainnet',publicKey:backing.outputKey}],'V2 assigned output');
    assert.equal(snapshot.requiredSign,3,'V2 credit threshold');
    const captured=snapshotCreditSigning(wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(snapshot.reducedHex,'hex')),snapshot.requiredSign,
      snapshot.inputHex.map(nativeBox),snapshot.dataHex.map(nativeBox));
    assert.equal(captured.digest,snapshot.digest,'V2 credit snapshot digest');
    assert.equal(captured.txId,snapshot.txId,'V2 credit snapshot identity');
    assert.equal(captured.digest,assignment.binding.creditTransactionDigest,'V2 assigned credit digest');
    assert.equal(credit.txId,captured.txId,'V2 credited transaction');
    assert.equal(credit.policyDigest,assignment.binding.policyDigest,'V2 credit policy');
    const signed=wasm.Transaction.sigma_parse_bytes(Buffer.from(credit.signedHex,'hex'));
    assert.equal(signed.id().to_str(),credit.txId,'V2 signed credit identity');
    assert.equal(hex(signed),credit.signedHex,'V2 canonical signed credit');
    assert.equal(txBytes(credit.transaction),credit.signedHex,'V2 credit record bytes');
    const signedJson=JSON.parse(signed.to_json());
    const proofs=signedJson.inputs.map(row=>{const proof=row.spendingProof?.proofBytes;
      assert(typeof proof==='string'&&/^(?:[0-9a-f]{2})*$/.test(proof),'V2 credit proof encoding');return Buffer.from(proof,'hex');});
    // Preserve the recorded reduction's exact unsigned bytes and extensions.
    const unsigned=wasm.UnsignedTransaction.from_json(captured.reduced.unsigned_tx().to_json());
    assert.equal(hex(wasm.Transaction.from_unsigned_tx(unsigned,proofs)),credit.signedHex,'V2 signed/unsigned credit binding');
    await isolated();const primary=await primaryCredit(credit);
    const choices=primary.outputs.filter(box=>box.ergoTree===tree(backing.recipient)&&box.assets.length===1&&box.assets[0].tokenId===backing.destinationAsset);
    assert.equal(choices.length,1,'V2 unique credited occurrence');const creditBox=choices[0];
    assert.equal(BigInt(creditBox.assets[0].amount),atomic(backing.creditedAtomic),'V2 credited amount');
    assert(atomic(backing.creditedAtomic)>0n,'V2 positive credit');
    assert.equal(creditBox.transactionId,credit.txId,'V2 credited output transaction');
    assert.equal(signed.outputs().get(primary.outputs.indexOf(creditBox)).box_id().to_str(),creditBox.boxId,'V2 credited box identity');
    return {primary,creditBox,identity:{assignmentDigest:hash(canonicalAssignment(assignment)),creditTransactionId:credit.txId,creditBoxId:creditBox.boxId}};
  }
  async function closeCredit(input,opened){
    const closing=await primaryCredit(input.credit);
    assert.equal(closing.blockId,opened.primary.blockId,'V2 credit canonical block changed');
    assert.equal(closing.inclusionHeight,opened.primary.inclusionHeight,'V2 credit canonical height changed');await isolated();
  }
  async function verifyRetainedCredit(value){
    const input=structuredClone(value),opened=await inspectCredit(input);await closeCredit(input,opened);
    // Observation only. It neither checks a live return trigger nor authorizes
    // a withdrawal. The caller separately binds the retained settlement/final.
    return Object.freeze(opened.identity);
  }
  async function verifyWithdrawal(value){
    const input=structuredClone(value),opened=await inspectCredit(input);
    const {assignment,redemption,returnReceipt,terms,deployment,sourceContext:context}=input,backing=assignment.backing;
    validateReturnTerms(terms);
    assert.equal(redemption.creditTransactionId,input.credit.txId,'V2 redemption credited transaction');
    assert.equal(redemption.creditSignedHex,input.credit.signedHex,'V2 redemption credited bytes');
    assert.equal(redemption.consumedCreditBoxId,opened.creditBox.boxId,'V2 redemption credited box');
    assert.equal(redemption.creditBoxHex,boxBytes(opened.creditBox),'V2 redemption credited box bytes');
    assert.equal(redemption.recipientAddress,backing.recipient,'V2 redemption owner');
    const trusted=await verifyReturnAuthority({returnReceipt,redemption,terms,deployment}),event=trusted.event;
    assert.equal(event.sourceTxId,redemption.txId,'V2 redemption source transaction');
    assert.equal(event.fromAddress,backing.recipient,'V2 return owner');
    assert.equal(event.amount,backing.creditedAtomic,'V2 return credited amount');
    assert.equal(event.toAddress,terms.toAddress,'V2 return destination');
    assert.equal(event.bridgeFee,terms.bridgeFee,'V2 return bridge fee');assert.equal(event.networkFee,terms.networkFee,'V2 return network fee');
    assert.equal(event.sourceChainTokenId,backing.destinationAsset,'V2 return asset');assert.equal(event.targetChainTokenId,'XMR');
    const projection=await captureRequest(input.request),document=JSON.parse(projection.request.canonicalRequest);
    assert.equal(projection.eventId,event.eventId,'V2 withdrawal event');
    const expectedSource={event:Object.fromEntries(eventFields.map(name=>[name,String(event[name])])),
      triggerTransactionId:trusted.transaction.id,triggerBoxId:trusted.trigger.boxId,wids:trusted.wids};
    assert.deepEqual(document.source,expectedSource,'V2 withdrawal complete source');
    const amount=atomic(backing.creditedAtomic)-atomic(terms.bridgeFee)-atomic(terms.networkFee);assert(amount>0n,'V2 payout positive amount');
    assert.equal(document.gross,backing.creditedAtomic,'V2 payout gross');
    assert.equal(document.chargedBridgeFee,terms.bridgeFee,'V2 payout bridge fee');assert.equal(document.chargedNetworkFee,terms.networkFee,'V2 payout network fee');
    assert.equal(projection.amount,amount.toString(),'V2 payout amount');assert.equal(projection.address,terms.toAddress,'V2 payout recipient');
    assert.equal(projection.network,context.nativeNetwork,'V2 payout network');assert.equal(projection.sourceNetwork,context.sourceNetwork,'V2 payout source network');
    assert.equal(projection.ceiling,context.maxMinerFeeAtomic,'V2 payout miner ceiling');
    const selectionBytes=typeof input.selection==='string'?input.selection:input.selection?.bytes;
    const selection=decodeSelection(selectionBytes);
    assert.equal(selection.network,context.nativeNetwork,'V2 selection network');assert.equal(selection.vaultSpend,backing.vaultSpend,'V2 selection vault');
    assert.equal(selection.inputs.length,2,'V2 selection input count');
    const occurrences=selection.inputs.filter(row=>row.publicKey===backing.outputKey);assert.equal(occurrences.length,1,'V2 selected credited occurrence');
    const selected=occurrences[0];
    for(const [name,expected] of Object.entries({txid:backing.txId,outputIndex:String(backing.outputIndex),globalIndex:String(backing.globalIndex),
      publicKey:backing.outputKey,amount:backing.amountAtomic}))assert.equal(selected[name],expected,'V2 selected backing '+name);
    await closeCredit(input,opened);
    return Object.freeze({...opened.identity,redemptionTxId:redemption.txId,returnTriggerBoxId:trusted.trigger.boxId,eventId:event.eventId,
      requestDigest:projection.requestDigest,selectionDigest:hash(selectionBytes),recipient:projection.address,amountAtomic:projection.amount});
  }
  return Object.freeze({verifyWithdrawal,verifyRetainedCredit});
}

async function productionVerifier(){
  const [{rpc,wasm,tree},{verifyReturnAuthority},{snapshotCreditSigning},{captureUnapprovedMoneroPayoutRequest},{decodeNativeSelection}]=await Promise.all([
    import('./rosen-node.mjs'),import('./return-authority.mjs'),import('../guard-service/src/deposit/moneroCreditSigner.mjs'),
    import('../guard-service/src/withdrawal/moneroWithdrawalNativeProjection.ts'),import('../guard-service/src/withdrawal/moneroWithdrawalSelection.ts')]);
  return createV2WithdrawalAuthorityVerifier({rpc,wasm,tree,verifyReturnAuthority,snapshotCreditSigning,
    captureRequest:captureUnapprovedMoneroPayoutRequest,decodeSelection:decodeNativeSelection});
}
export async function verifyV2Withdrawal(value){const input=structuredClone(value);return (await productionVerifier()).verifyWithdrawal(input);}
export async function verifyV2RetainedCredit(value){const input=structuredClone(value);return (await productionVerifier()).verifyRetainedCredit(input);}
