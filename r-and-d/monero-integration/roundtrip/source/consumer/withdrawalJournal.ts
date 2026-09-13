import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import type { ReservationRecord } from '../guard-service/src/db/moneroWithdrawalReservation';
import { ownData } from './approvalAuthority';
import { hex } from './codec';
import { positive } from './retainedCodec';

export type JournalState = 'prepared' | 'signing' | 'completed' | 'quarantined';
export type JournalFaultPoint = `${JournalState}-${'before' | 'after'}-commit`;
export type JournalFault = (point: JournalFaultPoint) => void | Promise<void>;
export interface WithdrawalJournalAnchor {
  readonly reservation: Readonly<ReservationRecord>;
  readonly requestDigest: string;
  readonly nativeDirectory: string;
  readonly descriptorDigest: string;
  readonly bindingDigest: string;
  readonly expectationDigest: string;
  readonly hostGeneration: string;
  readonly reservationGeneration: string;
  readonly backingDigest?: string;
}
export interface FinalWithdrawalRecord {
  readonly expectationDigest: string;
  readonly bindingDigest: string;
  readonly txId: string;
  readonly byteHash: string;
  readonly bytesHex: string;
}
export interface CompletedWithdrawal {
  readonly status: 'completed-retained-withdrawal';
  readonly reservationId: string;
  readonly requestDigest: string;
  readonly bindingDigest: string;
  readonly expectationDigest: string;
  readonly txId: string;
  readonly byteDigest: string;
  readonly txBytes: Uint8Array;
}
export interface JournalEntry {
  readonly state: JournalState;
  readonly anchor: Readonly<WithdrawalJournalAnchor>;
  readonly final: Readonly<FinalWithdrawalRecord> | null;
}
const table = `CREATE TABLE IF NOT EXISTS monero_withdrawal_signing_journal (
  reservationId TEXT PRIMARY KEY NOT NULL REFERENCES monero_withdrawal_reservation(reservationId) ON DELETE RESTRICT,
  requestDigest TEXT UNIQUE NOT NULL,
  anchorJson TEXT NOT NULL CHECK(length(anchorJson)<=196608),
  state TEXT NOT NULL CHECK(state IN ('prepared','signing','completed','quarantined')),
  finalJson TEXT CHECK(length(finalJson)<=20000),
  CHECK((state='completed' AND finalJson IS NOT NULL) OR (state!='completed' AND finalJson IS NULL)))`;
const immutable = `CREATE TRIGGER IF NOT EXISTS monero_withdrawal_journal_immutable BEFORE UPDATE ON monero_withdrawal_signing_journal
  WHEN OLD.reservationId<>NEW.reservationId OR OLD.requestDigest<>NEW.requestDigest OR OLD.anchorJson<>NEW.anchorJson OR
       NOT ((OLD.state='prepared' AND NEW.state IN ('signing','quarantined')) OR
            (OLD.state='signing' AND NEW.state IN ('completed','quarantined')))
  BEGIN SELECT RAISE(ABORT, 'immutable signing custody'); END`;
const noDelete = `CREATE TRIGGER IF NOT EXISTS monero_withdrawal_journal_no_delete BEFORE DELETE ON monero_withdrawal_signing_journal
  BEGIN SELECT RAISE(ABORT, 'retained signing custody'); END`;
function captureAnchor(value: WithdrawalJournalAnchor): Readonly<WithdrawalJournalAnchor> {
  const x = ownData(value), keys = ['reservation', 'requestDigest', 'nativeDirectory', 'descriptorDigest', 'bindingDigest', 'expectationDigest', 'hostGeneration', 'reservationGeneration'];
  if (Object.hasOwn(x, 'backingDigest')) { keys.push('backingDigest'); hex(x.backingDigest as string, 32, 32); }
  if (Object.keys(x).length !== keys.length || keys.some(k => !Object.hasOwn(x, k))) throw Error('journal:anchor-schema');
  for (const k of ['requestDigest', 'descriptorDigest', 'bindingDigest', 'expectationDigest']) hex(x[k] as string, 32, 32);
  positive(x.hostGeneration as string); positive(x.reservationGeneration as string);
  if (typeof x.nativeDirectory !== 'string' || x.nativeDirectory.length > 4096 || !isAbsolute(x.nativeDirectory) || /[\x00-\x1f]/.test(x.nativeDirectory)) throw Error('journal:directory');
  const r = ownData(x.reservation);
  const recordKeys = ['sourceNetwork', 'network', 'vaultSpend', 'vaultView', 'reservationId', 'reservationHash', 'requestJson', 'selectionBytes', 'eventId', 'state', 'owner', 'generation', 'leaseUntil', 'receipt', 'receiptHash'];
  if (Object.keys(r).length !== recordKeys.length || recordKeys.some(k => !Object.hasOwn(r, k)) || r.state !== 'completed' || !r.receipt || typeof r.requestJson !== 'string' || typeof r.selectionBytes !== 'string' || r.generation !== x.reservationGeneration) throw Error('journal:reservation');
  for (const k of ['reservationId', 'reservationHash', 'eventId', 'owner', 'vaultSpend', 'vaultView', 'receiptHash']) hex(r[k] as string, 32, 32);
  positive(r.generation as string); positive(r.leaseUntil as string);
  const receipt = ownData(r.receipt);
  if (Object.values(receipt).some(v => typeof v !== 'string' && typeof v !== 'number') || createHash('sha256').update(JSON.stringify(receipt)).digest('hex') !== r.receiptHash) throw Error('journal:receipt');
  const request = JSON.parse(r.requestJson) as { requestDigest?: unknown };
  if (request.requestDigest !== x.requestDigest) throw Error('journal:request');
  r.receipt = Object.freeze({ ...receipt });
  const captured = Object.freeze({ ...x, reservation: Object.freeze({ ...r }) }) as unknown as Readonly<WithdrawalJournalAnchor>;
  if (JSON.stringify(captured).length > 196608) throw Error('journal:anchor-size');
  return captured;
}
export function validateFinalRecord(value: FinalWithdrawalRecord, anchor: Readonly<WithdrawalJournalAnchor>): Readonly<FinalWithdrawalRecord> {
  const x = ownData(value), keys = ['expectationDigest', 'bindingDigest', 'txId', 'byteHash', 'bytesHex'];
  if (Object.keys(x).length !== keys.length || keys.some(k => !Object.hasOwn(x, k))) throw Error('journal:final-schema');
  for (const k of ['expectationDigest', 'bindingDigest', 'txId', 'byteHash']) hex(x[k] as string, 32, 32);
  const bytes = hex(x.bytesHex as string, 9408);
  if (x.expectationDigest !== anchor.expectationDigest || x.bindingDigest !== anchor.bindingDigest || createHash('sha256').update(bytes).digest('hex') !== x.byteHash) throw Error('journal:final-binding');
  return Object.freeze({ ...x }) as unknown as Readonly<FinalWithdrawalRecord>;
}
export function completedWithdrawal(anchor: Readonly<WithdrawalJournalAnchor>, final: Readonly<FinalWithdrawalRecord>): Readonly<CompletedWithdrawal> {
  const validated = validateFinalRecord(final, anchor), bytes = Buffer.from(validated.bytesHex, 'hex');
  return Object.freeze({ status: 'completed-retained-withdrawal' as const, reservationId: anchor.reservation.reservationId, requestDigest: anchor.requestDigest, bindingDigest: anchor.bindingDigest, expectationDigest: anchor.expectationDigest, txId: validated.txId, byteDigest: validated.byteHash, get txBytes() { return Uint8Array.from(bytes); } });
}

/** Durable custody only. This journal never grants a live native signing capability. */
export class WithdrawalJournal {
  #tail: Promise<unknown> = Promise.resolve();
  #closing = false;
  #poisoned = false;
  private constructor(readonly database: string, private readonly db: DataSource, private readonly fault?: JournalFault) {}
  static async open(database: string, fault?: JournalFault) {
    if (typeof database !== 'string' || !isAbsolute(database) || database.includes(':memory:') || (fault !== undefined && typeof fault !== 'function')) throw Error('journal:database');
    const db = new DataSource({ type: 'sqlite', database, synchronize: false, cache: false, busyErrorRetry: 0, logging: false });
    try {
      await db.initialize();
      for (const sql of ['PRAGMA synchronous=FULL', 'PRAGMA foreign_keys=ON', 'PRAGMA read_uncommitted=OFF', 'PRAGMA busy_timeout=0']) await db.query(sql);
      if ((await db.query('PRAGMA synchronous'))[0].synchronous !== 2 || (await db.query('PRAGMA foreign_keys'))[0].foreign_keys !== 1 || (await db.query('PRAGMA read_uncommitted'))[0].read_uncommitted !== 0 || (await db.query('PRAGMA busy_timeout'))[0].timeout !== 0) throw Error('journal:durability');
      if (!['delete', 'truncate', 'persist', 'wal'].includes((await db.query('PRAGMA journal_mode'))[0].journal_mode)) throw Error('journal:journal-mode');
      await db.query(table);
      const expectedSql = table.replace('IF NOT EXISTS ', '');
      if ((await db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='monero_withdrawal_signing_journal'"))[0]?.sql !== expectedSql) throw Error('journal:schema');
      await db.query(immutable);
      if ((await db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='monero_withdrawal_journal_immutable'"))[0]?.sql !== immutable.replace('IF NOT EXISTS ', '')) throw Error('journal:trigger-schema');
      await db.query(noDelete);
      if ((await db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='monero_withdrawal_journal_no_delete'"))[0]?.sql !== noDelete.replace('IF NOT EXISTS ', '')) throw Error('journal:delete-schema');
      return new WithdrawalJournal(database, db, fault);
    } catch { if (db.isInitialized) await db.destroy(); throw Error('journal:open-failed'); }
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(Error('journal:closed'));
    const result = this.#tail.then(() => { if (this.#poisoned) throw Error('journal:indeterminate'); return operation(); });
    this.#tail = result.catch(() => undefined); return result;
  }
  private async transaction<T>(operation: () => Promise<T>, next?: JournalState): Promise<T> {
    let begun = false, committing = false, committed = false;
    try {
      await this.db.query('BEGIN IMMEDIATE'); begun = true;
      const result = await operation();
      if (next) await this.fault?.(`${next}-before-commit`);
      committing = true; await this.db.query('COMMIT'); begun = false; committed = true;
      if (next) await this.fault?.(`${next}-after-commit`);
      return result;
    } catch {
      if (begun) { try { await this.db.query('ROLLBACK'); } catch { this.#poisoned = true; } }
      if (committing && !committed) this.#poisoned = true;
      throw Error(committed ? 'journal:ack-failed-after-commit' : committing ? 'journal:commit-indeterminate' : 'journal:transaction-rejected');
    }
  }
  private async original(anchor: Readonly<WithdrawalJournalAnchor>) {
    const rows = await this.db.query('SELECT * FROM monero_withdrawal_reservation WHERE reservationId=?', [anchor.reservation.reservationId]);
    if (rows.length !== 1) throw Error('journal:missing-reservation');
    const row = rows[0], r = anchor.reservation;
    for (const key of Object.keys(r)) {
      if (key === 'receipt') { if (row.receiptJson !== JSON.stringify(r.receipt)) throw Error('journal:reservation-changed'); }
      else if (row[key] !== r[key as keyof ReservationRecord]) throw Error('journal:reservation-changed');
    }
    const identity = await this.db.query('SELECT sourceNetwork,network,vaultSpend,vaultView FROM monero_withdrawal_identity WHERE singleton=1');
    if (identity.length !== 1 || Object.keys(identity[0]).some(k => identity[0][k] !== r[k as keyof ReservationRecord])) throw Error('journal:identity-changed');
  }
  private async entry(reservationId: string): Promise<Readonly<JournalEntry>> {
    hex(reservationId, 32, 32);
    const rows = await this.db.query('SELECT * FROM monero_withdrawal_signing_journal WHERE reservationId=?', [reservationId]);
    if (rows.length !== 1 || typeof rows[0].anchorJson !== 'string' || rows[0].anchorJson.length > 196608) throw Error('journal:missing-anchor');
    const row = rows[0], anchor = captureAnchor(JSON.parse(row.anchorJson));
    if (anchor.reservation.reservationId !== reservationId || anchor.requestDigest !== row.requestDigest || JSON.stringify(anchor) !== row.anchorJson || !['prepared', 'signing', 'completed', 'quarantined'].includes(row.state)) throw Error('journal:corrupt-anchor');
    await this.original(anchor);
    let final: Readonly<FinalWithdrawalRecord> | null = null;
    if (row.state === 'completed') {
      if (typeof row.finalJson !== 'string' || row.finalJson.length > 20000) throw Error('journal:corrupt-final');
      final = validateFinalRecord(JSON.parse(row.finalJson), anchor);
      if (JSON.stringify(final) !== row.finalJson) throw Error('journal:corrupt-final');
    } else if (row.finalJson !== null) throw Error('journal:corrupt-state');
    return Object.freeze({ state: row.state as JournalState, anchor, final });
  }
  read(reservationId: string) { return this.queue(() => this.transaction(() => this.entry(reservationId))); }
  readIfPresent(reservationId: string) {
    hex(reservationId, 32, 32);
    return this.queue(() => this.transaction(async () => {
      const rows = await this.db.query('SELECT 1 FROM monero_withdrawal_signing_journal WHERE reservationId=?', [reservationId]);
      return rows.length ? this.entry(reservationId) : null;
    }));
  }
  readByRequestDigest(requestDigest: string) {
    hex(requestDigest, 32, 32);
    return this.queue(() => this.transaction(async () => {
      const rows = await this.db.query('SELECT reservationId FROM monero_withdrawal_signing_journal WHERE requestDigest=?', [requestDigest]);
      if (rows.length > 1) throw Error('journal:duplicate-request');
      const entry = rows.length ? await this.entry(rows[0].reservationId) : null;
      if (entry && entry.anchor.requestDigest !== requestDigest) throw Error('journal:request-lookup');
      return entry;
    }));
  }
  prepare(value: WithdrawalJournalAnchor) {
    const anchor = captureAnchor(value);
    return this.queue(() => this.transaction(async () => {
      await this.original(anchor);
      await this.db.query("INSERT INTO monero_withdrawal_signing_journal(reservationId,requestDigest,anchorJson,state,finalJson) VALUES(?, ?, ?,'prepared',NULL)", [anchor.reservation.reservationId, anchor.requestDigest, JSON.stringify(anchor)]);
      const result = await this.entry(anchor.reservation.reservationId);
      if (result.state !== 'prepared') throw Error('journal:prepare-readback');
      return result;
    }, 'prepared'));
  }
  markSigning(reservationId: string) {
    return this.queue(() => this.transaction(async () => {
      const previous = await this.entry(reservationId); if (previous.state !== 'prepared') throw Error('journal:signing-used');
      await this.db.query("UPDATE monero_withdrawal_signing_journal SET state='signing' WHERE reservationId=? AND state='prepared' AND anchorJson=?", [reservationId, JSON.stringify(previous.anchor)]);
      if ((await this.db.query('SELECT changes() AS n'))[0].n !== 1) throw Error('journal:signing-race');
      const result = await this.entry(reservationId); if (result.state !== 'signing') throw Error('journal:signing-readback'); return result;
    }, 'signing'));
  }
  complete(reservationId: string, value: FinalWithdrawalRecord) {
    const captured = Object.freeze({ ...ownData(value) }) as unknown as FinalWithdrawalRecord;
    return this.queue(() => this.transaction(async () => {
      const previous = await this.entry(reservationId), final = validateFinalRecord(captured, previous.anchor);
      if (previous.state === 'completed') {
        if (JSON.stringify(previous.final) !== JSON.stringify(final)) throw Error('journal:completed-immutable');
        return completedWithdrawal(previous.anchor, final);
      }
      if (previous.state !== 'signing') throw Error('journal:not-signing');
      await this.db.query("UPDATE monero_withdrawal_signing_journal SET state='completed',finalJson=? WHERE reservationId=? AND state='signing' AND anchorJson=?", [JSON.stringify(final), reservationId, JSON.stringify(previous.anchor)]);
      if ((await this.db.query('SELECT changes() AS n'))[0].n !== 1) throw Error('journal:completion-race');
      const result = await this.entry(reservationId); if (result.state !== 'completed' || JSON.stringify(result.final) !== JSON.stringify(final)) throw Error('journal:completion-readback');
      return completedWithdrawal(result.anchor, final);
    }, 'completed'));
  }
  quarantine(reservationId: string) {
    return this.queue(() => this.transaction(async () => {
      const previous = await this.entry(reservationId);
      if (previous.state === 'quarantined') return;
      if (previous.state === 'completed') throw Error('journal:completed-immutable');
      await this.db.query("UPDATE monero_withdrawal_signing_journal SET state='quarantined' WHERE reservationId=? AND state IN ('prepared','signing') AND anchorJson=?", [reservationId, JSON.stringify(previous.anchor)]);
      if ((await this.db.query('SELECT changes() AS n'))[0].n !== 1) throw Error('journal:quarantine-race');
    }, 'quarantined'));
  }
  close(): Promise<void> {
    if (this.#closing) return this.#tail.then(() => undefined);
    this.#closing = true; const result = this.#tail.then(() => this.db.destroy()); this.#tail = result; return result;
  }
}
