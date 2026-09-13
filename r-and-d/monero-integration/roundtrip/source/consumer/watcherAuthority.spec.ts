import {config} from '../tools/config.mjs';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {LocalMonero} from './localMonero';
import {openParticipantVault} from './participantSigning.mjs';
import {buildDepositSource} from './depositSource';
import {makeIndependentDepositProviders,independentlyDecideDeposit} from './independentDepositSource.mjs';
import {setupAuthorityFixture,stateContext} from '../ergo-node/authority-fixture.mjs';
import {createWatcherTransport} from '../ergo-node/watcher-runtime.mjs';
import {rpc,confirmed} from '../ergo-node/rosen-node.mjs';
import {openAuthorizedCredit,creditObservation} from '../ergo-node/authorized-credit.mjs';
import {redeemAuthorizedCredit,observeRedemption} from '../ergo-node/authority-return.mjs';
import {openRpcTimingProxy} from './rpcTiming.mjs';
import {settleAuthorityReturn} from './authorityRoundtrip';
import {recipient} from './projectionFixture';

let node:LocalMonero|undefined,vault:any,transport:any,credit:any,timing:any;
afterEach(async()=>{try{await credit?.close();transport?.close();await vault?.close();}finally{await timing?.close();await node?.stop();delete process.env.MONERO_LOCAL_RPC_PORT;}});
it('settles an actual two-direction watcher roundtrip with four guarded credit assignments and retained recovery',async()=>{
  const deployment=await setupAuthorityFixture(),directory=mkdtempSync(join(config.runtimeDirectory,'watcher-roundtrip-'));
  node=await LocalMonero.start(config.runtimeDirectory);
  timing=await openRpcTimingProxy({targetPort:node.port,onEvent:(event:any)=>{if(event.method==='generateblocks'||event.errorCategory)console.log(JSON.stringify({stage:'native-rpc',...event}));}});
  process.env.MONERO_LOCAL_RPC_PORT=String(timing.port);
  vault=await openParticipantVault({binary:config.nativeBinary,sha256:config.nativeSha256,runtime:config.runtimeDirectory,mode:'deposit'});
  const source=await buildDepositSource(vault,node,config.runtimeDirectory,config.ergoRecipient,deployment.tokens.Asset);
  const opts={binary:config.observerBinary,sha256:config.observerSha256,runtimeDirectory:config.runtimeDirectory};
  const readers=[0,1].map(i=>makeIndependentDepositProviders({...opts,source,observerId:'watcher-'+i}));
  transport=await createWatcherTransport({directory:join(directory,'deposit-watchers'),deployment,nodePort:{rpc,confirmed,getStateContext:stateContext},
    observe:async(index:number,rawRequest:any)=>creditObservation(await independentlyDecideDeposit({source,rawRequest,providers:readers[index].providers})),dependencyRoot:config.rosenRoot});
  const deposited=await transport.publish(source.request);expect(deposited.commitments.length).toBe(2);
  transport.close();transport=undefined;
  const open=()=>openAuthorizedCredit({directory:join(directory,'credit'),source,rawRequest:source.request,watcherReceipt:deposited,deployment});
  credit=await open();const authorized=await credit.run();expect(authorized.status).toBe('confirmed');
  expect(authorized.counts.completedGuards).toBe(4);expect(authorized.counts.guardPartialSigns.reduce((a:number,b:number)=>a+b,0)).toBe(3);
  expect(authorized.checkpoints.map((c:any)=>c.outputs)).toEqual([1,1,1,1]);
  await credit.close();credit=await open();const replay=await credit.run();
  expect(replay.txId).toBe(authorized.txId);expect(credit.counts.guardCommitments).toEqual([0,0,0,0]);
  expect(replay.sourceReceipts.map((r:any)=>r.length)).toEqual([0,0,0,0]);
  console.log(JSON.stringify({stage:'credit-confirmed-and-reopened',txId:authorized.txId}));
  const terms={toAddress:recipient,bridgeFee:'100',networkFee:'20',moneroTokenId:'XMR'};
  const redemption=await redeemAuthorizedCredit({directory:join(directory,'redemption'),authorized,deployment,terms});
  const liveDeployment=await setupAuthorityFixture(),returnReads=[0,0];
  transport=await createWatcherTransport({directory:join(directory,'return-watchers'),deployment:liveDeployment,nodePort:{rpc,confirmed,getStateContext:stateContext},dependencyRoot:config.rosenRoot,
    observe:async(index:number,raw:any)=>{returnReads[index]++;return observeRedemption({receipt:raw,deployment:liveDeployment,terms});}});
  const returned=await transport.publish(redemption);expect(returnReads).toEqual([1,1]);expect(returned.commitments.length).toBe(2);
  expect(returned.transaction.inputs.slice(0,2).map((i:any)=>i.boxId)).toEqual(returned.commitments.map((c:any)=>c.boxId));
  console.log(JSON.stringify({stage:'redemption-and-return-watchers-confirmed',redemption:redemption.txId,trigger:returned.trigger.boxId}));
  const withdrawal=await settleAuthorityReturn({node,vault,source,returnReceipt:returned,redemption,returnTerms:terms,directory,deployment});
  expect(withdrawal.controls.sourceOutputSpent).toBe(true);expect(withdrawal.controls.settlement).toBe('settled');
  const finalCredit=await credit.run();expect(finalCredit.txId).toBe(authorized.txId);expect(finalCredit.status).toBe('confirmed');
  expect(credit.counts.guardCommitments).toEqual([0,0,0,0]);
  // Controlled canonical-history removal after credit and payout. This tests
  // retained liability, not network fork selection or an automatic detector.
  const before=await node.isolated(),header=await node.rpc('get_block_header_by_height',{height:source.deposit.blockHeight});
  expect(header.block_header.hash).toBe(source.deposit.blockHash);
  const popped=await node.call('/pop_blocks',{nblocks:before.height-source.deposit.blockHeight});expect(popped.status).toBe('OK');
  const after=await node.isolated();expect(after.height).toBe(source.deposit.blockHeight);
  await expect(node.rpc('get_block_header_by_height',{height:source.deposit.blockHeight})).rejects.toThrow();
  credit.invalidate('controlled-source-canonical-block-removed');
  const quarantined=await credit.run();expect(quarantined.status).toBe('quarantined');expect(quarantined.txId).toBe(authorized.txId);
  expect(quarantined.checkpoints.map((c:any)=>c.outputs)).toEqual([1,1,1,1]);
  expect(credit.counts.guardCommitments).toEqual([0,0,0,0]);
  const rollback={beforeHeight:before.height,afterHeight:after.height,removedDepositBlock:source.deposit.blockHash,
    creditStatus:quarantined.status,retainedOutputClaims:quarantined.checkpoints.map((c:any)=>c.outputs),newCreditCommitments:credit.counts.guardCommitments};
  writeFileSync(join(directory,'public-result.json'),JSON.stringify({scope:'local-actual-watcher-roundtrip-fixed-four-guard-credit',deposit:source.deposit,
    depositIntentHash:source.decision.intentHash,depositWatchers:deposited,authorizedCredit:authorized,creditReplay:{txId:replay.txId,counts:credit.counts},
    redemption,returnWatchers:returned,returnReads,withdrawal,rollback},null,2),{flag:'wx'});
  console.log(JSON.stringify({stage:'actual-watcher-roundtrip-settled',directory,deposit:source.deposit.txId,credit:authorized.txId,withdrawal:withdrawal.finalTxId}));
});
