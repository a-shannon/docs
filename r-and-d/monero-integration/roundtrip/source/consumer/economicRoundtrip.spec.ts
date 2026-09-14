import {config,rosenURL} from '../tools/config.mjs';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {LocalMonero} from './localMonero';
import {openParticipantVault} from './participantSigning.mjs';
import {buildDepositSource} from './depositSource';
import {makeIndependentDepositProviders,independentlyDecideDeposit} from './independentDepositSource.mjs';
import {setupAuthorityFixture,stateContext} from '../ergo-node/authority-fixture.mjs';
import {createWatcherTransport} from '../ergo-node/watcher-runtime.mjs';
import {rpc,confirmed,tree} from '../ergo-node/rosen-node.mjs';
import {openAuthorizedCredit,creditObservation} from '../ergo-node/authorized-credit.mjs';
import {redeemAuthorizedCredit,observeRedemption} from '../ergo-node/authority-return.mjs';
import {openRpcTimingProxy} from './rpcTiming.mjs';
import {settleAuthorityReturn} from './authorityRoundtrip';
import {recipient} from './projectionFixture';
import {reconcileEconomicOperations} from './economicReconciliation.mjs';

let node:LocalMonero|undefined,timing:any,transport:any;
const held:any[]=[];
afterEach(async()=>{
  const closers=[()=>transport?.close(),...held.map(operation=>async()=>{
    try{await operation.credit?.close();}finally{await operation.vault?.close();}
  })];
  const closed=await Promise.allSettled(closers.map(close=>Promise.resolve().then(close)));
  const stopped=await Promise.allSettled([timing?.close(),node?.stop()]);delete process.env.MONERO_LOCAL_RPC_PORT;
  const errors=[...closed,...stopped].filter(result=>result.status==='rejected').map(result=>result.reason);
  if(errors.length)throw new AggregateError(errors,'Economic fixture cleanup');
});

it('reconciles two independently backed operations through overlapping liabilities, reservations and confirmed payouts',async()=>{
  if(config.collisionExperiment!==undefined)throw Error('Economic profile excludes collision experiments');
  const directory=mkdtempSync(join(config.runtimeDirectory,'economic-roundtrip-'));
  node=await LocalMonero.start(config.runtimeDirectory);
  timing=await openRpcTimingProxy({targetPort:node.port});
  process.env.MONERO_LOCAL_RPC_PORT=String(timing.port);
  const operations:any[]=[],checkpoints:any[]=[],evidence:any[]=[];
  function checkpoint(stage:string){
    const report=reconcileEconomicOperations(operations);
    checkpoints.push({stage,report});
    console.log(JSON.stringify({stage:'economic-checkpoint',checkpoint:stage,totals:report.totals}));
    return report;
  }
  async function creditDeposit(index:number){
    const deployment=await setupAuthorityFixture(),ownDirectory=join(directory,'operation-'+index);
    mkdirSync(ownDirectory);
    const operation:any={directory:ownDirectory,deployment};held.push(operation);
    operation.vault=await openParticipantVault({binary:config.nativeBinary,sha256:config.nativeSha256,runtime:config.runtimeDirectory,mode:'deposit'});
    const source=await buildDepositSource(operation.vault,node!,config.runtimeDirectory,config.ergoRecipient,deployment.tokens.Asset,{sourcePolicy:'authenticated-backing-v1'});
    operation.source=source;
    const decision=source.decision,d=source.deposit;
    expect(decision.retainedAtomicRemainder).toBe(0n);expect(decision.destinationAmount).toBe(decision.netAmount);
    const facts:any={operationId:decision.depositId,genesis:operation.vault.genesis,vaultSpend:operation.vault.groupKey,assetId:deployment.tokens.Asset,
      deposit:{txId:d.txId,outputIndex:d.outputIndex,publicKey:d.outputKey,amountAtomic:d.amountAtomic},credit:null,redemption:null,withdrawal:null};
    operations.push(facts);operation.facts=facts;checkpoint('deposit-'+index);
    const readers=[0,1].map(i=>makeIndependentDepositProviders({source,binary:config.observerBinary,sha256:config.observerSha256,
      runtimeDirectory:config.runtimeDirectory,observerId:'economic-'+index+'-watcher-'+i}));
    transport=await createWatcherTransport({directory:join(ownDirectory,'deposit-watchers'),deployment,nodePort:{rpc,confirmed,getStateContext:stateContext},
      dependencyRoot:config.rosenRoot,observe:async(i:number,rawRequest:any)=>creditObservation(await independentlyDecideDeposit({source,rawRequest,providers:readers[i].providers}))});
    const deposited=await transport.publish(source.request);expect(deposited.commitments).toHaveLength(2);
    transport.close();transport=undefined;
    const open=()=>openAuthorizedCredit({directory:join(ownDirectory,'credit'),source,rawRequest:source.request,watcherReceipt:deposited,deployment});
    operation.credit=await open();const authorized=await operation.credit.run();expect(authorized.status).toBe('confirmed');
    expect(authorized.checkpoints.map((row:any)=>row.outputs)).toEqual([1,1,1,1]);
    await operation.credit.close();operation.credit=await open();const replay=await operation.credit.run();
    expect(replay.txId).toBe(authorized.txId);expect(operation.credit.counts.guardCommitments).toEqual([0,0,0,0]);
    const actual=await rpc('/blockchain/transaction/byId/'+authorized.txId);expect(actual.numConfirmations).toBeGreaterThan(0);
    const token=(box:any)=>box.assets.filter((asset:any)=>asset.tokenId===deployment.tokens.Asset);
    const userBoxes=actual.outputs.filter((box:any)=>box.ergoTree===tree(config.ergoRecipient)&&token(box).length===1);
    const feeBoxes=actual.outputs.filter((box:any)=>box.ergoTree===tree(deployment.fundingAddress)&&token(box).length===1);
    expect(userBoxes).toHaveLength(1);expect(feeBoxes).toHaveLength(1);
    const user=userBoxes[0],fee=feeBoxes[0];
    expect(user.boxId).not.toBe(fee.boxId);
    expect(BigInt(token(user)[0].amount)).toBe(decision.destinationAmount);
    expect(BigInt(token(fee)[0].amount)).toBe(decision.bridgeFee+decision.networkFee);
    facts.credit={txId:authorized.txId,boxId:user.boxId,depositId:decision.depositId,recipientAtomic:String(token(user)[0].amount),
      bridgeFeeAtomic:String(decision.bridgeFee),networkFeeAtomic:String(decision.networkFee),issuedFeeTokenAtomic:String(token(fee)[0].amount)};
    operation.authorized=authorized;
    evidence.push({operationId:decision.depositId,deposit:d,depositIntentHash:decision.intentHash,depositWatchers:deposited,
      authorizedCredit:authorized,creditReplay:{txId:replay.txId,counts:operation.credit.counts},issuedDepositFeeBoxId:fee.boxId});
    checkpoint('credit-'+index);return operation;
  }
  async function redeem(operation:any,index:number){
    const terms={toAddress:recipient,bridgeFee:'100',networkFee:'20',moneroTokenId:'XMR'};
    const redemption=await redeemAuthorizedCredit({directory:join(operation.directory,'redemption'),authorized:operation.authorized,deployment:operation.deployment,terms});
    const observed=redemption.observation;
    operation.facts.redemption={txId:redemption.txId,creditTxId:redemption.creditTransactionId,creditBoxId:redemption.consumedCreditBoxId,
      amountAtomic:observed.amount,bridgeFeeAtomic:observed.bridgeFee,networkFeeAtomic:observed.networkFee};
    expect(observed.amount).toBe(operation.facts.credit.recipientAtomic);
    const deployment=await setupAuthorityFixture(),reads=[0,0];
    transport=await createWatcherTransport({directory:join(operation.directory,'return-watchers'),deployment,nodePort:{rpc,confirmed,getStateContext:stateContext},
      dependencyRoot:config.rosenRoot,observe:async(i:number,raw:any)=>{reads[i]++;return observeRedemption({receipt:raw,deployment,terms});}});
    const returned=await transport.publish(redemption);expect(reads).toEqual([1,1]);expect(returned.commitments).toHaveLength(2);
    transport.close();transport=undefined;
    Object.assign(operation,{redemption,returned,terms});Object.assign(evidence[index],{redemption,returnWatchers:returned,returnReads:reads});
    checkpoint('redemption-'+index);
  }
  async function settle(operation:any,index:number){
    let accountingCalls=0;
    const withdrawal=await settleAuthorityReturn({node,vault:operation.vault,source:operation.source,backingClaim:operation.credit.backingClaim(),
      returnReceipt:operation.returned,redemption:operation.redemption,returnTerms:operation.terms,directory:operation.directory,deployment:operation.deployment,
      onAccounting:async(accounting:any)=>{
        accountingCalls++;expect(accountingCalls).toBeLessThanOrEqual(2);
        if(accountingCalls===1)expect(accounting.settlement).toBeNull();else expect(accounting.settlement).not.toBeNull();
        operation.facts.withdrawal=accounting;
        const current=checkpoint((accounting.settlement?'settled-':'reserved-')+index),row=current.operations[index],settled=accountingCalls===2;
        expect(row.state).toBe(settled?'settled':'reserved');
        expect(row.pendingPayoutAtomic).toBe(settled?'0':accounting.recipientAtomic);
        expect(row.pendingMinerFeeAtomic).toBe(settled?'0':accounting.minerFeeAtomic);
        expect(row.paidRecipientAtomic).toBe(settled?accounting.recipientAtomic:'0');
        expect(row.paidMinerFeeAtomic).toBe(settled?accounting.minerFeeAtomic:'0');
      }});
    expect(accountingCalls).toBe(2);
    expect(withdrawal.controls.signCalls).toBe(1);expect(withdrawal.controls.submissions).toBe(1);expect(withdrawal.controls.settlement).toBe('settled');
    expect(withdrawal.controls.sourceOutputSpent).toBe(true);expect(withdrawal.controls.lostSubmissionReplyRecovered).toBe(true);
    const replay=await operation.credit.run();expect(replay.txId).toBe(operation.authorized.txId);expect(replay.status).toBe('confirmed');
    expect(operation.credit.counts.guardCommitments).toEqual([0,0,0,0]);
    evidence[index].withdrawal=withdrawal;
  }

  // Redeeming A recycles fixture tokens before B's credit. Both Monero payment
  // obligations coexist before either is settled; no larger token mint is needed.
  const first=await creditDeposit(0);await redeem(first,0);
  const second=await creditDeposit(1);
  const overlap=checkpoint('two-open-obligations');
  expect(overlap.totals.outstandingUserAtomic).toBe('500000120');
  expect(overlap.totals.pendingPayoutAtomic).toBe('500000000');
  expect(overlap.totals.issuedDepositFeeTokenAtomic).toBe('240');
  expect(overlap.totals.retainedReturnFeeAtomic).toBe('120');
  const secondBefore=structuredClone(second.facts);
  await settle(first,0);
  expect(second.facts).toEqual(secondBefore);
  const intermediate=checkpoint('first-settled-second-credited');
  expect(intermediate.totals.settledCount).toBe(1);expect(intermediate.totals.outstandingUserAtomic).toBe('500000120');
  expect(intermediate.totals.pendingPayoutAtomic).toBe('0');
  expect((await rpc('/utxo/byId/'+second.facts.credit.boxId)).boxId).toBe(second.facts.credit.boxId);
  expect((await node!.call('/is_key_image_spent',{key_images:[second.source.observation.keyImage]})).spent_status).toEqual([0]);
  await redeem(second,1);await settle(second,1);
  const report=checkpoint('both-settled');expect(report.totals.operationCount).toBe(2);expect(report.totals.settledCount).toBe(2);
  expect(report.totals.depositAtomic).toBe('1000000480');expect(report.totals.paidRecipientAtomic).toBe('1000000000');
  expect(report.totals.outstandingUserAtomic).toBe('0');expect(report.totals.pendingPayoutAtomic).toBe('0');
  expect(report.totals.issuedDepositFeeTokenAtomic).toBe('240');expect(report.totals.retainedReturnFeeAtomic).toBe('240');
  expect(report.totals.feeBackingRequirementAtomic).toBe('480');expect(report.totals.chargedNetworkFeeAtomic).toBe('80');
  expect(BigInt(report.totals.selectedResidualAtomic)).toBe(BigInt(report.totals.selectedReserveAtomic)-BigInt(report.totals.paidMinerFeeAtomic));
  expect((await node!.call('/is_key_image_spent',{key_images:held.map(operation=>operation.source.observation.keyImage)})).spent_status).toEqual([1,1]);
  for(const item of evidence){const tx=await node!.transaction(item.withdrawal.finalTxId);expect(tx.txs[0].in_pool).toBe(false);}
  const {ErgoChain}=await import(rosenURL('packages/chains/ergo/dist/index.js'));
  const transactionFees:any[]=[],seenFees=new Set<string>();let ergoFeeTotal=0n,donorFeeTotal=0n;
  for(const item of evidence){
    const transactions=[...item.depositWatchers.commitmentTransactions,item.depositWatchers.transaction,item.authorizedCredit.transaction,
      item.redemption.transaction,...item.returnWatchers.commitmentTransactions,item.returnWatchers.transaction];
    expect(transactions).toHaveLength(8);
    for(const tx of transactions){
      expect(seenFees.has(tx.id)).toBe(false);seenFees.add(tx.id);
      const actual=await rpc('/blockchain/transaction/byId/'+tx.id);expect(actual.numConfirmations).toBeGreaterThan(0);
      const feeOutputs=actual.outputs.filter((box:any)=>box.ergoTree===ErgoChain.feeBoxErgoTree);
      expect(feeOutputs).toHaveLength(1);expect(feeOutputs[0].assets).toEqual([]);
      const fee=BigInt(feeOutputs[0].value);expect(fee).toBeGreaterThan(0n);ergoFeeTotal+=fee;
      transactionFees.push({operationId:item.operationId,txId:tx.id,feeBoxId:feeOutputs[0].boxId,feeNanoErg:String(fee)});
    }
    // Sender's deposit fee is outside the vault's deposited principal.
    donorFeeTotal+=BigInt(item.deposit.feeAtomic);
  }
  const chainCosts={ergoTransactionFees:transactionFees,ergoMinerFeeNanoErg:String(ergoFeeTotal),
    donorMoneroMinerFeeAtomic:String(donorFeeTotal),withdrawalMoneroMinerFeeAtomic:report.totals.paidMinerFeeAtomic,
    scope:'deposit-and-return-operations-excluding-fixture-setup-and-mining'};
  expect(checkpoints.map(row=>row.stage)).toEqual(['deposit-0','credit-0','redemption-0','deposit-1','credit-1',
    'two-open-obligations','reserved-0','settled-0','first-settled-second-credited','redemption-1','reserved-1','settled-1','both-settled']);
  writeFileSync(join(directory,'public-result.json'),JSON.stringify({scope:'local-two-operation-selected-input-reconciliation',operations,checkpoints,report,chainCosts,evidence},null,2),{flag:'wx'});
});
