import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import type { AbstractChain, PaymentTransaction } from '@rosen-chains/abstract-chain';
import { ConfirmationStatus } from '@rosen-chains/abstract-chain';
import ChainHandler from '../guard-service/src/handlers/chainHandler';
import TransactionProcessor from '../guard-service/src/transaction/transactionProcessor';
import { MoneroPaymentLifecycle, type MoneroFinal, type MoneroObservation, type MoneroPaymentBinding, type MoneroLifecyclePorts } from '../guard-service/src/transaction/moneroPaymentLifecycle';
import { AgreementDatabase } from './agreementDatabase';
import { lifecycleState, lifecycleSource } from './lifecyclePorts';
const proposal = 'p'.repeat(64), reservation = 'a'.repeat(64), finalId = 'b'.repeat(64);
let owned: AgreementDatabase | undefined;
const otherConnections: DataSource[] = [];
afterEach(async () => { for (const ds of otherConnections.splice(0).reverse()) await ds.destroy(); await owned?.close(); owned = undefined; lifecycleState.database = undefined; });
async function secondConnection(memory = false) {
  const ds = new DataSource({...owned!.dataSource.options, ...(memory ? {database:':memory:',synchronize:true} : {synchronize:false})} as any);
  await ds.initialize(); otherConnections.push(ds); return ds;
}
function pause() {
  let release!:()=>void, entered!:()=>void;
  const wait = new Promise<void>(resolve=>{release=resolve;});
  const started = new Promise<void>(resolve=>{entered=resolve;});
  return {wait,started,release,entered};
}
async function fixture(options: { uncertain?: boolean; committedThrow?: boolean; signWait?:()=>Promise<void>; lostSubmit?: boolean; fault?: () => void } = {}) {
  owned = await AgreementDatabase.open('c'.repeat(64), lifecycleSource()); lifecycleState.database = owned;
  const original = JSON.stringify({network:'monero',txId:proposal,eventId:owned.eventId,txType:'payment',txBytes:'native-candidate'});
  await owned.insertTransaction({txId:proposal,network:'monero',eventId:owned.eventId,txType:'payment',toJson:()=>original} as PaymentTransaction,3);
  await owned.setEventStatus(owned.eventId,'in-payment');
  const bytes = Uint8Array.of(1,2,3);
  const final: MoneroFinal = {reservationId:reservation,proposalId:proposal,finalTxId:finalId,byteDigest:createHash('sha256').update(bytes).digest('hex'),txBytes:bytes,spentInputs:['input-public-key'],changeIdentity:'change-output-public-key'};
  const binding: MoneroPaymentBinding = {reservationId:reservation,proposalId:proposal,obligationId:owned.eventId,eventId:owned.eventId,originalTxJson:original,inputReferences:final.spentInputs,changeIdentity:final.changeIdentity,requiredConfirmations:2,recipientAtomic:'100',changeAtomic:'20'};
  let committed = false, signs = 0, submissions = 0, recovered = 0;
  let observation: MoneroObservation = {finalTxId:finalId,tipHeight:10,recipientMatches:false,inPool:false};
  const submitted: string[] = [], observed: string[] = [];
  const ports = {dataSource:owned.dataSource,requiredConfirmations:2,recoverFinal:async()=>{recovered++;if(!committed)throw Error('journal:uncertain');return final;},observe:async(f:MoneroFinal)=>{observed.push(f.finalTxId);return observation;},submit:async(f:MoneroFinal)=>{submissions++;submitted.push(Buffer.from(f.txBytes).toString('hex'));if(options.lostSubmit && submissions === 1)throw Error('accepted-response-lost');},settlementFault:options.fault};
  const create = (override: Partial<MoneroLifecyclePorts> = {}) => { const lifecycle = new MoneroPaymentLifecycle({...ports,...override}); const chain = {PaymentTransactionFromJson:()=>{throw Error('Monero JSON cannot sign');}} as unknown as AbstractChain<unknown>; ChainHandler.initializeScoped(new Map([['monero',chain]]),lifecycle); return lifecycle; };
  const lifecycle = create(); await lifecycle.initialize();
  await lifecycle.attachApproved(binding,{sign:async()=>{signs++;if(options.uncertain)throw Error('possible-share');committed=true;await options.signWait?.();if(options.committedThrow)throw Error('completed-reply-lost');return final;}});
  const confirm = (change: Partial<MoneroObservation> = {}) => {observation={finalTxId:finalId,blockHash:'d'.repeat(64),canonicalBlockHash:'d'.repeat(64),blockHeight:10,tipHeight:11,recipientMatches:true,recipientAtomic:'100',changeAtomic:'20',inPool:false,...change};};
  const snapshot = async () => ({tx:await owned!.getTxById(proposal),event:await owned!.getEventById(owned!.eventId),dispositions:await owned!.dataSource.query('SELECT * FROM monero_payment_disposition'),inputs:await owned!.dataSource.query('SELECT * FROM monero_payment_input')});
  return {create,confirm,snapshot,submitted,observed,ports,final,binding,get signs(){return signs;},get submissions(){return submissions;},get recovered(){return recovered;}};
}
describe('actual registered payment processor',()=>{
  it('lost submission response and restart recover and resubmit identical final bytes',async()=>{
    const f=await fixture({lostSubmit:true});await TransactionProcessor.processTransactions();
    expect((await f.snapshot()).tx?.status).toBe('signed');f.create();await TransactionProcessor.processTransactions();
    expect(f.signs).toBe(1);expect(f.submitted).toEqual(['010203','010203']);expect(f.observed).toEqual([finalId,finalId]);expect(f.recovered).toBe(2);
    const s=await f.snapshot();expect(s.tx?.txId).toBe(proposal);expect(s.tx?.txJson).toBe(f.binding.originalTxJson);expect(s.event?.status).toBe('in-payment');expect(s.inputs[0].state).toBe('reserved');
  });
  it('uncertain share failure and restart never sign again or release inputs',async()=>{
    const f=await fixture({uncertain:true});await TransactionProcessor.processTransactions();f.create();await TransactionProcessor.processTransactions();await TransactionProcessor.processTransactions();
    const s=await f.snapshot();expect(f.signs).toBe(1);expect(f.submissions).toBe(0);expect(s.tx?.status).toBe('sign-failed');expect(s.dispositions[0].state).toBe('quarantined');expect(s.inputs[0].state).toBe('reserved');expect(s.event?.status).toBe('in-payment');
  });
  it('canonical depth and recipient amounts atomically settle only once',async()=>{
    const f=await fixture();await TransactionProcessor.processTransactions();f.confirm({tipHeight:10});await TransactionProcessor.processTransactions();expect((await f.snapshot()).event?.status).toBe('in-payment');
    f.confirm({changeAtomic:'19'});await TransactionProcessor.processTransactions();expect((await f.snapshot()).event?.status).toBe('in-payment');
    f.confirm({canonicalBlockHash:'e'.repeat(64)});await TransactionProcessor.processTransactions();expect((await f.snapshot()).event?.status).toBe('in-payment');
    f.confirm();await TransactionProcessor.processTransactions();const after=await f.snapshot();const reopened=f.create();await reopened.process(after.tx!);await TransactionProcessor.processTransactions();const repeated=await f.snapshot();
    expect(after.tx?.status).toBe('completed');expect(after.event?.status).toBe('pending-reward');expect(after.dispositions[0].state).toBe('settled');expect(after.inputs[0].state).toBe('spent');expect(repeated).toEqual(after);expect(f.signs).toBe(1);
  });
  it('failure between transaction and event effects rolls back the complete join',async()=>{
    let fail=true;const f=await fixture({fault:()=>{if(fail)throw Error('atomic-effect-cut');}});await TransactionProcessor.processTransactions();f.confirm();await TransactionProcessor.processTransactions();
    const rolled=await f.snapshot();expect(rolled.tx?.status).toBe('sent');expect(rolled.event?.status).toBe('in-payment');expect(rolled.dispositions[0].state).toBe('final');expect(rolled.inputs[0].state).toBe('reserved');
    fail=false;await TransactionProcessor.processTransactions();expect((await f.snapshot()).tx?.status).toBe('completed');
  });
  it('recovered journal corruption cannot submit or settle',async()=>{
    const f=await fixture();await TransactionProcessor.processTransactions();const count=f.submissions;f.final.txBytes[0]=9;f.confirm();await TransactionProcessor.processTransactions();
    expect(f.submissions).toBe(count);expect((await f.snapshot()).event?.status).toBe('in-payment');
  });
  it('a completed native journal survives a lost signing reply without another sign',async()=>{
    const f=await fixture({committedThrow:true});await TransactionProcessor.processTransactions();f.create();await TransactionProcessor.processTransactions();expect(f.signs).toBe(1);expect(f.submitted).toEqual(['010203','010203']);expect((await f.snapshot()).dispositions[0].state).toBe('final');
  });
  it('restart of a prepared disposition has no signing capability and cannot replace it',async()=>{
    const f=await fixture();const fresh=f.create();await TransactionProcessor.processTransactions();expect(f.signs).toBe(0);expect(f.submissions).toBe(0);
    await expect(fresh.attachApproved(f.binding,{sign:async()=>{throw Error('forbidden replacement');}})).rejects.toThrow();expect((await f.snapshot()).dispositions[0].state).toBe('prepared');
  });
  it.each(['synchronous=OFF','journal_mode=MEMORY','journal_mode=OFF','read_uncommitted=1'])('rejects unsafe SQLite policy %s without repairing it',async(setting)=>{
    const f=await fixture();await owned!.dataSource.query('PRAGMA '+setting);const before=await owned!.dataSource.query('PRAGMA '+setting.split('=')[0]);
    await expect(f.create().initialize()).rejects.toThrow('payment:durability-policy');
    expect(await owned!.dataSource.query('PRAGMA '+setting.split('=')[0])).toEqual(before);expect(f.signs).toBe(0);
  });
  it('rejects an actual memory-backed SQLite datasource',async()=>{
    const f=await fixture();const memory=await secondConnection(true);
    await expect(f.create({dataSource:memory}).initialize()).rejects.toThrow('payment:file-custody');expect(f.signs).toBe(0);
  });
  it('policy drift after attachment blocks the deciding write and live signer',async()=>{
    const f=await fixture();await owned!.dataSource.query('PRAGMA synchronous=OFF');await owned!.dataSource.query('PRAGMA journal_mode=MEMORY');
    await TransactionProcessor.processTransactions();const s=await f.snapshot();expect(f.signs).toBe(0);expect(s.tx?.status).toBe('approved');expect(s.dispositions[0].state).toBe('prepared');expect(s.inputs[0].state).toBe('reserved');expect(await owned!.dataSource.query('PRAGMA synchronous')).toEqual([{synchronous:0}]);expect(await owned!.dataSource.query('PRAGMA journal_mode')).toEqual([{journal_mode:'memory'}]);
  });
  it('policy drift during native recovery blocks the final disposition write',async()=>{
    const f=await fixture();await TransactionProcessor.processTransactions();
    f.create({recoverFinal:async()=>{await owned!.dataSource.query('PRAGMA synchronous=OFF');return f.final;}});
    await TransactionProcessor.processTransactions();expect(f.signs).toBe(1);expect(f.observed).toEqual([finalId]);expect((await f.snapshot()).tx?.status).toBe('sent');expect((await f.snapshot()).dispositions[0].state).toBe('final');
  });
  it('policy drift immediately after possible-signing commits prevents the live signing callback',async()=>{
    const f=await fixture();let injected=false;
    owned!.dataSource.subscribers.push({afterTransactionCommit:async()=>{
      if (!injected && (await owned!.dataSource.query('SELECT state FROM monero_payment_disposition'))[0].state==='possible-signing') {
        injected=true;await owned!.dataSource.query('PRAGMA synchronous=OFF');await owned!.dataSource.query('PRAGMA journal_mode=MEMORY');
      }
    }});
    await TransactionProcessor.processTransactions();const s=await f.snapshot();expect(injected).toBe(true);expect(f.signs).toBe(0);expect(s.tx?.status).toBe('in-sign');expect(s.dispositions[0].state).toBe('possible-signing');expect(s.inputs[0].state).toBe('reserved');
  });
  it.each(['observe','submit','recover'] as const)('stale %s response cannot regress a settlement from another SQLite connection',async(stage)=>{
    const f=await fixture();await TransactionProcessor.processTransactions();const second=await secondConnection();const gate=pause();
    const pending:MoneroObservation={finalTxId:finalId,tipHeight:10,recipientMatches:false,inPool:stage==='observe'};
    const override:Partial<MoneroLifecyclePorts>=stage==='observe'?{observe:async()=>{gate.entered();await gate.wait;return pending;}}:stage==='submit'?{observe:async()=>pending,submit:async()=>{gate.entered();await gate.wait;}}:{recoverFinal:async()=>{gate.entered();await gate.wait;return f.final;}};
    f.create(override);const stale=TransactionProcessor.processTransactions();await gate.started;
    f.confirm();const successor=f.create({dataSource:second});await TransactionProcessor.processTransactions();const settled=await f.snapshot();expect(settled.tx?.status).toBe('completed');
    gate.release();await stale;expect(await f.snapshot()).toEqual(settled);await successor.process((await owned!.getTxById(proposal))!);expect(await f.snapshot()).toEqual(settled);expect(f.signs).toBe(1);
  });
  it('late failed signing reply cannot quarantine a final payment settled by another connection',async()=>{
    const gate=pause();const f=await fixture({committedThrow:true,signWait:async()=>{gate.entered();await gate.wait;}});const second=await secondConnection();
    const active=TransactionProcessor.processTransactions();await gate.started;f.confirm();f.create({dataSource:second});await TransactionProcessor.processTransactions();const settled=await f.snapshot();expect(settled.tx?.status).toBe('completed');
    gate.release();await active;expect(await f.snapshot()).toEqual(settled);expect(f.signs).toBe(1);
  });
  it('other registered chain still follows the original sent processing branch',async()=>{
    const f=await fixture();await TransactionProcessor.processTransactions();
    await owned!.dataSource.manager.update('TransactionEntity',{txId:proposal},{chain:'bitcoin',status:'sent'});
    let looked='';const chain={getTxConfirmationStatus:async(id:string)=>{looked=id;return ConfirmationStatus.NotConfirmedEnough;},getHeight:async()=>42} as unknown as AbstractChain<unknown>;
    const registered=ChainHandler.initializeScoped(new Map([['monero',chain],['bitcoin',chain]]),f.create());
    expect(registered.getChain('bitcoin')).toBe(chain);await TransactionProcessor.processTransactions();expect(looked).toBe(proposal);expect((await f.snapshot()).tx?.lastCheck).toBe(42);
  });
});
