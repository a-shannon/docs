import { DataSource, Not } from '@rosen-bridge/extended-typeorm';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { PaymentTransaction } from '@rosen-chains/abstract-chain';
import type { VerifiedEventRequestSnapshot } from '../verification/requestVerifier';
import EventSerializer from '../event/eventSerializer';
import { ConfirmedEventEntity } from './entities/confirmedEventEntity';
import { TransactionEntity } from './entities/transactionEntity';

export type MoneroCommitPhase = 'snapshot-checked' | 'before-commit';

/** Bounded file-SQLite profile. No retry: an uncertain COMMIT never grants authority. */
export async function commitMoneroAgreement(
  source: DataSource, tx: PaymentTransaction, provenance: VerifiedEventRequestSnapshot,
  requiredSign: number, isCurrent: () => boolean,
  fault?: (phase: MoneroCommitPhase) => void | Promise<void>,
): Promise<boolean> {
  let owned: DataSource | undefined;
  let begun = false;
  let runner: ReturnType<DataSource['createQueryRunner']> | undefined;
  try {
    if (!source.isInitialized || source.options.type !== 'sqlite' ||
      typeof source.options.database !== 'string' || !isAbsolute(source.options.database) ||
      source.options.database.includes(':memory:') ||
      !Number.isSafeInteger(requiredSign) || requiredSign < 1 || !isCurrent()) return false;
    const id = tx.txId, eventId = tx.eventId, txJson = tx.toJson();
    const statusTimestamp = Date.now().toString();
    if (tx.network !== 'monero' || tx.txType !== 'payment' || provenance.txJson !== txJson ||
      provenance.eventId !== eventId) return false;
    // Own copies before the first await. Do not retain caller-mutable observation aliases.
    const observed = structuredClone(provenance);
    const current = () => isCurrent() && tx.txId === id && tx.eventId === eventId &&
      tx.network === 'monero' && tx.txType === 'payment' && tx.toJson() === txJson;
    owned = new DataSource({ ...source.options, synchronize: false, migrationsRun: false,
      dropSchema: false, logging: false, subscribers: [], migrations: [],
      cache: false, busyErrorRetry: 0 });
    await owned.initialize();
    runner = owned.createQueryRunner(); await runner.connect();
    await runner.query('PRAGMA busy_timeout = 0');
    await runner.query('BEGIN IMMEDIATE'); begun = true;
    const manager = runner.manager;
    const event = await manager.findOne(ConfirmedEventEntity, { where: { id: eventId }, relations: ['eventData'] });
    if (!current() || !event || event.status !== observed.eventStatus ||
      event.eventData.txId !== observed.triggerTransactionId || event.eventData.identifier !== observed.triggerBoxId ||
      !isDeepStrictEqual(EventSerializer.fromConfirmedEntity(event), observed.event)) throw Error('event changed');
    const active = await manager.find(TransactionEntity, { where: { event: { id: eventId }, type: 'payment', status: Not('invalid') }, relations: ['event', 'order'] });
    const activeIds = active.map(value => value.txId).sort();
    if (activeIds.some(value => value !== id) || !isDeepStrictEqual(activeIds, [...observed.activeTransactionIds].sort())) throw Error('active transactions changed');
    const previous = await manager.findOne(TransactionEntity, { where: { txId: id }, relations: ['event', 'order'] });
    const exact = (value: TransactionEntity | null) => value !== null && value.txId === id &&
      value.txJson === txJson && value.chain === 'monero' && value.type === 'payment' &&
      value.status === 'approved' && value.requiredSign === requiredSign && value.event?.id === eventId && value.order === null;
    if (previous && !exact(previous)) throw Error('existing transaction differs');
    if (!(event.status === 'pending-payment' || (event.status === 'in-payment' && exact(previous) && activeIds.length === 1))) throw Error('event ineligible');
    await fault?.('snapshot-checked');
    if (!current()) throw Error('retired');
    if (!previous) await manager.insert(TransactionEntity, { txId: id, txJson, type: 'payment', chain: 'monero',
      status: 'approved', lastCheck: 0, event: { id: eventId }, order: null,
      lastStatusUpdate: statusTimestamp, failedInSign: false, signFailedCount: 0, requiredSign });
    const updated = await manager.update(ConfirmedEventEntity, { id: eventId, status: observed.eventStatus }, { status: 'in-payment' });
    if (updated.affected !== 1) throw Error('conditional status failed');
    const persisted = await manager.findOne(TransactionEntity, { where: { txId: id }, relations: ['event', 'order'] });
    const finalEvent = await manager.findOne(ConfirmedEventEntity, { where: { id: eventId }, relations: ['eventData'] });
    if (!exact(persisted) || !finalEvent || finalEvent.status !== 'in-payment' ||
      finalEvent.eventData.txId !== observed.triggerTransactionId || finalEvent.eventData.identifier !== observed.triggerBoxId ||
      !isDeepStrictEqual(EventSerializer.fromConfirmedEntity(finalEvent), observed.event)) throw Error('readback failed');
    await fault?.('before-commit');
    if (!current()) throw Error('retired');
    await runner.query('COMMIT'); begun = false;
    return current();
  } catch { return false; }
  finally {
    if (begun && runner) { try { await runner.query('ROLLBACK'); } catch { /* no authority */ } }
    try { await runner?.release(); } catch { /* already fail closed on commit ambiguity */ }
    try { if (owned?.isInitialized) await owned.destroy(); } catch { /* dedicated connection only */ }
  }
}
