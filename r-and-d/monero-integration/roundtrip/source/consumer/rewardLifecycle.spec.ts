import {afterEach,expect,it} from 'vitest';
import {ConfirmationStatus,type AbstractChain,type PaymentTransaction} from '@rosen-chains/abstract-chain';
import {AgreementDatabase} from './agreementDatabase';
import {TransactionEntity} from '../guard-service/src/db/entities/transactionEntity';
import {lifecycleState,lifecycleSource} from './lifecyclePorts';
import {completeRewardLifecycle,confirmedRewardChain} from './rewardLifecycle';
import ChainHandler from '../guard-service/src/handlers/chainHandler';
let database: AgreementDatabase;
afterEach(async()=>{await database?.close();lifecycleState.database=undefined;});
async function fixture(){
  database=await AgreementDatabase.open('c'.repeat(64),lifecycleSource());lifecycleState.database=database;
  const tx=(id:string,network:string,txType:string)=>({txId:id,eventId:database.eventId,network,txType,toJson:()=>JSON.stringify({id,network,txType})}) as PaymentTransaction;
  const payment=tx('a'.repeat(64),'monero','payment'),transaction=tx('b'.repeat(64),'ergo','reward');
  await database.insertTransaction(payment,3);await database.dataSource.manager.update(TransactionEntity,{txId:payment.txId},{status:'completed'});
  await database.setEventStatus(database.eventId,'pending-reward');
  let status=ConfirmationStatus.ConfirmedEnough,calls=0,submits=0,next:ConfirmationStatus[]=[];
  const chain=confirmedRewardChain({getTxConfirmationStatus:async(id:string,type:string)=>{expect(id).toBe(transaction.txId);expect(type).toBe('reward');calls++;return next.shift()??status;},getHeight:async()=>50,submitTransaction:async()=>{submits++;},isTxInMempool:async()=>false,isTxValid:async()=>({isValid:true})} as unknown as AbstractChain<unknown>);
  ChainHandler.initializeScoped(new Map([['monero',{} as AbstractChain<unknown>],['ergo',chain]]),undefined!);
  const options={database,transaction,chain,receipt:{id:transaction.txId,numConfirmations:2}};
  return {options,payment,setStatus:(value:ConfirmationStatus)=>{status=value;},sequence:(values:ConfirmationStatus[])=>{next=values;},get calls(){return calls;},get submits(){return submits;}};
}
it('actual reward processor completes the event and exact receipt replay creates no duplicate',async()=>{
  const f=await fixture();expect(await completeRewardLifecycle(f.options)).toEqual({txId:f.options.transaction.txId,transactionStatus:'completed',eventStatus:'completed'});
  await completeRewardLifecycle(f.options);expect(f.calls).toBe(4);expect(await database.getTransactions()).toHaveLength(2);
});
it('requires the confirmed-only chain even when a raw chain is registered',async()=>{
  const f=await fixture(),raw={getTxConfirmationStatus:async()=>ConfirmationStatus.ConfirmedEnough} as unknown as AbstractChain<unknown>;
  ChainHandler.initializeScoped(new Map([['monero',{} as AbstractChain<unknown>],['ergo',raw]]),undefined!);
  await expect(completeRewardLifecycle({...f.options,chain:raw})).rejects.toThrow(/confirmed-only/);
  expect(await database.getEventValidTxsByType(database.eventId,'reward')).toHaveLength(0);
});
it('independent chain confirmation is required even when a supplied receipt claims confirmation',async()=>{
  const f=await fixture();f.setStatus(ConfirmationStatus.NotConfirmedEnough);
  await expect(completeRewardLifecycle(f.options)).rejects.toThrow();expect(f.calls).toBe(1);expect((await database.getEventById(database.eventId))!.status).toBe('pending-reward');
});
it('a completed database row does not replace a fresh confirmation on replay',async()=>{
  const f=await fixture();await completeRewardLifecycle(f.options);f.setStatus(ConfirmationStatus.NotConfirmedEnough);
  await expect(completeRewardLifecycle(f.options)).rejects.toThrow();expect(f.calls).toBe(3);
});
it.each([true,false])('recovers a partial transaction/event update only while confirmed: %s',async confirmed=>{
  const f=await fixture();await database.insertTransaction(f.options.transaction,3);
  await database.dataSource.manager.update(TransactionEntity,{txId:f.options.transaction.txId},{status:'completed'});
  expect((await database.getEventById(database.eventId))!.status).toBe('pending-reward');
  if(confirmed){await completeRewardLifecycle(f.options);expect((await database.getEventById(database.eventId))!.status).toBe('completed');}
  else{f.setStatus(ConfirmationStatus.NotConfirmedEnough);await expect(completeRewardLifecycle(f.options)).rejects.toThrow();expect((await database.getEventById(database.eventId))!.status).toBe('pending-reward');}
});
it('repairs the exact approved import residue without signing or submission',async()=>{
  const f=await fixture();await database.insertTransaction(f.options.transaction,3);await completeRewardLifecycle(f.options);
  expect((await database.getEventById(database.eventId))!.status).toBe('completed');expect(f.submits).toBe(0);
});
it.each([ConfirmationStatus.NotFound,ConfirmationStatus.NotConfirmedEnough])('unconfirmed receipt creates no reward row: %s',async status=>{
  const f=await fixture();f.setStatus(status);await expect(completeRewardLifecycle(f.options)).rejects.toThrow();
  expect(await database.getEventValidTxsByType(database.eventId,'reward')).toHaveLength(0);expect(f.submits).toBe(0);
});
it('a reorg between importer and processor checks cannot enter the processor resubmission branch',async()=>{
  const f=await fixture();f.sequence([ConfirmationStatus.ConfirmedEnough,ConfirmationStatus.NotFound]);
  await expect(completeRewardLifecycle(f.options)).rejects.toThrow();expect(f.calls).toBe(2);expect(f.submits).toBe(0);
  expect((await database.getEventById(database.eventId))!.status).toBe('pending-reward');
  await completeRewardLifecycle(f.options);expect((await database.getEventById(database.eventId))!.status).toBe('completed');
});
it.each(['receipt','payment','event','existing'] as const)('refuses a substituted %s boundary',async fault=>{
  const f=await fixture();
  if(fault==='receipt')f.options.receipt.id='d'.repeat(64);
  if(fault==='payment')await database.dataSource.manager.update(TransactionEntity,{txId:f.payment.txId},{status:'sent'});
  if(fault==='event')await database.setEventStatus(database.eventId,'pending-payment');
  if(fault==='existing'){await database.insertTransaction({...f.options.transaction,txId:'d'.repeat(64)},3);}
  await expect(completeRewardLifecycle(f.options)).rejects.toThrow();expect(f.calls).toBe(0);
});
