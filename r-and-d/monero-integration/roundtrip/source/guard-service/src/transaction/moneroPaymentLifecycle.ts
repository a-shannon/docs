import { createHash } from 'node:crypto';
import type { DataSource, EntityManager } from '@rosen-bridge/extended-typeorm';
import { TransactionEntity } from '../db/entities/transactionEntity';
import { ConfirmedEventEntity } from '../db/entities/confirmedEventEntity';

export interface MoneroFinal {
  readonly reservationId: string;
  readonly proposalId: string;
  readonly finalTxId: string;
  readonly byteDigest: string;
  readonly txBytes: Uint8Array;
  readonly spentInputs: readonly string[];
  readonly changeIdentity: string;
}
export interface MoneroObservation {
  readonly finalTxId: string;
  readonly blockHash?: string;
  readonly canonicalBlockHash?: string;
  readonly blockHeight?: number;
  readonly tipHeight: number;
  readonly recipientMatches: boolean;
  readonly recipientAtomic?: string;
  readonly changeAtomic?: string;
  readonly inPool: boolean;
}
export interface MoneroPaymentBinding {
  readonly reservationId: string;
  readonly proposalId: string;
  readonly obligationId: string;
  readonly eventId: string;
  readonly originalTxJson: string;
  readonly inputReferences: readonly string[];
  readonly changeIdentity: string;
  readonly requiredConfirmations: number;
  readonly recipientAtomic: string;
  readonly changeAtomic: string;
}
export interface MoneroLifecyclePorts {
  readonly dataSource: DataSource;
  readonly requiredConfirmations: number;
  /** Must verify the native final bytes against the durable signing journal. */
  readonly recoverFinal: (reservationId: string) => Promise<MoneroFinal>;
  /** Independent canonical node lookup and recipient scan, using the final hash. */
  readonly observe: (final: MoneroFinal) => Promise<MoneroObservation>;
  readonly submit: (final: MoneroFinal) => Promise<void>;
  readonly settlementFault?: () => void | Promise<void>;
}
type Disposition = {
  proposalId: string; obligationId: string; reservationId: string; eventId: string;
  originalTxJson: string; inputsJson: string; changeIdentity: string;
  requiredConfirmations: number; state: 'prepared' | 'possible-signing' | 'quarantined' | 'final' | 'settled';
  recipientAtomic: string; changeAtomic: string;
  finalTxId: string | null; byteDigest: string | null; bytesHex: string | null;
};
const queues = new WeakMap<DataSource, Promise<unknown>>();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hex64 = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const reference = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 4096;
const amount = (s: unknown, positive = false): s is string => typeof s === 'string' && /^(0|[1-9][0-9]*)$/.test(s) && s.length <= 20 && BigInt(s) <= 0xffffffffffffffffn && (!positive || BigInt(s) > 0n);

/** A scoped payment branch; durable JSON never recreates an approved signing capability. */
export class MoneroPaymentLifecycle {
  private readonly live = new Map<string, { sign: () => Promise<unknown> }>();
  private readonly ports: Readonly<MoneroLifecyclePorts>;
  private readonly schemas: readonly string[];
  constructor(ports: MoneroLifecyclePorts) {
    this.ports = Object.freeze({ ...ports });
    if (!Number.isSafeInteger(ports.requiredConfirmations) || ports.requiredConfirmations < 1) throw Error('payment:confirmation-policy');
    const txTable = ports.dataSource.getMetadata(TransactionEntity).tableName;
    const eventTable = ports.dataSource.getMetadata(ConfirmedEventEntity).tableName;
    if (![txTable, eventTable].every(s => /^[a-zA-Z0-9_]+$/.test(s))) throw Error('payment:table-name');
    this.schemas = [
      `CREATE TABLE monero_payment_disposition (proposalId TEXT PRIMARY KEY NOT NULL REFERENCES "${txTable}"(txId) ON DELETE RESTRICT, obligationId TEXT UNIQUE NOT NULL, reservationId TEXT UNIQUE NOT NULL, eventId TEXT UNIQUE NOT NULL REFERENCES "${eventTable}"(id) ON DELETE RESTRICT, originalTxJson TEXT NOT NULL, inputsJson TEXT NOT NULL, changeIdentity TEXT NOT NULL, requiredConfirmations INTEGER NOT NULL CHECK(requiredConfirmations>0), recipientAtomic TEXT NOT NULL, changeAtomic TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','possible-signing','quarantined','final','settled')), finalTxId TEXT UNIQUE, byteDigest TEXT, bytesHex TEXT, CHECK((state IN ('final','settled') AND finalTxId IS NOT NULL AND byteDigest IS NOT NULL AND bytesHex IS NOT NULL) OR (state IN ('prepared','possible-signing','quarantined') AND finalTxId IS NULL AND byteDigest IS NULL AND bytesHex IS NULL)))`,
      `CREATE TABLE monero_payment_input (inputReference TEXT PRIMARY KEY NOT NULL, proposalId TEXT NOT NULL REFERENCES monero_payment_disposition(proposalId) ON DELETE RESTRICT, state TEXT NOT NULL CHECK(state IN ('reserved','spent')))`,
      `CREATE TRIGGER monero_payment_immutable BEFORE UPDATE ON monero_payment_disposition WHEN OLD.proposalId<>NEW.proposalId OR OLD.obligationId<>NEW.obligationId OR OLD.reservationId<>NEW.reservationId OR OLD.eventId<>NEW.eventId OR OLD.originalTxJson<>NEW.originalTxJson OR OLD.inputsJson<>NEW.inputsJson OR OLD.changeIdentity<>NEW.changeIdentity OR OLD.requiredConfirmations<>NEW.requiredConfirmations OR OLD.recipientAtomic<>NEW.recipientAtomic OR OLD.changeAtomic<>NEW.changeAtomic OR (OLD.finalTxId IS NOT NULL AND (OLD.finalTxId IS NOT NEW.finalTxId OR OLD.byteDigest IS NOT NEW.byteDigest OR OLD.bytesHex IS NOT NEW.bytesHex)) OR NOT (OLD.state=NEW.state OR (OLD.state='prepared' AND NEW.state='possible-signing') OR (OLD.state='possible-signing' AND NEW.state IN ('quarantined','final')) OR (OLD.state='quarantined' AND NEW.state='final') OR (OLD.state='final' AND NEW.state='settled')) BEGIN SELECT RAISE(ABORT,'payment:immutable'); END`,
      `CREATE TRIGGER monero_payment_no_delete BEFORE DELETE ON monero_payment_disposition BEGIN SELECT RAISE(ABORT,'payment:no-delete'); END`,
      `CREATE TRIGGER monero_payment_input_immutable BEFORE UPDATE ON monero_payment_input WHEN OLD.inputReference<>NEW.inputReference OR OLD.proposalId<>NEW.proposalId OR NOT (OLD.state=NEW.state OR (OLD.state='reserved' AND NEW.state='spent')) BEGIN SELECT RAISE(ABORT,'payment:input-immutable'); END`,
      `CREATE TRIGGER monero_payment_input_no_delete BEFORE DELETE ON monero_payment_input BEGIN SELECT RAISE(ABORT,'payment:input-no-delete'); END`,
    ];
  }
  private queue<T>(run: () => Promise<T>): Promise<T> {
    const next = (queues.get(this.ports.dataSource) ?? Promise.resolve()).catch(() => undefined).then(run);
    queues.set(this.ports.dataSource, next); return next;
  }
  private async schema(manager: EntityManager, initialize = false) {
    await this.durability(manager);
    if ((await manager.query('PRAGMA foreign_keys'))[0].foreign_keys !== 1) throw Error('payment:foreign-keys');
    for (const sql of this.schemas) {
      const name = sql.split(' ')[2];
      let entries = await manager.query('SELECT sql FROM sqlite_master WHERE name=?', [name]);
      if (!entries.length && initialize) { await manager.query(sql); entries = await manager.query('SELECT sql FROM sqlite_master WHERE name=?', [name]); }
      if (entries.length !== 1 || entries[0].sql !== sql) throw Error('payment:schema-drift');
    }
    if ((await manager.query('PRAGMA foreign_key_check')).length) throw Error('payment:foreign-key-corruption');
  }
  private async durability(manager: EntityManager) {
    const databases = await manager.query('PRAGMA database_list');
    const main = databases.filter((db: any) => db.name === 'main');
    if (this.ports.dataSource.options.type !== 'sqlite' || main.length !== 1 || typeof main[0].file !== 'string' || !main[0].file || main[0].file === ':memory:') throw Error('payment:file-custody');
    if (![2,3].includes((await manager.query('PRAGMA main.synchronous'))[0].synchronous) || !['delete','truncate','persist','wal'].includes((await manager.query('PRAGMA main.journal_mode'))[0].journal_mode) || (await manager.query('PRAGMA read_uncommitted'))[0].read_uncommitted !== 0) throw Error('payment:durability-policy');
  }
  /** Acquire SQLite's writer fence before reading state, across DataSource identities. */
  private atomic<T>(tx: TransactionEntity, run: (manager: EntityManager, row: Disposition, fresh: TransactionEntity) => Promise<T>): Promise<T> {
    return this.ports.dataSource.transaction(async manager => {
      await this.schema(manager);
      await manager.query('UPDATE monero_payment_disposition SET state=state WHERE proposalId=?', [tx.txId]);
      if ((await manager.query('SELECT changes() AS n'))[0].n !== 1) throw Error('payment:missing-disposition');
      const fresh = await manager.findOneOrFail(TransactionEntity, { where: { txId: tx.txId }, relations: ['event'] });
      const row = await this.read(manager, fresh);
      if (fresh.txJson !== tx.txJson || fresh.chain !== tx.chain || fresh.type !== tx.type || fresh.event?.id !== tx.event?.id) throw Error('payment:proposal-drift');
      return run(manager, row, fresh);
    });
  }
  private async status(manager: EntityManager, fresh: TransactionEntity, next: string, lastCheck?: number) {
    const result = await manager.update(TransactionEntity, { txId: fresh.txId, status: fresh.status }, { status:next, ...(lastCheck === undefined ? {} : {lastCheck:Math.max(fresh.lastCheck,lastCheck)}) });
    if (result.affected !== 1) throw Error('payment:status-race');
  }
  initialize() { return this.queue(() => this.ports.dataSource.transaction(manager => this.schema(manager, true))); }
  private async read(manager: EntityManager, tx: TransactionEntity): Promise<Disposition> {
    await this.schema(manager);
    const rows = await manager.query('SELECT * FROM monero_payment_disposition WHERE proposalId=?', [tx.txId]);
    if (rows.length !== 1) throw Error('payment:missing-disposition');
    const row = rows[0] as Disposition;
    if (tx.chain !== 'monero' || tx.type !== 'payment' || tx.txJson !== row.originalTxJson || tx.event?.id !== row.eventId) throw Error('payment:proposal-drift');
    const current = await manager.findOneOrFail(TransactionEntity, { where: { txId: tx.txId }, relations: ['event'] });
    const statuses: Record<Disposition['state'], readonly string[]> = { prepared:['approved'], 'possible-signing':['in-sign'], quarantined:['sign-failed'], final:['signed','sent'], settled:['completed'] };
    if (!hex64(row.reservationId) || !reference(row.obligationId) || !reference(row.eventId) || !Object.hasOwn(statuses,row.state) || !statuses[row.state].includes(current.status) || current.chain !== tx.chain || current.type !== tx.type || current.txJson !== row.originalTxJson || current.event?.id !== row.eventId || (row.state !== 'settled' && current.event.status !== 'in-payment')) throw Error('payment:durable-state-drift');
    const inputs = JSON.parse(row.inputsJson) as string[];
    if (!Array.isArray(inputs) || !inputs.length || inputs.some(s => !reference(s)) || new Set(inputs).size !== inputs.length || JSON.stringify(inputs) !== row.inputsJson || !reference(row.changeIdentity) || row.requiredConfirmations !== this.ports.requiredConfirmations || !amount(row.recipientAtomic,true) || !amount(row.changeAtomic)) throw Error('payment:record-corruption');
    const held = await manager.query('SELECT inputReference,state FROM monero_payment_input WHERE proposalId=? ORDER BY inputReference', [tx.txId]);
    if (held.length !== inputs.length || held.some((r: any, i: number) => r.inputReference !== [...inputs].sort()[i] || r.state !== (row.state === 'settled' ? 'spent' : 'reserved'))) throw Error('payment:input-corruption');
    return row;
  }
  /** Caller supplies a locally approved opaque issuer; this API never approves DB JSON. */
  attachApproved(binding: MoneroPaymentBinding, capability: { sign: () => Promise<unknown> }) {
    const b = Object.freeze({ ...binding, inputReferences: Object.freeze([...binding.inputReferences]) });
    const sign = capability.sign.bind(capability);
    return this.queue(() => this.ports.dataSource.transaction(async manager => {
      await this.schema(manager);
      if (!hex64(b.reservationId) || !reference(b.proposalId) || !reference(b.obligationId) || !reference(b.eventId) || !reference(b.changeIdentity) || !b.inputReferences.length || b.inputReferences.some(s => !reference(s)) || new Set(b.inputReferences).size !== b.inputReferences.length || b.requiredConfirmations !== this.ports.requiredConfirmations || !amount(b.recipientAtomic,true) || !amount(b.changeAtomic)) throw Error('payment:binding-schema');
      const tx = await manager.findOne(TransactionEntity, { where: { txId: b.proposalId }, relations: ['event'] });
      if (!tx || tx.chain !== 'monero' || tx.type !== 'payment' || tx.status !== 'approved' || tx.txJson !== b.originalTxJson || tx.event?.id !== b.eventId || tx.event.status !== 'in-payment') throw Error('payment:unapproved-row');
      await manager.query("INSERT INTO monero_payment_disposition(proposalId,obligationId,reservationId,eventId,originalTxJson,inputsJson,changeIdentity,requiredConfirmations,recipientAtomic,changeAtomic,state) VALUES(?,?,?,?,?,?,?,?,?,?,'prepared')", [b.proposalId,b.obligationId,b.reservationId,b.eventId,b.originalTxJson,JSON.stringify(b.inputReferences),b.changeIdentity,b.requiredConfirmations,b.recipientAtomic,b.changeAtomic]);
      for (const input of b.inputReferences) await manager.query("INSERT INTO monero_payment_input VALUES(?,?,'reserved')", [input,b.proposalId]);
      await this.read(manager, tx);
    })).then(() => { this.live.set(b.proposalId, { sign }); });
  }
  private captureFinal(row: Disposition, raw: MoneroFinal): MoneroFinal {
    const bytes = Uint8Array.from(raw.txBytes), inputs = [...raw.spentInputs];
    if (raw.reservationId !== row.reservationId || raw.proposalId !== row.proposalId || !hex64(raw.finalTxId) || !hex64(raw.byteDigest) || !bytes.length || bytes.length > 16_000_000 || hash(bytes) !== raw.byteDigest || JSON.stringify(inputs) !== row.inputsJson || raw.changeIdentity !== row.changeIdentity) throw Error('payment:final-binding');
    const bytesHex = Buffer.from(bytes).toString('hex');
    if (row.finalTxId !== null && (row.finalTxId !== raw.finalTxId || row.byteDigest !== raw.byteDigest || row.bytesHex !== bytesHex)) throw Error('payment:final-drift');
    return Object.freeze({ reservationId: raw.reservationId, proposalId: raw.proposalId, finalTxId: raw.finalTxId, byteDigest: raw.byteDigest, get txBytes() { return Uint8Array.from(bytes); }, spentInputs: Object.freeze(inputs), changeIdentity: raw.changeIdentity });
  }
  async process(tx: TransactionEntity): Promise<void> {
    // Consume synchronously, before the first await or an overlapping processor run.
    const capability = this.live.get(tx.txId); this.live.delete(tx.txId);
    await this.queue(async () => {
      let row = await this.atomic(tx, async (_manager, checked) => checked);
      if (row.state === 'settled') return;
      if (row.state === 'prepared') {
        if (tx.status !== 'approved' || !capability) throw Error('payment:live-approval-required');
        const enteredSigning = await this.atomic(tx, async (manager, checked, fresh) => {
          if (checked.state !== 'prepared') return false;
          await manager.query("UPDATE monero_payment_disposition SET state='possible-signing' WHERE proposalId=? AND state='prepared'", [tx.txId]);
          if ((await manager.query('SELECT changes() AS n'))[0].n !== 1) throw Error('payment:sign-race');
          await this.status(manager, fresh, 'in-sign');
          return true;
        });
        try {
          if (enteredSigning) {
            await this.durability(this.ports.dataSource.manager);
            await capability.sign();
          }
        }
        catch {
          await this.atomic(tx, async (manager, checked, fresh) => {
            if (checked.state !== 'possible-signing') return;
            await manager.query("UPDATE monero_payment_disposition SET state='quarantined' WHERE proposalId=? AND state='possible-signing'", [tx.txId]);
            if ((await manager.query('SELECT changes() AS n'))[0].n !== 1) throw Error('payment:quarantine-race');
            await this.status(manager, fresh, 'sign-failed');
          });
        }
        row = await this.atomic(tx, async (_manager, checked) => checked);
        if (row.state === 'settled') return;
      }
      // Every submission and observation is anchored to newly recovered journal bytes.
      const final = this.captureFinal(row, await this.ports.recoverFinal(row.reservationId));
      const alreadySettled = await this.atomic(tx, async (manager, checked, fresh) => {
        this.captureFinal(checked, final);
        if (checked.state === 'settled') return true;
        if (checked.state === 'possible-signing' || checked.state === 'quarantined') {
          await manager.query("UPDATE monero_payment_disposition SET state='final',finalTxId=?,byteDigest=?,bytesHex=? WHERE proposalId=? AND state=?", [final.finalTxId,final.byteDigest,Buffer.from(final.txBytes).toString('hex'),tx.txId,checked.state]);
          if ((await manager.query('SELECT changes() AS n'))[0].n !== 1) throw Error('payment:final-race');
          await this.status(manager, fresh, 'signed');
        } else if (checked.state !== 'final') throw Error('payment:final-state');
        return false;
      });
      if (alreadySettled) return;
      const seen = Object.freeze({ ...await this.ports.observe(final) });
      if (seen.finalTxId !== final.finalTxId || !Number.isSafeInteger(seen.tipHeight) || seen.tipHeight < 0 || typeof seen.inPool !== 'boolean' || typeof seen.recipientMatches !== 'boolean') throw Error('payment:observation-schema');
      const mined = hex64(seen.blockHash) && seen.blockHash === seen.canonicalBlockHash && Number.isSafeInteger(seen.blockHeight) && seen.blockHeight! >= 0 && seen.tipHeight >= seen.blockHeight!;
      if (mined && seen.recipientMatches && seen.recipientAtomic === row.recipientAtomic && seen.changeAtomic === row.changeAtomic && seen.tipHeight - seen.blockHeight! + 1 >= this.ports.requiredConfirmations) {
        await this.atomic(tx, async (manager, checked, fresh) => {
          this.captureFinal(checked, final);
          if (checked.state === 'settled') return;
          if (checked.state !== 'final' || fresh.event!.status !== 'in-payment' || !['signed','sent'].includes(fresh.status)) throw Error('payment:settlement-state');
          await this.status(manager, fresh, 'completed', seen.tipHeight);
          await this.ports.settlementFault?.();
          await manager.update(ConfirmedEventEntity, { id: row.eventId }, { status: 'pending-reward', firstTry: null } as any);
          await manager.query("UPDATE monero_payment_input SET state='spent' WHERE proposalId=?", [tx.txId]);
          await manager.query("UPDATE monero_payment_disposition SET state='settled' WHERE proposalId=? AND state='final'", [tx.txId]);
          if ((await manager.query('SELECT changes() AS n'))[0].n !== 1) throw Error('payment:settlement-race');
        });
      } else {
        if (!mined && !seen.inPool) {
          const skip = await this.atomic(tx, async (_manager, checked) => {
            this.captureFinal(checked, final);
            if (checked.state === 'settled') return true;
            if (checked.state !== 'final') throw Error('payment:submission-state');
            return false;
          });
          if (skip) return;
          await this.ports.submit(final);
        }
        await this.atomic(tx, async (manager, checked, fresh) => {
          this.captureFinal(checked, final);
          if (checked.state === 'settled') return;
          if (checked.state !== 'final') throw Error('payment:observation-state');
          await this.status(manager, fresh, 'sent', seen.tipHeight);
        });
      }
    });
  }
}
