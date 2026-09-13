import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource, Not } from '@rosen-bridge/extended-typeorm';
import { BlockEntity } from '@rosen-bridge/abstract-scanner';
import { EventTriggerEntity } from '@rosen-bridge/watcher-data-extractor';
import { ConfirmedEventEntity } from '../guard-service/src/db/entities/confirmedEventEntity';
import { TransactionEntity } from '../guard-service/src/db/entities/transactionEntity';
import { ArbitraryEntity } from '../guard-service/src/db/entities/arbitraryEntity';
import type { PaymentTransaction } from '@rosen-chains/abstract-chain';
import { nativePin } from './nativePin';
import { terms } from './projectionFixture';

/** Owns real approval tables; committee, commitment and fee facts remain explicit fixtures. */
export class AgreementDatabase {
  private constructor(readonly dataSource: DataSource, readonly eventId: string) {}
  static async open(eventId: string, source: ReturnType<typeof terms>) {
    const database = join(mkdtempSync(join(nativePin.runtime, 'agreement-db-')), 'approval.sqlite');
    const ds = new DataSource({ type: 'sqlite', database, entities: [ConfirmedEventEntity, TransactionEntity, ArbitraryEntity, EventTriggerEntity, BlockEntity], synchronize: true, logging: false });
    try {
      await ds.initialize();
      const row: Record<string, unknown> = {};
      for (const column of ds.getMetadata(EventTriggerEntity).columns) {
        if (column.isGenerated || column.isNullable || column.default !== undefined || column.relationMetadata) continue;
        row[column.propertyName] = ['int', 'integer', 'bigint', 'float', 'double'].includes(String(column.type)) || column.type === Number ? 1 : 'fixture';
      }
      Object.assign(row, source.source.event, { txId: source.source.triggerTransactionId, identifier: source.source.triggerBoxId });
      const inserted = await ds.manager.insert(EventTriggerEntity, row);
      const eventData = await ds.manager.findOneByOrFail(EventTriggerEntity, inserted.identifiers[0]);
      await ds.manager.insert(ConfirmedEventEntity, { id: eventId, status: 'pending-payment', eventData });
      return new AgreementDatabase(ds, eventId);
    } catch (error) { if (ds.isInitialized) await ds.destroy(); throw error; }
  }
  getEventById = (id: string) => this.dataSource.manager.findOne(ConfirmedEventEntity, { where: { id }, relations: ['eventData'] });
  getEventValidTxsByType = (id: string, type: string) => this.dataSource.manager.find(TransactionEntity, { where: { event: { id }, type, status: Not('invalid') }, relations: ['event', 'order'] });
  getTxById = (txId: string) => this.dataSource.manager.findOne(TransactionEntity, { where: { txId }, relations: ['event', 'order'] });
  getTransactions = () => this.dataSource.manager.find(TransactionEntity, { relations: ['event', 'order'] });
  setEventStatus = async (id: string, status: string) => {
    const result = await this.dataSource.manager.update(ConfirmedEventEntity, { id }, { status });
    if (result.affected !== 1) throw Error('fixture:unknown-event');
  };
  updateEventData = async (changes: Partial<EventTriggerEntity>) => {
    const event = await this.getEventById(this.eventId);
    if (!event) throw Error('fixture:unknown-event');
    await this.dataSource.manager.update(EventTriggerEntity, { id: event.eventData.id }, changes);
  };
  insertTransaction = async (tx: PaymentTransaction, requiredSign: number, txId = tx.txId) => {
    await this.dataSource.manager.insert(TransactionEntity, { txId, txJson: tx.toJson(), chain: tx.network, type: tx.txType, requiredSign, status: 'approved', event: { id: tx.eventId }, order: null, lastCheck: 0, failedInSign: false, signFailedCount: 0 });
  };
  close = async () => { if (this.dataSource.isInitialized) await this.dataSource.destroy(); };
}
