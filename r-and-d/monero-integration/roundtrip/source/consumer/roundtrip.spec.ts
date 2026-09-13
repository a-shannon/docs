import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {LocalMonero} from './localMonero';
import {openParticipantVault} from './participantSigning.mjs';
import {buildDepositSource} from './depositSource';
import {launchDistributedNative,MoneroChain} from './adapter';
import {createRoundtripPayment} from './roundtripPayment';
import {terms,recipient as moneroRecipient} from './projectionFixture';
import {configureFixtureTokens} from './fixturePorts';
import {buildUnapprovedMoneroPayout} from '../guard-service/src/withdrawal/moneroWithdrawalOrder';
import {getTxDataHash,verify} from './integration';
import {setupAgreement,state,closeAgreementDatabase} from './agreementPorts';
import {FixtureAgreement,votes} from './agreementFixture';
import {lifecycleState} from './lifecyclePorts';
import ChainHandler from '../guard-service/src/handlers/chainHandler';
import TransactionProcessor from '../guard-service/src/transaction/transactionProcessor';
import EventSerializer from '../guard-service/src/event/eventSerializer';
import {setFixtureChain} from './resolver';

const root=sourceRoot,runtime=config.runtimeDirectory;
const binary=config.nativeBinary,sha256=process.env.PARTICIPANT_SHA256!;
let node:LocalMonero|undefined,vault:any,creditOwner:any;
afterEach(async()=>{try{await creditOwner?.close();await vault?.close();await closeAgreementDatabase();}finally{lifecycleState.database=undefined;
  delete process.env.MONERO_LOCAL_RPC_PORT;await node?.stop();node=undefined;vault=undefined;creditOwner=undefined;}});
it('links a real Monero deposit, actual Rosen Ergo credit and redemption, and separate-holder payout with durable settlement',async()=>{
  node=await LocalMonero.start(runtime);process.env.MONERO_LOCAL_RPC_PORT=String(node.port);
  vault=await openParticipantVault({binary,sha256,runtime,mode:'deposit'});
  const custody=mkdtempSync(join(runtime,'roundtrip-'));
  const deployment=JSON.parse(readFileSync(config.ergoRuntime+'/rosen-deployment.json','utf8'));
  const ergoRecipient=config.ergoRecipient;
  const source=await buildDepositSource(vault,node,runtime,ergoRecipient,deployment.tokens.Asset);
  expect(source.decision.amount).toBe(500000240n);expect(source.decision.destinationAmount).toBe(500000120n);
  console.log('Actual Monero deposit verified');
  const {openDepositCredit}=await import(/* @vite-ignore */ pathToFileURL(root+'/ergo-node/deposit-credit.mjs').href);
  const observation={fromChain:'monero',toChain:'ergo',fromAddress:vault.vaultAddress,toAddress:ergoRecipient,amount:source.decision.amount.toString(),bridgeFee:'100',networkFee:'20',
    sourceChainTokenId:'XMR',targetChainTokenId:deployment.tokens.Asset,sourceTxId:source.deposit.txId,sourceBlockId:source.deposit.blockHash,height:source.deposit.blockHeight};
  const open=()=>openDepositCredit({directory:join(custody,'credit'),context:source.context,providers:source.providers,authorityProfile:'local-operator-v1'});
  creditOwner=await open();
  const creditInput={request:source.request,observation,redemptionTerms:{toAddress:moneroRecipient,bridgeFee:'100',networkFee:'20',moneroTokenId:'XMR'}};
  let credited=await creditOwner.run(creditInput);expect(credited.admission.status).toBe('created');
  const deliveryDeadline=Date.now()+180000;let creditRetries=0;
  while(credited.delivery.status!=='delivered'&&Date.now()<deliveryDeadline){
    expect(['retry','busy']).toContain(credited.delivery.status);await delay(2000);
    credited=await creditOwner.run(creditInput);expect(credited.admission.status).toBe('existing');creditRetries++;
  }
  expect(credited.delivery.status).toBe('delivered');
  const receiptBytes=readFileSync(join(custody,'credit',credited.result.receiptName));
  expect(createHash('sha256').update(receiptBytes).digest('hex')).toBe(credited.result.sha256);const ergo=JSON.parse(receiptBytes.toString('utf8'));
  expect(ergo.redemption.consumedCreditBoxId).toBe(ergo.credit.box.boxId);expect(ergo.redemption.transaction.inputs[0].boxId).toBe(ergo.credit.box.boxId);
  await creditOwner.close();creditOwner=await open();const replay=await creditOwner.run(creditInput);
  expect(replay.admission.status).toBe('existing');expect(replay.delivery.status).toBe('delivered');expect(replay.result).toEqual(credited.result);
  await creditOwner.close();creditOwner=undefined;
  console.log('Actual Ergo credit and exact-box redemption confirmed; duplicate replay retained');
  const extracted=ergo.withdrawalSource,returnTx=ergo.returnTrigger.transaction,returnBox=ergo.returnTrigger.box;
  expect(returnTx.numConfirmations).toBeGreaterThan(0);expect(Number.isSafeInteger(returnTx.inclusionHeight)).toBe(true);
  expect(returnTx.inclusionHeight).toBeGreaterThan(0);expect(returnTx.id).toBe(extracted.triggerTransactionId);
  expect(returnTx.outputs.find((box:any)=>box.boxId===extracted.triggerBoxId)).toEqual(returnBox);
  expect(extracted.event.txId).toBe(returnTx.id);expect(extracted.event.identifier).toBe(returnBox.boxId);
  // The scanner normally adds inclusion height; reuse Rosen's exact entity projection.
  const projectedEvent=EventSerializer.fromEntity({...extracted.event,height:returnTx.inclusionHeight});
  expect(EventSerializer.getId(projectedEvent)).toBe(extracted.event.eventId);
  const data=terms();data.source={...extracted,event:projectedEvent};data.profile.configurationId='local-roundtrip-v1';
  data.profile.tokens[0].ergo.tokenId=deployment.tokens.Asset;data.profile.tokens[0].ergo.name='Local rsXMR';data.profile.maxMinerFeeAtomic='1000000000000';
  await configureFixtureTokens(data.profile.tokens);const chain=await MoneroChain.create(data.profile.tokens);
  setFixtureChain(chain);
  // Adapter lookup precedes approval; requesting the absent lifecycle still fails closed.
  ChainHandler.initializeScoped(new Map([['monero',chain]]),undefined!);
  const request=await buildUnapprovedMoneroPayout(data.source,data.profile);await setupAgreement(request.eventId,data);lifecycleState.database=state.database;
  const timestamp=Math.floor(Date.now()/1000),database=join(custody,'withdrawal.sqlite');
  const authority={epoch:'1',publicKeys:state.keys,requiredSign:3,nativeParticipants:[1,2,3,4],nativeThreshold:2,nativeSelected:[1,2]};
  const owner=await launchDistributedNative(vault,request,{database,clock:()=>1000n,leaseDuration:1000000n,authority},timestamp);
  expect(owner.disposition.inputReferences).toContain(source.deposit.outputKey);expect(owner.disposition.recipientAtomic).toBe('500000000');expect(await verify(owner.transaction)).toBe(true);
  const agreement=new FixtureAgreement();await agreement.prepare();const signatures=await votes(owner.transaction,timestamp);
  await agreement.approve(owner.transaction,[...signatures.slice(0,3),''],timestamp);
  const approval=agreement.takeVerifiedAgreement(getTxDataHash(owner.transaction));expect(approval).toBeDefined();await owner.approve(approval);
  const payment=createRoundtripPayment({node,binary,sha256,vault,owner,database,dataSource:state.database!.dataSource,lostSubmissionReply:true});
  const processor=payment.create();await processor.initialize();ChainHandler.initializeScoped(new Map([['monero',chain]]),processor);
  await processor.attachApproved(payment.binding,{sign:payment.sign});await TransactionProcessor.processTransactions();
  expect(payment.counts().signCalls).toBe(1);expect(owner.counts().shares).toBe(2);expect(payment.counts().submissions).toBe(1);
  const final=await payment.recover();expect((await node.transaction(final.finalTxId)).txs[0].in_pool).toBe(true);
  expect((await state.database!.getTxById(owner.transaction.txId))!.status).toBe('signed');
  const restarted=payment.create();await restarted.initialize();ChainHandler.initializeScoped(new Map([['monero',chain]]),restarted);
  await TransactionProcessor.processTransactions();expect(payment.counts().signCalls).toBe(1);expect(payment.counts().submissions).toBe(1);
  await expect(restarted.attachApproved(payment.binding,{sign:payment.sign})).rejects.toThrow();
  expect(payment.counts().signCalls).toBe(1);
  await node.mine(1,vault.vaultAddress);await TransactionProcessor.processTransactions();
  expect((await state.database!.getTxById(owner.transaction.txId))!.status).toBe('sent');
  await node.mine(1,vault.vaultAddress);await TransactionProcessor.processTransactions();
  const row=(await state.database!.getTxById(owner.transaction.txId))!,event=(await state.database!.getEventById(request.eventId))!;
  expect(row.status).toBe('completed');expect(row.txJson).toBe(payment.binding.originalTxJson);expect(event.status).toBe('pending-reward');
  const dispositions=await state.database!.dataSource.query('SELECT state FROM monero_payment_disposition'),inputs=await state.database!.dataSource.query('SELECT state FROM monero_payment_input');
  expect(dispositions).toEqual([{state:'settled'}]);expect(inputs).toEqual([{state:'spent'},{state:'spent'}]);
  await TransactionProcessor.processTransactions();expect(payment.counts().signCalls).toBe(1);expect(payment.counts().submissions).toBe(1);
  const keyState=await node.call('/is_key_image_spent',{key_images:[source.observation.keyImage]});expect(keyState.spent_status).toEqual([1]);
  const scan=payment.observations().at(-1);expect(scan.recipientAtomic).toBe('500000000');
  const evidence={scope:'linked-local-nodes-with-local-operator-source-authority',moneroGenesis:vault.genesis,deposit:source.deposit,
    depositIntentHash:source.decision.intentHash,credit:{txId:ergo.credit.transaction.id,boxId:ergo.credit.box.boxId,atomic:'500000120'},
    redemption:{txId:ergo.redemption.transaction.id,consumedCreditBoxId:ergo.redemption.consumedCreditBoxId,sourceEventId:request.eventId},
    withdrawal:{proposalId:owner.transaction.txId,finalTxId:final.finalTxId,byteDigest:final.byteDigest,...scan},
    controls:{fourSeparateHolders:true,selected:[1,2],walletShares:owner.counts().shares,creditRetries,ergoDuplicateReplayed:true,lostSubmissionReplyRecovered:true,
      originalProposalPreserved:true,sourceOutputSpent:true,settlement:'settled',...payment.counts()}};
  writeFileSync(join(process.env.W1HB_TRACE_DIR!,'roundtrip-evidence.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  console.log('Linked roundtrip settled with original proposal and identical recovered payout');
});
