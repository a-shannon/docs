import {mkdtempSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {config,sourceURL} from '../tools/config.mjs';
import {LocalMonero} from './localMonero';
import {openParticipantVault} from './participantSigning.mjs';
import {buildDepositSource} from './depositSource';
import {makeIndependentDepositProviders,independentlyDecideDeposit} from './independentDepositSource.mjs';
import {encodeDepositMemo,extractDepositMemo,encodeDepositEnvelope,loadDepositEnvelope} from './depositDelivery.mjs';
import {decodeIntent,encodeIntent} from '../packages/monero-deposit/lib/intentCodec';
import {setupAuthorityFixture,stateContext} from '../ergo-node/authority-fixture.mjs';
import {createWatcherTransport} from '../ergo-node/watcher-runtime.mjs';
import {rpc,confirmed} from '../ergo-node/rosen-node.mjs';
import {openAuthorizedCredit,creditObservation} from '../ergo-node/authorized-credit.mjs';
import {captureBackingClaim} from './backingClaim.mjs';
import {MoneroCreditAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';

let node:LocalMonero|undefined,vault:any,transport:any,credit:any;
afterEach(async()=>{try{await credit?.close();transport?.close();await vault?.close();}finally{await node?.stop();delete process.env.MONERO_LOCAL_RPC_PORT;}});
it('discovers an on-transaction memo, recovers delivered proof and independently credits its exact output',async()=>{
  const directory=mkdtempSync(join(config.runtimeDirectory,'deposit-delivery-')),inbox=join(directory,'proofs');mkdirSync(inbox);
  const deployment=await setupAuthorityFixture();node=await LocalMonero.start(config.runtimeDirectory);
  process.env.MONERO_LOCAL_RPC_PORT=String(node.port);
  const start=(await node.isolated()).height,genesis=(await node.rpc('get_block_header_by_height',{height:0})).block_header.hash;
  let depositData='';
  vault=await openParticipantVault({binary:config.nativeBinary,sha256:config.nativeSha256,runtime:config.runtimeDirectory,mode:'deposit',
    depositData:(vaultSpend:string)=>{depositData=encodeDepositMemo({genesis,vaultSpend,sourceNetwork:'mainnet',destinationNetwork:'ergo-testnet',vaultEpoch:'1',
      destinationAsset:deployment.tokens.Asset,amount:'500000240',bridgeFee:'100',networkFee:'20',expiryHeight:String(start+1000),recipient:config.ergoRecipient}).toString('hex');return depositData;}});
  const source=await buildDepositSource(vault,node,config.runtimeDirectory,config.ergoRecipient,deployment.tokens.Asset,{sourcePolicy:'authenticated-backing-v1',depositData});
  const end=(await node.isolated()).height,options={binary:config.observerBinary,sha256:config.observerSha256,runtimeDirectory:config.runtimeDirectory};
  // Each discovery pass starts from chain blocks, not a sender's transaction ID.
  // Both passes use one isolated daemon; this is not independent-node consensus.
  async function discover(){
    const found=[];
    for(let height=start;height<end;height++){
      const block=await node!.rpc('get_block',{height});
      for(const txId of block.tx_hashes??[]){
        const response=await node!.transaction(txId);expect(response.txs).toHaveLength(1);
        const row=response.txs[0];expect(row.in_pool).toBe(false);expect(row.block_height).toBe(height);
        const memo=await extractDepositMemo({...options,txId,txBytes:row.as_hex});
        if(memo)found.push({txId,memo,txBytes:row.as_hex});
      }
    }
    return found;
  }
  const discoveries=await Promise.all([discover(),discover()]);expect(discoveries[0]).toEqual(discoveries[1]);expect(discoveries[0]).toHaveLength(1);
  const {txId,memo}=discoveries[0][0];expect(txId).toBe(source.deposit.txId);
  const context={genesis,vaultSpend:vault.groupKey},proofFile=join(inbox,txId+'.proof');
  const load=()=>loadDepositEnvelope(inbox,txId,memo,context);
  await expect(load()).rejects.toThrow('ENOENT');
  const valid=encodeDepositEnvelope(source.request);writeFileSync(proofFile,valid,{flag:'wx'});
  const first=await load();
  const reloadProgram="const [modulePath,directory,txid,memo,context]=process.argv.slice(1); const m=await import(modulePath); const request=await m.loadDepositEnvelope(directory,txid,JSON.parse(memo),JSON.parse(context)); process.stdout.write(m.encodeDepositEnvelope(request).toString('hex'));";
  const restarted=execFileSync(process.execPath,['--import',sourceURL('ergo-node/deposit-register.mjs'),'--input-type','module','-e',reloadProgram,
    sourceURL('consumer/depositDelivery.mjs'),inbox,txId,JSON.stringify(memo),JSON.stringify(context)],{env:{...process.env,NODE_OPTIONS:''},windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:150000});
  expect(restarted).toBe(valid.toString('hex'));
  const readers=[0,1].map(i=>makeIndependentDepositProviders({...options,source,observerId:'delivery-watcher-'+i}));
  const observe=async(i:number,raw:any)=>{
    const discovered=await discover();expect(discovered).toHaveLength(1);
    const own=discovered[0];expect(raw).toEqual({txId:own.txId});
    expect(own.txBytes).toBe(source.deposit.txBytes);
    const supplied=await loadDepositEnvelope(inbox,own.txId,own.memo,context);
    const candidate=await independentlyDecideDeposit({source,rawRequest:supplied,providers:readers[i].providers});
    if(candidate.status!=='accepted')throw Error('Delivery watcher '+candidate.reason);
    return creditObservation(candidate,source);
  };
  const changed=encodeDepositEnvelope({...source.request,intentBytes:encodeIntent({...decodeIntent(source.request.intentBytes),to_address:'changed-destination'})});
  writeFileSync(proofFile,changed);await expect(observe(0,{txId})).rejects.toThrow('Memo intent to_address');
  expect(readers[0].stats().receiptCalls).toBe(0);writeFileSync(proofFile,valid);
  transport=await createWatcherTransport({directory:join(directory,'watchers'),deployment,nodePort:{rpc,confirmed,getStateContext:stateContext},observe,dependencyRoot:config.rosenRoot});
  const receipt=await transport.publish({txId});expect(receipt.watcherObservations[0]).toEqual(receipt.watcherObservations[1]);
  expect(readers.map(r=>r.stats().receiptCalls)).toEqual([1,1]);
  expect(new Set(readers.flatMap(r=>r.receipts().map((r:any)=>r.observerNonce))).size).toBe(2);
  console.log(JSON.stringify({stage:'delivery-two-readers',memoBytes:depositData.length/2,txId,trigger:receipt.trigger.boxId}));
  // Retained watcher evidence alone is insufficient: guards reload the delivery.
  for(const mode of ['missing','destination','proof']){
    if(mode==='missing')renameSync(proofFile,proofFile+'.withheld');
    else writeFileSync(proofFile,mode==='destination'?changed:encodeDepositEnvelope({...source.request,proof:'OutProofV2'+'1'.repeat(132)}));
    credit=await openAuthorizedCredit({directory:join(directory,'refused-'+mode),source,rawRequest:first,watcherReceipt:receipt,deployment,loadRequest:load});
    try{await expect(credit.run()).rejects.toThrow();expect(credit.counts.guardCommitments).toEqual([0,0,0,0]);expect(credit.counts.guardPartialSigns).toEqual([0,0,0,0]);
      if(mode==='proof'){expect(credit.readers.reduce((sum:number,r:any)=>sum+r.stats().proofCalls,0)).toBeGreaterThan(0);expect(credit.readers.every((r:any)=>r.stats().receiptCalls===0)).toBe(true);}}
    finally{await credit.close();credit=undefined;if(mode==='missing')renameSync(proofFile+'.withheld',proofFile);else writeFileSync(proofFile,valid);}
  }
  const creditDirectory=join(directory,'credit');
  credit=await openAuthorizedCredit({directory:creditDirectory,source,rawRequest:first,watcherReceipt:receipt,deployment,loadRequest:load});
  const authorized=await credit.run();expect(authorized.status).toBe('confirmed');expect(authorized.transaction.numConfirmations).toBeGreaterThan(0);
  const assignment=captureBackingClaim(credit.backingClaim()).request;
  expect(authorized.checkpoints.map((r:any)=>r.outputs)).toEqual([1,1,1,1]);
  await credit.close();credit=undefined;
  // Reopen actual persisted guard ledgers. A second obligation using the same
  // verified backing must conflict; this is a ledger-boundary refusal probe.
  for(let i=0;i<4;i++){
    const ledger=MoneroCreditAssignment.open(join(creditDirectory,'guards','guard-'+i+'.sqlite'),authorized.committee[i]);
    try{expect(ledger.assign({...assignment,binding:{...assignment.binding,obligationId:'duplicate-delivery'}}).status).toBe('conflict');expect(ledger.checkpoint().outputs).toBe(1);}
    finally{ledger.close();}
  }
  credit=await openAuthorizedCredit({directory:creditDirectory,source,rawRequest:await load(),watcherReceipt:receipt,deployment,loadRequest:load});
  const replay=await credit.run();expect(replay.txId).toBe(authorized.txId);expect(credit.counts.guardCommitments).toEqual([0,0,0,0]);
  writeFileSync(join(directory,'result.json'),JSON.stringify({scope:'local-on-transaction-memo-and-file-delivery',memoBytes:depositData.length/2,txId,
    readerCount:2,daemonCount:1,triggerTxId:receipt.transaction.id,creditTxId:authorized.txId,replayedCreditTxId:replay.txId,
    refusals:['missing-delivery','changed-destination','invalid-proof','already-assigned-output'],ledgerOutputs:replay.checkpoints.map((c:any)=>c.outputs)},null,2),{flag:'wx'});
  console.log(JSON.stringify({stage:'delivery-confirmed',txId,credit:authorized.txId,memoBytes:depositData.length/2,guardRefusals:3,ledgerConflicts:4}));
});
