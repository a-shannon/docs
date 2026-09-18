import assert from 'node:assert/strict';
import type {AbstractChain, PaymentTransaction} from '@rosen-chains/abstract-chain';
import {ConfirmationStatus} from '@rosen-chains/abstract-chain';
import type {AgreementDatabase} from './agreementDatabase';
import {TransactionEntity} from '../guard-service/src/db/entities/transactionEntity';
import ChainHandler from '../guard-service/src/handlers/chainHandler';
import TransactionProcessor from '../guard-service/src/transaction/transactionProcessor';
const confirmedChains=new WeakSet<object>();

/** Restrict receipt import to confirmed observations, including a racing reorg. */
export function confirmedRewardChain(chain: AbstractChain<unknown>): AbstractChain<unknown> {
  const guarded=new Proxy(chain,{get(target,key){
    if(key==='submitTransaction')return ()=>{throw Error('Reward receipt import cannot broadcast');};
    if(key==='getTxConfirmationStatus')return async(...args: Parameters<typeof chain.getTxConfirmationStatus>)=>{
      const status=await target.getTxConfirmationStatus(...args);
      assert.equal(status,ConfirmationStatus.ConfirmedEnough,'Reward receipt requires current confirmation');return status;
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});confirmedChains.add(guarded);return guarded;
}

/** Project the independently confirmed reward into the actual Rosen lifecycle. */
export async function completeRewardLifecycle({database,transaction,chain,receipt}: {
  database: AgreementDatabase; transaction: PaymentTransaction; chain: AbstractChain<unknown>;
  receipt: {id:string;numConfirmations:number};
}) {
  assert(confirmedChains.has(chain),'Reward receipt import requires a confirmed-only chain');
  assert.equal(transaction.network,'ergo');assert.equal(transaction.txType,'reward');
  assert.equal(transaction.eventId,database.eventId);assert.equal(receipt.id,transaction.txId);
  assert.equal(ChainHandler.getInstance().getChain('ergo'),chain);
  assert(Number.isSafeInteger(receipt.numConfirmations)&&receipt.numConfirmations>0);
  const event=await database.getEventById(transaction.eventId);assert(event);
  assert(['pending-reward','completed'].includes(event.status));
  const payments=await database.getEventValidTxsByType(transaction.eventId,'payment');
  assert.equal(payments.length,1);assert.equal(payments[0].chain,'monero');assert.equal(payments[0].status,'completed');
  const rewards=await database.getEventValidTxsByType(transaction.eventId,'reward');
  assert(rewards.length<=1);
  let row=rewards[0];
  if(row){assert.equal(row.txId,transaction.txId);assert.equal(row.txJson,transaction.toJson());assert(['approved','sent','completed'].includes(row.status));}
  assert.equal(await chain.getTxConfirmationStatus(transaction.txId,transaction.txType),ConfirmationStatus.ConfirmedEnough);
  if(!row){
    assert.equal(event.status,'pending-reward');
    await database.insertTransaction(transaction,3);
    row=(await database.getTxById(transaction.txId))!;
  }
  if(row.status==='approved'){
    // Signing/submission belong to the durable reward owner. This loader imports
    // its confirmed receipt; it does not replay the signer or broadcast again.
    await database.dataSource.manager.update(TransactionEntity,{txId:transaction.txId},{status:'sent'});
    row=(await database.getTxById(transaction.txId))!;
  }
  assert(row);
  // Direct call preserves errors, unlike the service loop's logging boundary.
  // The processor writes transaction and event status separately. Replaying it
  // also repairs a crash between those writes, without signing or submission.
  await TransactionProcessor.processSentTx(row);
  const stored=(await database.getTxById(transaction.txId))!,closed=(await database.getEventById(transaction.eventId))!;
  assert.equal(stored.status,'completed');assert.equal(closed.status,'completed');
  assert.equal(stored.txJson,transaction.toJson());
  // The processor's fresh observation is the terminal confirmation for this
  // import. Subsequent reorganizations belong to the chain monitoring lifecycle.
  return {txId:stored.txId,transactionStatus:stored.status,eventStatus:closed.status};
}
