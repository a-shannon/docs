import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource, Not } from '@rosen-bridge/extended-typeorm';
import { BlockEntity } from '@rosen-bridge/abstract-scanner';
import { EventTriggerEntity } from '@rosen-bridge/watcher-data-extractor';
import { ConfirmedEventEntity } from '../guard-service/src/db/entities/confirmedEventEntity';
import { TransactionEntity } from '../guard-service/src/db/entities/transactionEntity';
import { ArbitraryEntity } from '../guard-service/src/db/entities/arbitraryEntity';
import EventSerializer from '../guard-service/src/event/eventSerializer';
import { commitMoneroAgreement } from '../guard-service/src/db/moneroAgreementCommit';
import type { VerifiedEventRequestSnapshot } from '../guard-service/src/verification/requestVerifier';
import { PaymentTransaction, TransactionType } from '@rosen-chains/abstract-chain';

const opened: DataSource[] = [];
afterEach(async () => { for (const ds of opened.splice(0)) if(ds.isInitialized) await ds.destroy(); });
export async function atomicFixture(options: { cache?: { alwaysEnabled: boolean; duration: number }; busyErrorRetry?: number } = {}) {
  const database = join(mkdtempSync((config.runtimeDirectory+'/atomic-')), 'approval.sqlite');
  const ds = new DataSource({type:'sqlite', database, entities:[ConfirmedEventEntity, TransactionEntity, ArbitraryEntity, EventTriggerEntity, BlockEntity], synchronize:true, logging:false, ...options});
  await ds.initialize(); opened.push(ds);
  // Required fixture columns are derived from actual registered metadata, not guessed table layouts.
  const row: Record<string, unknown> = {};
  for(const column of ds.getMetadata(EventTriggerEntity).columns) {
    if(column.isGenerated || column.isNullable || column.default !== undefined || column.relationMetadata) continue;
    row[column.propertyName] = ['int','integer','bigint','float','double'].includes(String(column.type)) || column.type === Number ? 1 : 'fixture';
  }
  Object.assign(row,{identifier:'box',txId:'trigger',fromChain:'ergo',toChain:'monero',amount:'100',bridgeFee:'1',networkFee:'1'});
  const inserted = await ds.manager.insert(EventTriggerEntity,row);
  const eventData = await ds.manager.findOneByOrFail(EventTriggerEntity, inserted.identifiers[0]);
  await ds.manager.insert(ConfirmedEventEntity,{id:'event',status:'pending-payment',eventData});
  const event = await ds.manager.findOneOrFail(ConfirmedEventEntity,{where:{id:'event'},relations:['eventData']});
  const tx = new PaymentTransaction('monero','candidate','event',Buffer.from([1,2]),TransactionType.payment);
  const provenance = {eventId:'event',eventStatus:'pending-payment',activeTransactionIds:[],txJson:tx.toJson(),
    event:EventSerializer.fromConfirmedEntity(event),triggerTransactionId:'trigger',triggerBoxId:'box',wids:[],feeConfig:{}} as unknown as VerifiedEventRequestSnapshot;
  return {ds,tx,provenance};
}
async function state(ds:DataSource){return {event:await ds.manager.findOneByOrFail(ConfirmedEventEntity,{id:'event'}), txs:await ds.manager.find(TransactionEntity,{relations:['event','order']})};}

describe('atomic Monero agreement with real file SQLite',()=>{
  it('commits exact approval and conditional event status together',async()=>{
    const {ds,tx,provenance}=await atomicFixture();
    expect(await commitMoneroAgreement(ds,tx,provenance,3,()=>true)).toBe(true);
    const result=await state(ds);expect(result.event.status).toBe('in-payment');expect(result.txs).toHaveLength(1);
    expect(result.txs[0]).toMatchObject({txId:tx.txId,txJson:tx.toJson(),chain:'monero',type:'payment',status:'approved',requiredSign:3,event:{id:'event'},order:null});
  });
  it('preserves an invalidated event and inserts nothing',async()=>{
    const {ds,tx,provenance}=await atomicFixture();await ds.manager.update(ConfirmedEventEntity,{id:'event'},{status:'rejected'});
    expect(await commitMoneroAgreement(ds,tx,provenance,3,()=>true)).toBe(false);
    const result=await state(ds);expect(result.event.status).toBe('rejected');expect(result.txs).toHaveLength(0);
  });
  it('preserves a foreign active transaction',async()=>{
    const {ds,tx,provenance}=await atomicFixture();
    await ds.manager.insert(TransactionEntity,{txId:'foreign',txJson:'foreign',type:'payment',chain:'monero',status:'approved',lastCheck:0,event:{id:'event'},failedInSign:false,signFailedCount:0,requiredSign:3});
    expect(await commitMoneroAgreement(ds,tx,provenance,3,()=>true)).toBe(false);
    const result=await state(ds);expect(result.event.status).toBe('pending-payment');expect(result.txs.map(t=>t.txId)).toEqual(['foreign']);
  });
  it('excludes an unrelated original-connection writer through the entire commit window',async()=>{
    const {ds,tx,provenance}=await atomicFixture();await ds.query('PRAGMA busy_timeout = 0');let checked=0;
    expect(await commitMoneroAgreement(ds,tx,provenance,3,()=>true,async phase=>{
      expect(['snapshot-checked','before-commit']).toContain(phase);
      await expect(ds.manager.update(ConfirmedEventEntity,{id:'event'},{status:'rejected'})).rejects.toThrow(/SQLITE_BUSY/);
      checked++;
      expect((await state(ds)).event.status).toBe('pending-payment');
    })).toBe(true);
    expect(checked).toBe(2);expect((await state(ds)).event.status).toBe('in-payment');
  });
  it('rolls back both writes if authority expires before commit',async()=>{
    const {ds,tx,provenance}=await atomicFixture();let current=true;
    expect(await commitMoneroAgreement(ds,tx,provenance,3,()=>current,phase=>{if(phase==='before-commit')current=false;})).toBe(false);
    const result=await state(ds);expect(result.event.status).toBe('pending-payment');expect(result.txs).toHaveLength(0);
  });
  it.each(['triggerTransactionId','triggerBoxId','event','activeTransactionIds'] as const)('rejects isolated changed %s provenance',async field=>{
    const {ds,tx,provenance}=await atomicFixture();
    const changed={...provenance,[field]:field==='event'?{...provenance.event,amount:'101'}:field==='activeTransactionIds'?['candidate']:'other'};
    expect(await commitMoneroAgreement(ds,tx,changed,3,()=>true)).toBe(false);
    const result=await state(ds);expect(result.event.status).toBe('pending-payment');expect(result.txs).toHaveLength(0);
  });
  it('allows exact existing own approval only with matching fresh captured set and status',async()=>{
    const {ds,tx,provenance}=await atomicFixture();
    expect(await commitMoneroAgreement(ds,tx,provenance,3,()=>true)).toBe(true);
    expect(await commitMoneroAgreement(ds,tx,provenance,3,()=>true)).toBe(false);
    const observed={...provenance,eventStatus:'in-payment',activeTransactionIds:[tx.txId]};
    expect(await commitMoneroAgreement(ds,tx,observed,3,()=>true)).toBe(true);
    expect(await commitMoneroAgreement(ds,tx,observed,4,()=>true)).toBe(false);
    expect((await state(ds)).txs).toHaveLength(1);
  });
  it('rejects in-memory and other driver profiles before touching them',async()=>{
    const {tx,provenance}=await atomicFixture();
    for(const type of ['sqlite','postgres']) {
      const unsupported={isInitialized:true,options:{type,database:':memory:'}} as DataSource;
      expect(await commitMoneroAgreement(unsupported,tx,provenance,3,()=>true)).toBe(false);
    }
  });
  it('ignores inherited always-enabled cache after exact snapshot queries were warmed',async()=>{
    const {ds,tx,provenance}=await atomicFixture({cache:{alwaysEnabled:true,duration:600000}});
    expect(await commitMoneroAgreement(ds,tx,provenance,3,()=>true)).toBe(true);
    const observed={...provenance,eventStatus:'in-payment',activeTransactionIds:[tx.txId]};
    const activeQuery={where:{event:{id:'event'},type:'payment',status:Not('invalid')},relations:['event','order']};
    await ds.manager.findOne(ConfirmedEventEntity,{where:{id:'event'},relations:['eventData']});
    await ds.manager.findOne(TransactionEntity,{where:{txId:tx.txId},relations:['event','order']});
    expect((await ds.manager.find(TransactionEntity,activeQuery)).map(t=>t.txId)).toEqual([tx.txId]);
    await ds.manager.insert(TransactionEntity,{txId:'foreign',txJson:'foreign',type:'payment',chain:'monero',status:'approved',lastCheck:0,event:{id:'event'},failedInSign:false,signFailedCount:0,requiredSign:3});
    // Demonstrate the stale cache actually exists; the helper must not consume it.
    expect((await ds.manager.find(TransactionEntity,activeQuery)).map(t=>t.txId)).toEqual([tx.txId]);
    expect(await commitMoneroAgreement(ds,tx,observed,3,()=>true)).toBe(false);
    const rows=await ds.manager.createQueryBuilder(TransactionEntity,'tx').cache(false).getMany();
    expect(rows.map(t=>t.txId).sort()).toEqual(['candidate','foreign']);
  });
  it('disables inherited JS busy retries and refuses a locked database promptly',async()=>{
    const {ds,tx,provenance}=await atomicFixture({busyErrorRetry:10});
    const writer=ds.createQueryRunner();await writer.connect();await writer.query('BEGIN IMMEDIATE');
    let current=true;let pending:Promise<boolean>|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      pending=commitMoneroAgreement(ds,tx,provenance,3,()=>current);
      const result=await Promise.race([pending,new Promise<string>(resolve=>{timer=setTimeout(()=>resolve('deadline'),1500);})]);
      expect(result).toBe(false);
      expect((await state(ds)).txs).toHaveLength(0);
    } finally {
      if(timer)clearTimeout(timer);current=false;
      await writer.query('ROLLBACK');await writer.release();await pending;
    }
    expect((await state(ds)).event.status).toBe('pending-payment');
  });
});
