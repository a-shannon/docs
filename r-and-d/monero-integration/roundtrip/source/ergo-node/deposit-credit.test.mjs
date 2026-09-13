import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDepositCredit} from './deposit-credit.mjs';
import crypto from 'node:crypto';
import {recipient,runtime,rpc} from './rosen-node.mjs';
const {encodeIntent,NATIVE_SOURCE_PIN}=await import(sourceURL('packages/monero-deposit/lib/index.ts'));
const parent=config.runtimeDirectory+'/ergo-adapter-tests';
fs.mkdirSync(parent,{recursive:true});
test('actual migrated registry rejects malformed request without an obligation or execution stage',async()=>{
 const directory=fs.mkdtempSync(path.join(parent,'schema-'));
 const context={id:'schema-test',revision:1n,configurationRevision:'schema-test-1',configuration:{},feePolicy:{},snapshot:{blockHeight:1n,chainHeight:2n,minConfirmations:1n}};
 const owner=await openDepositCredit({directory,context,providers:undefined});
 try {const result=await owner.run({request:{intentBytes:Buffer.from('bad')},observation:{},redemptionTerms:{}});assert.equal(result.admission.status,'rejected');}finally{await owner.close();}
 const db=new DatabaseSync(path.join(directory,'deposits.sqlite'));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM monero_deposit_decision').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM monero_credit_outbox').get().n,0);db.close();
 const journal=new DatabaseSync(path.join(directory,'execution.sqlite'));assert.equal(journal.prepare('SELECT COUNT(*) AS n FROM stages').get().n,0);journal.close();
 const reopened=await openDepositCredit({directory,context,providers:undefined});await reopened.close();
});
function syntheticSource() {
 const random=()=>crypto.randomBytes(32).toString('hex');
 const deployment=JSON.parse(fs.readFileSync(runtime+'/rosen-deployment.json'));
 const txid=random(),block=random(),key=random();
 const intent={domain:'rosen-monero-deposit',version:2,source_network:'stagenet',vault_epoch:'adapter-test',vault_address:'explicit-fixture-vault',destination_network:'ergo-testnet',destination_asset:deployment.tokens.Asset,to_address:recipient(),txid,amount:'1000',bridge_fee:'100',network_fee:'20',expiry_height:100n,outputs:[{output_index:0n,output_public_key:key,amount:'1000'}]};
 const context={id:'fixture-'+txid,revision:1n,configurationRevision:'fixture-only',configuration:{version:2,domain:intent.domain,sourceNetwork:intent.source_network,vaultEpoch:intent.vault_epoch,vaultAddress:intent.vault_address,destinationNetwork:intent.destination_network,destinationAsset:intent.destination_asset,nativeSourcePin:NATIVE_SOURCE_PIN},feePolicy:{bridgeFee:'100',networkFee:'20',sourceDecimals:12,destinationDecimals:12,remainder:'reject'},snapshot:{id:'fixture-snapshot-'+txid,network:'stagenet',txid,blockHash:block,blockHeight:10n,chainHeight:20n,minConfirmations:1n}};
 let calls=0;
 const identity=name=>({kind:'fixture',id:'explicit-adapter-test-'+name,sourcePin:NATIVE_SOURCE_PIN});
 const providers={addresses:{identity:identity('address'),verify:async r=>{calls++;return {status:'verified',value:r};}},proof:{identity:identity('proof'),verify:async r=>{calls++;return {status:'verified',value:{...r,good:true,received:1000n,inPool:false,confirmations:10n}};}},receipt:{identity:identity('receipt'),reconstruct:async(_i,_e,s)=>{calls++;return {status:'verified',value:{network:s.network,txid:s.txid,vaultAddress:intent.vault_address,blockHash:s.blockHash,blockHeight:s.blockHeight,snapshotId:s.id,inPool:false,outputs:[{index:0n,publicKey:key,amount:1000n,owned:true,maturity:'unlocked',spent:'unspent',keyOccurrences:1n}]}};}}};
 const input={request:{intentBytes:encodeIntent(intent),proof:'OutProofV2'+'1'.repeat(132),receiptEvidence:{explicitFixture:true}},observation:{fromChain:'monero',toChain:'ergo',fromAddress:intent.vault_address,toAddress:intent.to_address,amount:'1000',bridgeFee:'100',networkFee:'20',sourceChainTokenId:'XMR',targetChainTokenId:deployment.tokens.Asset,sourceTxId:txid,sourceBlockId:block,height:10},redemptionTerms:{toAddress:'explicit-adapter-test-no-monero-payout',bridgeFee:'100',networkFee:'20',moneroTokenId:'XMR'}};
 return {context,providers,input,intent,calls:()=>calls};
}
test('synthetic source, actual node: lost credit submission reply reconciles retained bytes after reopen',async()=>{
 const fixture=syntheticSource(),directory=fs.mkdtempSync(path.join(parent,'recovery-'));
 let injected=false,points=[];
 let owner=await openDepositCredit({directory,context:fixture.context,providers:fixture.providers,leaseMs:1000,fault:async point=>{points.push(point);if(point==='credit:submitted'&&!injected){injected=true;throw Error('deliberate lost reply');}}});
 const first=await owner.run(fixture.input);await owner.close();assert.equal(first.admission.evidenceMode,'fixture',JSON.stringify(first));assert.equal(first.delivery.status,'retry');assert(injected,JSON.stringify(points));
 let journal=new DatabaseSync(path.join(directory,'execution.sqlite'));const before=journal.prepare("SELECT txid,signedHex FROM stages WHERE id LIKE '%:credit'").get();assert(before);assert.equal(journal.prepare('SELECT COUNT(*) AS n FROM stages').get().n,2);journal.close();
 await new Promise(resolve=>setTimeout(resolve,1100));const calls=fixture.calls();
 owner=await openDepositCredit({directory,context:fixture.context,providers:fixture.providers});
 const recovered=await owner.run(fixture.input);assert.equal(recovered.delivery.status,'delivered');assert.equal(fixture.calls(),calls,'Committed retry must reuse accepted source decision');
 const duplicate=await owner.run(fixture.input);assert.equal(duplicate.delivery.status,'delivered');assert.deepEqual(duplicate.result,recovered.result);await owner.close();
 journal=new DatabaseSync(path.join(directory,'execution.sqlite'));const after=journal.prepare("SELECT txid,signedHex FROM stages WHERE id LIKE '%:credit'").get();assert.deepEqual(after,before);assert.equal(journal.prepare('SELECT COUNT(*) AS n FROM stages').get().n,4);journal.close();
 const actual=await rpc('/blockchain/transaction/byId/'+recovered.result.redemptionTxId);assert(actual.numConfirmations>0);assert.equal(actual.inputs[0].boxId,recovered.result.creditBoxId);
 const receipt=JSON.parse(fs.readFileSync(path.join(directory,recovered.result.receiptName)));
 assert.equal(receipt.withdrawalSource.event.sourceTxId,actual.id);assert.equal(receipt.withdrawalSource.event.sourceBlockId,actual.blockId);assert.equal(receipt.withdrawalSource.event.sourceChainHeight,actual.inclusionHeight);assert.equal(receipt.withdrawalSource.event.WIDsCount,1);assert.equal(receipt.withdrawalSource.wids.length,1);
 assert.deepEqual(recovered.receipt.withdrawalSource,receipt.withdrawalSource);
 const changedTxid=crypto.randomBytes(32).toString('hex');const nextContext=structuredClone(fixture.context);nextContext.id+='-conflict';nextContext.snapshot.txid=changedTxid;nextContext.snapshot.id+='-conflict';
 const changedIntent={...fixture.intent,txid:changedTxid};const changedInput=structuredClone(fixture.input);changedInput.request.intentBytes=encodeIntent(changedIntent);changedInput.observation.sourceTxId=changedTxid;
 const nextOwner=await openDepositCredit({directory,context:nextContext,providers:fixture.providers});const conflict=await nextOwner.run(changedInput);await nextOwner.close();assert.equal(conflict.admission.status,'conflict');
 const sourceDb=new DatabaseSync(path.join(directory,'deposits.sqlite'));assert.equal(sourceDb.prepare('SELECT COUNT(*) AS n FROM monero_deposit_decision').get().n,1);assert.equal(sourceDb.prepare('SELECT COUNT(*) AS n FROM monero_deposit_output').get().n,1);sourceDb.close();
 fs.writeFileSync(path.join(directory,'test-summary.json'),JSON.stringify({scope:'synthetic source providers; actual node recovery only',pass:true,sourceVerifierCalls:calls,retainedCreditTxId:before.txid,redemptionTxId:actual.id,sourceAuthority:'fixture-local-operator'},null,2));
});
