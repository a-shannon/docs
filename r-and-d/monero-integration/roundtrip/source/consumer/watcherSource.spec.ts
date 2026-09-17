import {config} from '../tools/config.mjs';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {LocalMonero} from './localMonero';
import {openParticipantVault} from './participantSigning.mjs';
import {buildDepositSource} from './depositSource';
import {makeIndependentDepositProviders,independentlyDecideDeposit,independentlyVerifyDeposit} from './independentDepositSource.mjs';
import {setupAuthorityFixture,stateContext} from '../ergo-node/authority-fixture.mjs';
import {createWatcherTransport} from '../ergo-node/watcher-runtime.mjs';
import {rpc,confirmed} from '../ergo-node/rosen-node.mjs';
import {openAuthorizedCredit,creditObservation} from '../ergo-node/authorized-credit.mjs';
import {openRpcTimingProxy} from './rpcTiming.mjs';

let node:LocalMonero|undefined,vault:any,transport:any,credit:any,timing:any;
afterEach(async()=>{try{await credit?.close();transport?.close();await vault?.close();}finally{await timing?.close();await node?.stop();delete process.env.MONERO_LOCAL_RPC_PORT;}});
it('independently scans a real deposit and consumes two actual watcher commitments into a confirmed trigger',async()=>{
  const deployment=await setupAuthorityFixture(),directory=mkdtempSync(join(config.runtimeDirectory,'source-watchers-'));
  node=await LocalMonero.start(config.runtimeDirectory);
  timing=await openRpcTimingProxy({targetPort:node.port,onEvent:(event:any)=>{if(event.method==='generateblocks'||event.errorCategory)console.log(JSON.stringify({stage:'native-rpc',...event}));}});
  process.env.MONERO_LOCAL_RPC_PORT=String(timing.port);
  console.log('Four-holder ceremony and deposit funding starting');
  vault=await openParticipantVault({binary:config.nativeBinary,sha256:config.nativeSha256,runtime:config.runtimeDirectory,mode:'deposit'});
  const source=await buildDepositSource(vault,node,config.runtimeDirectory,config.ergoRecipient,deployment.tokens.Asset);
  const opts={binary:config.observerBinary,sha256:config.observerSha256,runtimeDirectory:config.runtimeDirectory};
  const observers=[0,1].map(i=>makeIndependentDepositProviders({...opts,source,observerId:'watcher-'+i}));
  const observe=async(i:number,rawRequest:any)=>{
    const candidate=await independentlyDecideDeposit({source,rawRequest,providers:observers[i].providers});
    if(candidate.status!=='accepted')throw Error('Independent watcher source '+candidate.status+':'+candidate.reason);
    return creditObservation(candidate,source);
  };
  console.log('Funded actual Monero deposit; independent watcher scans starting');
  transport=await createWatcherTransport({directory,deployment,nodePort:{rpc,confirmed,getStateContext:stateContext},observe,dependencyRoot:config.rosenRoot});
  const receipt=await transport.publish(source.request);
  expect(receipt.commitments.length).toBe(2);expect(new Set(receipt.commitments.map((c:any)=>c.WID)).size).toBe(2);
  expect(receipt.transaction.inputs.slice(0,2).map((i:any)=>i.boxId)).toEqual(receipt.commitments.map((c:any)=>c.boxId));
  expect(receipt.transaction.numConfirmations).toBeGreaterThan(0);expect(observers.map(o=>o.stats().receiptCalls)).toEqual([1,1]);
  const nonces=observers.flatMap(o=>o.receipts().map((r:any)=>r.observerNonce));expect(new Set(nonces).size).toBe(2);
  for(const observer of observers){expect(observer.receipts()[0].imageAssociationVerified).toBe(false);expect(observer.receipts()[0].outputs[0].historyOccurrences).toBe(1);}
  transport.close();transport=await createWatcherTransport({directory,deployment,nodePort:{rpc,confirmed,getStateContext:stateContext},observe,dependencyRoot:config.rosenRoot});
  const replay=await transport.publish(source.request);expect(replay.transaction.id).toBe(receipt.transaction.id);
  console.log('Two actual watcher commitments revealed; four-guard credit verification starting');
  credit=await openAuthorizedCredit({directory:join(directory,'credit'),source,rawRequest:source.request,watcherReceipt:receipt,deployment});
  const authorized=await credit.run();expect(authorized.transaction.numConfirmations).toBeGreaterThan(0);
  expect(authorized.counts.completedGuards).toBe(4);expect(authorized.checkpoints.map((c:any)=>c.outputs)).toEqual([1,1,1,1]);
  expect(authorized.status).toBe('confirmed');expect(authorized.sourceReceipts.map((r:any)=>r.length)).toEqual([2,2,2,2]);
  console.log(JSON.stringify({stage:'actual-guard-credit',txId:authorized.txId,counts:authorized.counts}));
  await credit.close();credit=undefined;
  const negatives=[];
  for(const field of ['amountAtomic','outputKey','blockHash']){
    const altered=structuredClone(source.publicScan);altered.source.deposit[field]=field==='amountAtomic'?'500000241':'fe'.repeat(32);
    await expect(independentlyVerifyDeposit({...opts,publicScan:altered,observerId:'negative-'+field})).rejects.toThrow();negatives.push(field);
  }
  writeFileSync(join(directory,'public-result.json'),JSON.stringify({scope:'actual-deposit-independent-processes-and-watcher-commitment-spends',deposit:source.deposit,
    watcherReceipt:receipt,authorizedCredit:authorized,sourceReceipts:observers.map(o=>o.receipts()),replayTransactionId:replay.transaction.id,negativeNativeReads:negatives},null,2),{flag:'wx'});
  console.log(JSON.stringify({scope:'source-watcher-checkpoint',directory,trigger:receipt.trigger.boxId,transactionId:receipt.transaction.id,commitments:2,negativeNativeReads:negatives.length}));
});
