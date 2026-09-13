import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { DataSource, type QueryRunner } from '@rosen-bridge/extended-typeorm';

import {
  captureUnapprovedMoneroPayoutRequest,
  type UnapprovedNativeIntentCheck,
} from '../withdrawal/moneroWithdrawalNativeProjection';
import {
  decodeNativeSelection,
  validateConstructionReceipt,
} from '../withdrawal/moneroWithdrawalSelection';
import { Migration1789499200000 } from './migrations/moneroWithdrawal/sqlite/1789499200000-migration';
import { Migration1789499300000 } from './migrations/moneroWithdrawal/sqlite/1789499300000-migration';

export interface MoneroReservationIdentity {
  readonly sourceNetwork: string;
  readonly network: 'mainnet' | 'testnet' | 'stagenet';
  readonly vaultSpend: string;
  readonly vaultView: string;
}
export interface ReservationRecord extends MoneroReservationIdentity {
  readonly reservationId: string;
  readonly reservationHash: string;
  readonly requestJson: string;
  readonly selectionBytes: string;
  readonly eventId: string;
  readonly state: 'reserved' | 'claimed' | 'completed';
  readonly owner: string;
  readonly generation: string;
  readonly leaseUntil: string;
  readonly receipt: Readonly<UnapprovedNativeIntentCheck> | null;
  readonly receiptHash: string | null;
}
export type ReservationFailure = {
  status:
    | 'conflict'
    | 'rejected'
    | 'indeterminate'
    | 'busy'
    | 'stale'
    | 'missing';
  reason: string;
};
export type ReservationResult =
  | { status: 'created' | 'existing'; reservation: Readonly<ReservationRecord> }
  | ReservationFailure;
/** Only the originating instance can resolve this object's private association. */
export type ReservationFence = Readonly<object>;
export type ReservationCompletion =
  | { status: 'completed'; reservation: Readonly<ReservationRecord> }
  | ReservationFailure;
export type ReservationClaim =
  | { status: 'claimed'; fence: ReservationFence }
  | ReservationCompletion;
export type ReservationFaultPoint =
  | 'reserve-before-commit'
  | 'reserve-after-commit'
  | 'claim-before-commit'
  | 'claim-after-commit'
  | 'construct-before-commit'
  | 'construct-after-commit';
type Fault = (point: ReservationFaultPoint) => void | Promise<void>;
type Projection = Awaited<
  ReturnType<typeof captureUnapprovedMoneroPayoutRequest>
>;
type Selection = ReturnType<typeof decodeNativeSelection>;
interface FenceData {
  reservationId: string;
  reservationHash: string;
  owner: string;
  generation: string;
  leaseUntil: string;
  used: boolean;
}
const MAX = (1n << 64n) - 1n;
const token = Symbol('owned-monero-withdrawal-registry');
class Invalid extends Error {}
class Conflict extends Error {}
class Stale extends Error {}
const hash = (parts: readonly string[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const idFor = (p: Projection) =>
  hash([
    'rosen-monero-withdrawal-event-v1',
    'ergo',
    p.sourceNetwork,
    p.eventId,
  ]);
const hashFor = (json: string, selection: string) =>
  hash(['rosen-monero-withdrawal-reservation-v1', json, selection]);
const hex = (value: unknown) =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function integer(value: unknown): bigint {
  if (
    typeof value !== 'string' ||
    value.length > 20 ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > MAX
  )
    throw new Invalid('integer:u64');
  return BigInt(value);
}
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    throw new Invalid('identity:schema');
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      throw new Invalid('identity:schema');
    result[key] = descriptor.value;
  }
  return result;
}
const failure = (error: unknown): ReservationFailure => ({
  status:
    error instanceof Stale
      ? 'stale'
      : error instanceof Invalid
        ? 'rejected'
        : error instanceof Conflict || /SQLITE_CONSTRAINT/.test(String(error))
          ? 'conflict'
          : 'indeterminate',
  reason: error instanceof Error ? error.message : 'storage:failure',
});

/** Local exclusion and trusted in-process construction only; no signing authority. */
export class MoneroWithdrawalReservation {
  readonly #db: DataSource;
  readonly #fences = new WeakMap<object, FenceData>();
  #tail: Promise<unknown> = Promise.resolve();
  #closing = false;
  #poisoned = false;
  private constructor(
    owner: symbol,
    db: DataSource,
    readonly identity: Readonly<MoneroReservationIdentity>,
    private readonly clock: () => bigint,
    private readonly fault?: Fault,
  ) {
    if (owner !== token) throw Error('Use owned connection factory');
    this.#db = db;
  }
  /** Initialize migrations under one startup owner before starting other workers. */
  static async open(
    database: string,
    identity: MoneroReservationIdentity,
    clock: () => bigint,
    fault?: Fault,
  ) {
    if (
      typeof database !== 'string' ||
      !isAbsolute(database) ||
      database === ':memory:' ||
      typeof clock !== 'function'
    )
      throw new Invalid('database:absolute-file');
    const copy = exact(identity, [
      'sourceNetwork',
      'network',
      'vaultSpend',
      'vaultView',
    ]);
    if (
      typeof copy.sourceNetwork !== 'string' ||
      !/^[a-zA-Z0-9._:-]{1,128}$/.test(copy.sourceNetwork) ||
      !['mainnet', 'testnet', 'stagenet'].includes(copy.network as string) ||
      !hex(copy.vaultSpend) ||
      !hex(copy.vaultView)
    )
      throw new Invalid('identity:values');
    const captured = Object.freeze(
      copy,
    ) as unknown as Readonly<MoneroReservationIdentity>;
    const db = new DataSource({
      type: 'sqlite',
      database,
      synchronize: false,
      migrationsTableName: 'monero_withdrawal_migrations',
      migrations: [Migration1789499200000, Migration1789499300000],
    });
    try {
      await db.initialize();
      for (const statement of [
        'PRAGMA synchronous=FULL',
        'PRAGMA foreign_keys=ON',
        'PRAGMA read_uncommitted=OFF',
        'PRAGMA busy_timeout=1000',
      ])
        await db.query(statement);
      if (
        (await db.query('PRAGMA synchronous'))[0].synchronous !== 2 ||
        (await db.query('PRAGMA foreign_keys'))[0].foreign_keys !== 1 ||
        (await db.query('PRAGMA read_uncommitted'))[0].read_uncommitted !== 0 ||
        (await db.query('PRAGMA busy_timeout'))[0].timeout !== 1000
      )
        throw Error('storage:durability-settings');
      await db.runMigrations();
      const registry = new MoneroWithdrawalReservation(
        token,
        db,
        captured,
        clock,
        fault,
      );
      await registry.transaction(async (runner) => {
        const existing = await runner.query(
          'SELECT * FROM monero_withdrawal_identity',
        );
        if (
          !existing.length &&
          (
            await runner.query(
              'SELECT 1 FROM monero_withdrawal_reservation LIMIT 1',
            )
          ).length
        )
          throw new Conflict('identity:missing-with-history');
        await runner.query(
          'INSERT OR IGNORE INTO monero_withdrawal_identity VALUES (1,?,?,?,?,?)',
          [
            captured.sourceNetwork,
            captured.network,
            captured.vaultSpend,
            captured.vaultView,
            '0',
          ],
        );
        await registry.checkIdentity(runner);
      }, true);
      return registry;
    } catch (error) {
      if (db.isInitialized) await db.destroy();
      throw error;
    }
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(Error('registry:closing'));
    const result = this.#tail.then(() => {
      if (this.#poisoned) throw Error('registry:connection-indeterminate');
      return operation();
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  close(): Promise<void> {
    if (this.#closing) return this.#tail.then(() => undefined);
    this.#closing = true;
    const result = this.#tail.then(() => this.#db.destroy());
    this.#tail = result;
    return result;
  }
  private async transaction<T>(
    operation: (runner: QueryRunner) => Promise<T>,
    retry: boolean,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const runner = this.#db.createQueryRunner();
      let committed = false;
      let committing = false;
      try {
        await runner.connect();
        await runner.startTransaction('SERIALIZABLE');
        // The first read is preceded by an actual SQLite writer arbitration point.
        await runner.query(
          'UPDATE monero_withdrawal_identity SET singleton=singleton WHERE singleton=1',
        );
        const result = await operation(runner);
        committing = true;
        await runner.commitTransaction();
        committed = true;
        return result;
      } catch (error) {
        if (!committed && runner.isTransactionActive) {
          try {
            await runner.rollbackTransaction();
          } catch {
            this.#poisoned = true;
            throw Error('registry:rollback-failed-connection-indeterminate');
          }
        }
        if (
          !retry ||
          committing ||
          attempt >= 5 ||
          !/SQLITE_BUSY/.test(String(error))
        )
          throw error;
      } finally {
        await runner.release();
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  private async checkIdentity(runner: QueryRunner): Promise<string> {
    const rows = await runner.query('SELECT * FROM monero_withdrawal_identity');
    const r = rows[0];
    if (
      rows.length !== 1 ||
      r.singleton !== 1 ||
      r.sourceNetwork !== this.identity.sourceNetwork ||
      r.network !== this.identity.network ||
      r.vaultSpend !== this.identity.vaultSpend ||
      r.vaultView !== this.identity.vaultView
    )
      throw new Conflict('identity:mismatch');
    integer(r.lastNow);
    return r.lastNow;
  }
  private async time(runner: QueryRunner): Promise<bigint> {
    const previous = integer(await this.checkIdentity(runner));
    const now = this.clock();
    if (typeof now !== 'bigint' || now < 0n || now > MAX || now < previous)
      throw new Invalid('clock:invalid-or-backward');
    await runner.query(
      'UPDATE monero_withdrawal_identity SET lastNow=? WHERE singleton=1 AND lastNow=?',
      [now.toString(), previous.toString()],
    );
    await this.changed(runner);
    return now;
  }
  private bind(p: Projection, s: Selection): void {
    if (
      p.sourceNetwork !== this.identity.sourceNetwork ||
      p.network !== this.identity.network ||
      s.network !== this.identity.network ||
      s.vaultSpend !== this.identity.vaultSpend ||
      s.vaultView !== this.identity.vaultView
    )
      throw new Conflict('reservation:identity');
  }
  private ownership(id: string, s: Selection, ordinal: number) {
    const input = s.inputs[ordinal];
    return {
      reservationId: id,
      ordinal,
      network: s.network,
      publicKey: input.publicKey,
      txid: input.txid,
      outputIndex: input.outputIndex,
      globalIndex: input.globalIndex,
      amount: input.amount,
      commitment: input.commitment,
    };
  }
  private async load(
    runner: QueryRunner,
    id: string,
  ): Promise<Readonly<ReservationRecord> | undefined> {
    await this.checkIdentity(runner);
    const rows = await runner.query(
      'SELECT * FROM monero_withdrawal_reservation WHERE reservationId=?',
      [id],
    );
    if (!rows.length) return undefined;
    const r = rows[0];
    const p = await captureUnapprovedMoneroPayoutRequest(
      JSON.parse(r.requestJson),
    );
    const s = decodeNativeSelection(r.selectionBytes);
    this.bind(p, s);
    if (
      r.requestJson !== JSON.stringify(p.request) ||
      r.selectionBytes !== s.bytes ||
      r.reservationId !== idFor(p) ||
      r.reservationId !== id ||
      r.reservationHash !== hashFor(r.requestJson, s.bytes) ||
      r.eventId !== p.eventId ||
      r.sourceNetwork !== p.sourceNetwork ||
      r.network !== s.network ||
      r.vaultSpend !== s.vaultSpend ||
      r.vaultView !== s.vaultView
    )
      throw new Conflict('reservation:corrupt-binding');
    const owned = await runner.query(
      'SELECT reservationId,ordinal,network,publicKey,txid,outputIndex,globalIndex,amount,commitment FROM monero_withdrawal_output WHERE reservationId=? ORDER BY ordinal',
      [id],
    );
    if (
      JSON.stringify(owned) !==
      JSON.stringify(
        s.inputs.map((_, ordinal) => this.ownership(id, s, ordinal)),
      )
    )
      throw new Conflict('reservation:incomplete-ownership');
    const generation = integer(r.generation);
    const lease = integer(r.leaseUntil);
    if (r.state === 'reserved') {
      if (
        r.owner !== '' ||
        generation !== 0n ||
        lease !== 0n ||
        r.receiptJson !== null ||
        r.receiptHash !== null
      )
        throw new Conflict('reservation:corrupt-state');
    } else if (r.state === 'claimed' || r.state === 'completed') {
      if (
        !hex(r.owner) ||
        generation === 0n ||
        lease === 0n ||
        (r.state === 'claimed' &&
          (r.receiptJson !== null || r.receiptHash !== null))
      )
        throw new Conflict('reservation:corrupt-state');
    } else throw new Conflict('reservation:corrupt-state');
    let receipt: Readonly<UnapprovedNativeIntentCheck> | null = null;
    if (r.state === 'completed') {
      if (
        typeof r.receiptJson !== 'string' ||
        !hex(r.receiptHash) ||
        createHash('sha256').update(r.receiptJson).digest('hex') !==
          r.receiptHash
      )
        throw new Conflict('reservation:corrupt-receipt-hash');
      receipt = Object.freeze(
        validateConstructionReceipt(
          JSON.parse(r.receiptJson),
          p,
          s.inputs.length,
        ),
      );
      if (JSON.stringify(receipt) !== r.receiptJson)
        throw new Conflict('reservation:corrupt-receipt');
    }
    const record = { ...r };
    delete record.receiptJson;
    return Object.freeze({ ...record, receipt }) as Readonly<ReservationRecord>;
  }
  private async changed(runner: QueryRunner): Promise<void> {
    if ((await runner.query('SELECT changes() AS n'))[0].n !== 1)
      throw new Stale('state:cas');
  }
  reserve(
    requestValue: unknown,
    selectionBytes: string,
  ): Promise<ReservationResult> {
    // Capture at invocation, before joining the connection queue or yielding to callers.
    const captured = captureUnapprovedMoneroPayoutRequest(requestValue);
    void captured.catch(() => undefined);
    let selection: Selection;
    try {
      selection = decodeNativeSelection(selectionBytes);
    } catch (error) {
      void captured.catch(() => undefined);
      return Promise.resolve({ status: 'rejected', reason: String(error) });
    }
    return this.queue(async () => {
      try {
        const p = await captured.catch((error) => {
          throw new Invalid(String(error));
        });
        this.bind(p, selection);
        const requestJson = JSON.stringify(p.request);
        const id = idFor(p);
        const digest = hashFor(requestJson, selection.bytes);
        const result = await this.transaction<ReservationResult>(
          async (runner) => {
            const previous = await this.load(runner, id);
            if (previous) {
              if (
                previous.reservationHash !== digest ||
                previous.requestJson !== requestJson ||
                previous.selectionBytes !== selection.bytes
              )
                throw new Conflict('reservation:event-already-owned');
              return { status: 'existing', reservation: previous };
            }
            await runner.query(
              `INSERT INTO monero_withdrawal_reservation VALUES (?,?,?,?,?,?,?,?,?,'reserved','','0','0',NULL,NULL)`,
              [
                id,
                digest,
                requestJson,
                selection.bytes,
                p.eventId,
                p.sourceNetwork,
                selection.network,
                selection.vaultSpend,
                selection.vaultView,
              ],
            );
            for (
              let ordinal = 0;
              ordinal < selection.inputs.length;
              ordinal++
            ) {
              const output = this.ownership(id, selection, ordinal);
              await runner.query(
                'INSERT INTO monero_withdrawal_output VALUES (?,?,?,?,?,?,?,?,?)',
                Object.values(output),
              );
            }
            const reservation = (await this.load(runner, id))!;
            await this.fault?.('reserve-before-commit');
            return { status: 'created', reservation };
          },
          true,
        );
        if (result.status === 'created')
          await this.fault?.('reserve-after-commit');
        return result;
      } catch (error) {
        return failure(error);
      }
    });
  }
  read(
    reservationId: string,
  ): Promise<Readonly<ReservationRecord> | undefined> {
    return this.queue(async () => {
      if (!hex(reservationId)) throw new Invalid('reservation:id');
      return this.transaction(
        (runner) => this.load(runner, reservationId),
        true,
      );
    });
  }
  claim(
    reservationId: string,
    owner: string,
    leaseDuration: bigint,
  ): Promise<ReservationClaim> {
    return this.queue(async () => {
      try {
        if (
          !hex(reservationId) ||
          !hex(owner) ||
          typeof leaseDuration !== 'bigint' ||
          leaseDuration <= 0n ||
          leaseDuration > MAX
        )
          throw new Invalid('claim:arguments');
        const result = await this.transaction<
          ReservationCompletion | FenceData
        >(async (runner) => {
          const r = await this.load(runner, reservationId);
          if (!r) return { status: 'missing', reason: 'reservation:missing' };
          if (r.state === 'completed')
            return { status: 'completed', reservation: r };
          const now = await this.time(runner);
          if (r.state === 'claimed' && now < integer(r.leaseUntil))
            return { status: 'busy', reason: 'claim:active' };
          const generation = integer(r.generation) + 1n;
          const until = now + leaseDuration;
          if (generation > MAX || until > MAX)
            throw new Invalid('claim:overflow');
          await runner.query(
            "UPDATE monero_withdrawal_reservation SET state='claimed',owner=?,generation=?,leaseUntil=? WHERE reservationId=? AND reservationHash=? AND state=? AND generation=?",
            [
              owner,
              generation.toString(),
              until.toString(),
              r.reservationId,
              r.reservationHash,
              r.state,
              r.generation,
            ],
          );
          await this.changed(runner);
          const next = (await this.load(runner, reservationId))!;
          if (
            next.owner !== owner ||
            next.generation !== generation.toString() ||
            next.leaseUntil !== until.toString() ||
            next.state !== 'claimed'
          )
            throw new Stale('claim:reread');
          await this.fault?.('claim-before-commit');
          if ((await this.time(runner)) >= until)
            throw new Stale('claim:expired');
          return {
            reservationId,
            reservationHash: r.reservationHash,
            owner,
            generation: next.generation,
            leaseUntil: next.leaseUntil,
            used: false,
          };
        }, true);
        if ('status' in result) return result;
        await this.fault?.('claim-after-commit');
        const fence = Object.freeze({});
        this.#fences.set(fence, result);
        return { status: 'claimed', fence };
      } catch (error) {
        return failure(error);
      }
    });
  }
  construct(
    fence: ReservationFence,
    callback: (
      reservation: Readonly<ReservationRecord>,
    ) => Promise<UnapprovedNativeIntentCheck>,
  ): Promise<ReservationCompletion> {
    return this.queue(async () => {
      try {
        const data = this.#fences.get(fence);
        if (!data || typeof callback !== 'function')
          throw new Stale('construction:capability');
        // No retry at any point: an external constructor may already have run.
        const result = await this.transaction<ReservationCompletion>(
          async (runner) => {
            const r = await this.load(runner, data.reservationId);
            if (
              !r ||
              r.reservationHash !== data.reservationHash ||
              r.owner !== data.owner ||
              r.generation !== data.generation ||
              r.leaseUntil !== data.leaseUntil
            )
              throw new Stale('construction:fence');
            if (r.state === 'completed')
              return { status: 'completed', reservation: r };
            const p = await captureUnapprovedMoneroPayoutRequest(
              JSON.parse(r.requestJson),
            );
            if (
              data.used ||
              r.state !== 'claimed' ||
              (await this.time(runner)) >= integer(data.leaseUntil)
            )
              throw new Stale('construction:expired-or-used');
            const inputCount = decodeNativeSelection(r.selectionBytes).inputs
              .length;
            data.used = true;
            const raw = await callback(r);
            // Capture the callback result before another asynchronous boundary.
            const receipt = validateConstructionReceipt(raw, p, inputCount);
            const receiptJson = JSON.stringify(receipt);
            const receiptHash = createHash('sha256')
              .update(receiptJson)
              .digest('hex');
            const before = (await this.load(runner, data.reservationId))!;
            if (
              before.state !== 'claimed' ||
              before.reservationHash !== data.reservationHash ||
              before.owner !== data.owner ||
              before.generation !== data.generation ||
              before.leaseUntil !== data.leaseUntil
            )
              throw new Stale('construction:fence-reread');
            await runner.query(
              "UPDATE monero_withdrawal_reservation SET state='completed',receiptJson=?,receiptHash=? WHERE reservationId=? AND reservationHash=? AND state='claimed' AND owner=? AND generation=? AND leaseUntil=?",
              [
                receiptJson,
                receiptHash,
                data.reservationId,
                data.reservationHash,
                data.owner,
                data.generation,
                data.leaseUntil,
              ],
            );
            await this.changed(runner);
            const completed = (await this.load(runner, data.reservationId))!;
            if (
              completed.state !== 'completed' ||
              JSON.stringify(completed.receipt) !== receiptJson
            )
              throw new Stale('construction:completion-reread');
            await this.fault?.('construct-before-commit');
            if ((await this.time(runner)) >= integer(data.leaseUntil))
              throw new Stale('construction:expired');
            return { status: 'completed', reservation: completed };
          },
          false,
        );
        await this.fault?.('construct-after-commit');
        return result;
      } catch (error) {
        return failure(error);
      }
    });
  }
}
