import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { DataSource, type QueryRunner } from '@rosen-bridge/extended-typeorm';

import {
  acknowledgementBytes,
  boundedInteger,
  storedInteger,
  identityString,
  type DeliveryClaim,
  type DeliveryTarget,
  type ClaimResult,
  type AcknowledgementVerifier,
} from '../deposit/creditDelivery';
import { CreditDeliveryEntity } from './entities/creditDeliveryEntity';
import { CreditOutboxEntity } from './entities/creditOutboxEntity';
import { DepositDecisionEntity } from './entities/depositDecisionEntity';
import { DepositOutputEntity } from './entities/depositOutputEntity';

export const digest = (bytes: string): string =>
  createHash('sha256').update(bytes, 'utf8').digest('hex');

export interface ContextRecord {
  id: string;
  digest: string;
  body: string;
}
export interface DurableDecision {
  id: string;
  sourceNetwork: string;
  txid: string;
  retryFingerprint: string;
  envelopeDigest: string;
  envelope: string;
  authority: string;
  contextDigest: string;
}
export interface DurableOutput {
  economicId: string;
  sourceNetwork: string;
  publicKey: string;
  txid: string;
  outputIndex: string;
  amount: string;
  decisionId: string;
}
export interface DurableOutbox {
  decisionId: string;
  obligationId: string;
  payloadHash: string;
  payload: string;
  status: 'pending';
}
export interface PreparedDeposit {
  decision: DurableDecision;
  outputs: DurableOutput[];
  outbox: DurableOutbox;
  contextId: string;
  expiresAtHeight: string;
}
export type RegistryResult =
  | {
      status: 'created' | 'existing';
      decision: DurableDecision;
      outbox: DurableOutbox;
    }
  | { status: 'conflict' | 'indeterminate'; reason: string };
export type FaultPoint =
  | 'afterDeliveryClaim'
  | 'afterDeliveryAck'
  | 'afterContext'
  | 'afterDecision'
  | `afterOutput:${number}`
  | 'afterOutbox'
  | 'beforeCommit'
  | 'afterCommit';
type FaultHook = (point: FaultPoint) => Promise<void>;
class RegistryConflict extends Error {}
class ContextChanged extends Error {}
const connectionOwner = Symbol('deposit-connection-owner');
export type DepositConnection =
  | { type: 'sqlite'; database: string }
  | {
      type: 'postgres';
      host: string;
      port: number;
      username: string;
      password: string;
      database: string;
      ssl?: boolean;
    };
export interface SqliteStorageSettings {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  readUncommitted: number;
  busyTimeout: number;
}

/** Local persistence only. This class neither certifies a decision nor sends credit. */
export class DepositRegistry {
  readonly #db: DataSource;
  #tail: Promise<unknown> = Promise.resolve();
  #closing = false;
  readonly storageSettings: Readonly<SqliteStorageSettings> | undefined;
  private constructor(
    owner: symbol,
    db: DataSource,
    private readonly fault?: FaultHook,
    settings?: SqliteStorageSettings,
  ) {
    if (owner !== connectionOwner)
      throw new Error('Use the owned connection factory');
    this.#db = db;
    this.storageSettings = settings ? Object.freeze(settings) : undefined;
  }
  /** Opens an exclusive connection. Schema migration remains the database owner's responsibility. */
  static async open(
    connection: DepositConnection,
    fault?: FaultHook,
  ): Promise<DepositRegistry> {
    if (
      !connection ||
      (connection.type !== 'sqlite' && connection.type !== 'postgres')
    )
      throw new Error('Unsupported deposit connection');
    if (connection.type === 'sqlite' && !isAbsolute(connection.database))
      throw new Error('A real absolute SQLite file path is required');
    const options =
      connection.type === 'sqlite'
        ? { type: 'sqlite' as const, database: connection.database }
        : {
            type: 'postgres' as const,
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
            ssl: connection.ssl,
          };
    const db = new DataSource({
      ...options,
      synchronize: false,
      entities: [
        CreditDeliveryEntity,
        DepositDecisionEntity,
        DepositOutputEntity,
        CreditOutboxEntity,
      ],
    });
    try {
      await db.initialize();
      let settings: SqliteStorageSettings | undefined;
      if (connection.type === 'sqlite') {
        // Per-connection settings; never change the shared file's journal mode here.
        await db.query('PRAGMA synchronous=FULL');
        await db.query('PRAGMA foreign_keys=ON');
        await db.query('PRAGMA read_uncommitted=OFF');
        await db.query('PRAGMA busy_timeout=1000');
        settings = {
          journalMode: (await db.query('PRAGMA journal_mode'))[0].journal_mode,
          synchronous: (await db.query('PRAGMA synchronous'))[0].synchronous,
          foreignKeys: (await db.query('PRAGMA foreign_keys'))[0].foreign_keys,
          readUncommitted: (await db.query('PRAGMA read_uncommitted'))[0]
            .read_uncommitted,
          busyTimeout: (await db.query('PRAGMA busy_timeout'))[0].timeout,
        };
        if (
          settings.synchronous !== 2 ||
          settings.foreignKeys !== 1 ||
          settings.readUncommitted !== 0 ||
          settings.busyTimeout !== 1000
        )
          throw new Error('SQLite connection settings not established');
      }
      // Do not return an admission-capable registry without its migrated schema.
      for (const table of [
        'monero_deposit_context',
        'monero_deposit_decision',
        'monero_deposit_output',
        'monero_credit_outbox',
        'monero_credit_delivery',
      ])
        await db.query(`SELECT * FROM "${table}" WHERE 1=0`);
      return new DepositRegistry(connectionOwner, db, fault, settings);
    } catch (error) {
      if (db.isInitialized) await db.destroy();
      throw error;
    }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing)
      return Promise.reject(new Error('Deposit connection is closing'));
    const result = this.#tail.then(operation);
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
  private placeholders(count: number): string {
    return Array.from({ length: count }, (_, i) =>
      this.#db.options.type === 'postgres' ? `$${i + 1}` : '?',
    ).join(', ');
  }
  private async readContextWith(
    runner: QueryRunner,
    id: string,
  ): Promise<ContextRecord | undefined> {
    return (
      await runner.query(
        `SELECT * FROM "monero_deposit_context" WHERE "id" = ${this.placeholders(1)}`,
        [id],
      )
    )[0];
  }
  async readContext(id: string): Promise<ContextRecord | undefined> {
    return this.enqueue(() => this.readContextIsolated(id));
  }
  private async readContextIsolated(
    id: string,
  ): Promise<ContextRecord | undefined> {
    const runner = this.#db.createQueryRunner();
    try {
      return await this.readContextWith(runner, id);
    } finally {
      await runner.release();
    }
  }
  /** Trusted configuration writer. expectedDigest is a CAS, not request authority. */
  async setContext(
    record: ContextRecord,
    expectedDigest: string | null,
  ): Promise<void> {
    const copy = structuredClone(record);
    return this.enqueue(() => this.setContextIsolated(copy, expectedDigest));
  }
  private async setContextIsolated(
    record: ContextRecord,
    expectedDigest: string | null,
  ): Promise<void> {
    if (!record.id || digest(record.body) !== record.digest)
      throw new Error('Invalid context bytes');
    await this.transaction(async (runner) => {
      await runner.query(
        `UPDATE "monero_deposit_context" SET "digest" = "digest" WHERE "id" = ${this.placeholders(1)}`,
        [record.id],
      );
      const old = await this.readContextWith(runner, record.id);
      if ((old?.digest ?? null) !== expectedDigest)
        throw new ContextChanged('context:cas');
      if (old) {
        const previous = JSON.parse(old.body);
        const next = JSON.parse(record.body);
        if (BigInt(next.revision) !== BigInt(previous.revision) + 1n)
          throw new ContextChanged('context:revision');
        const p =
          this.#db.options.type === 'postgres'
            ? ['$1', '$2', '$3']
            : ['?', '?', '?'];
        await runner.query(
          `UPDATE "monero_deposit_context" SET "digest"=${p[0]}, "body"=${p[1]} WHERE "id"=${p[2]}`,
          [record.digest, record.body, record.id],
        );
      } else
        await runner.query(
          `INSERT INTO "monero_deposit_context" ("id","digest","body") VALUES (${this.placeholders(3)})`,
          [record.id, record.digest, record.body],
        );
      await this.fault?.('afterContext');
    });
  }
  private async existing(
    runner: QueryRunner,
    id: string,
    fingerprint: string,
  ): Promise<RegistryResult | undefined> {
    const decision: DurableDecision | undefined = (
      await runner.query(
        `SELECT * FROM "monero_deposit_decision" WHERE "id"=${this.placeholders(1)}`,
        [id],
      )
    )[0];
    if (!decision) return undefined;
    if (decision.retryFingerprint !== fingerprint)
      return { status: 'conflict', reason: 'deposit:request-conflict' };
    const outbox: DurableOutbox | undefined = (
      await runner.query(
        `SELECT * FROM "monero_credit_outbox" WHERE "decisionId"=${this.placeholders(1)}`,
        [id],
      )
    )[0];
    if (
      !outbox ||
      digest(decision.envelope) !== decision.envelopeDigest ||
      digest(outbox.payload) !== outbox.payloadHash
    )
      throw new Error('Incomplete or corrupted committed decision');
    return { status: 'existing', decision, outbox };
  }
  async replay(
    id: string,
    fingerprint: string,
  ): Promise<RegistryResult | undefined> {
    return this.enqueue(() => this.replayIsolated(id, fingerprint));
  }
  private async replayIsolated(
    id: string,
    fingerprint: string,
  ): Promise<RegistryResult | undefined> {
    const runner = this.#db.createQueryRunner();
    try {
      return await this.existing(runner, id, fingerprint);
    } finally {
      await runner.release();
    }
  }
  /** Internal admission consumer; only the trusted composition supplies prepared rows. */
  async commit(prepared: PreparedDeposit): Promise<RegistryResult> {
    const copy = structuredClone(prepared);
    return this.enqueue(() => this.commitIsolated(copy));
  }
  private async commitIsolated(
    prepared: PreparedDeposit,
  ): Promise<RegistryResult> {
    try {
      const result = await this.transaction(async (runner) => {
        // Obtain the context row's database write lock before reads: independent connections share it.
        await runner.query(
          `UPDATE "monero_deposit_context" SET "digest"="digest" WHERE "id"=${this.placeholders(1)}`,
          [prepared.contextId],
        );
        const replay = await this.existing(
          runner,
          prepared.decision.id,
          prepared.decision.retryFingerprint,
        );
        if (replay) return replay;
        const context = await this.readContextWith(runner, prepared.contextId);
        if (
          !context ||
          context.digest !== prepared.decision.contextDigest ||
          digest(context.body) !== context.digest
        )
          throw new ContextChanged('context:changed');
        const current = JSON.parse(context.body);
        if (
          BigInt(current.snapshot.chainHeight) >
          BigInt(prepared.expiresAtHeight)
        )
          throw new ContextChanged('intent:expired-at-commit');
        if (
          digest(prepared.decision.envelope) !==
            prepared.decision.envelopeDigest ||
          digest(prepared.outbox.payload) !== prepared.outbox.payloadHash
        )
          throw new Error('Prepared digest mismatch');
        await this.insert(runner, 'monero_deposit_decision', prepared.decision);
        await this.fault?.('afterDecision');
        for (const [index, output] of prepared.outputs.entries()) {
          await this.insert(runner, 'monero_deposit_output', output);
          await this.fault?.(`afterOutput:${index}`);
        }
        await this.insert(runner, 'monero_credit_outbox', prepared.outbox);
        await this.fault?.('afterOutbox');
        await this.fault?.('beforeCommit');
        return {
          status: 'created' as const,
          decision: prepared.decision,
          outbox: prepared.outbox,
        };
      });
      await this.fault?.('afterCommit');
      return result;
    } catch (error) {
      if (error instanceof ContextChanged)
        return { status: 'indeterminate', reason: error.message };
      if (error instanceof RegistryConflict)
        return { status: 'conflict', reason: 'deposit:economic-conflict' };
      return { status: 'indeterminate', reason: 'storage:unavailable' };
    }
  }
  private async outboxWith(
    runner: QueryRunner,
    obligationId: string,
  ): Promise<DurableOutbox | undefined> {
    const row = (
      await runner.query(
        `SELECT * FROM "monero_credit_outbox" WHERE "obligationId"=${this.placeholders(1)}`,
        [obligationId],
      )
    )[0];
    if (
      row &&
      (row.status !== 'pending' || digest(row.payload) !== row.payloadHash)
    )
      throw new Error('Invalid durable outbox');
    return row;
  }
  private async deliveryWith(
    runner: QueryRunner,
    obligationId: string,
  ): Promise<CreditDeliveryEntity | undefined> {
    return (
      await runner.query(
        `SELECT * FROM "monero_credit_delivery" WHERE "obligationId"=${this.placeholders(1)}`,
        [obligationId],
      )
    )[0];
  }
  async readDelivery(
    obligationId: string,
  ): Promise<CreditDeliveryEntity | undefined> {
    return this.enqueue(async () => {
      const runner = this.#db.createQueryRunner();
      try {
        return await this.deliveryWith(runner, obligationId);
      } finally {
        await runner.release();
      }
    });
  }
  private async lockOutbox(
    runner: QueryRunner,
    obligationId: string,
  ): Promise<void> {
    // A database row lock coordinates independent connections and processes.
    await runner.query(
      `UPDATE "monero_credit_outbox" SET "status"="status" WHERE "obligationId"=${this.placeholders(1)}`,
      [obligationId],
    );
  }
  async claimDelivery(
    obligationId: string,
    target: DeliveryTarget,
    owner: string,
    now: bigint,
    lease: bigint,
  ): Promise<ClaimResult> {
    const capturedTarget = structuredClone(target);
    return this.enqueue(async () => {
      if (
        !identityString(obligationId) ||
        !identityString(owner) ||
        !capturedTarget ||
        !identityString(capturedTarget.id) ||
        !identityString(capturedTarget.profile)
      )
        throw new Error('Invalid delivery identity');
      boundedInteger(now);
      boundedInteger(lease);
      if (lease === 0n) throw new Error('Empty delivery lease');
      const leaseUntil = boundedInteger(now + lease).toString();
      return this.transaction(async (runner) => {
        await this.lockOutbox(runner, obligationId);
        const outbox = await this.outboxWith(runner, obligationId);
        if (!outbox) return { status: 'missing' as const };
        const old = await this.deliveryWith(runner, obligationId);
        if (
          old &&
          (old.destinationId !== capturedTarget.id ||
            old.destinationProfile !== capturedTarget.profile)
        )
          return { status: 'target-conflict' as const };
        if (old && old.payloadHash !== outbox.payloadHash)
          throw new Error('Delivery payload changed');
        if (old?.status === 'delivered')
          return { status: 'delivered' as const };
        if (old && (old.status !== 'claimed' || old.acknowledgement !== null))
          throw new Error('Invalid delivery state');
        if (old && storedInteger(old.leaseUntil) > now)
          return { status: 'busy' as const };
        const generation = boundedInteger(
          old ? storedInteger(old.generation) + 1n : 1n,
        ).toString();
        const claim: DeliveryClaim = {
          obligationId,
          payloadHash: outbox.payloadHash,
          payload: outbox.payload,
          destinationId: capturedTarget.id,
          destinationProfile: capturedTarget.profile,
          owner,
          generation,
          leaseUntil,
        };
        if (old) {
          const p =
            this.#db.options.type === 'postgres'
              ? ['$1', '$2', '$3', '$4', '$5']
              : ['?', '?', '?', '?', '?'];
          await runner.query(
            `UPDATE "monero_credit_delivery" SET "owner"=${p[0]}, "generation"=${p[1]}, "leaseUntil"=${p[2]}
            WHERE "obligationId"=${p[3]} AND "generation"=${p[4]} AND "status"='claimed'`,
            [owner, generation, leaseUntil, obligationId, old.generation],
          );
        } else {
          const row = {
            obligationId,
            payloadHash: claim.payloadHash,
            destinationId: claim.destinationId,
            destinationProfile: claim.destinationProfile,
            owner,
            generation,
            leaseUntil,
          };
          await this.insert(runner, 'monero_credit_delivery', {
            ...row,
            status: 'claimed',
            acknowledgement: null,
          });
        }
        if (!(await this.matchesClaim(runner, claim, now)))
          throw new Error('Delivery claim CAS failed');
        await this.fault?.('afterDeliveryClaim');
        return { status: 'claimed' as const, claim };
      });
    });
  }
  private async matchesClaim(
    runner: QueryRunner,
    claim: DeliveryClaim,
    now: bigint,
  ): Promise<boolean> {
    boundedInteger(now);
    if (
      !claim ||
      typeof claim !== 'object' ||
      Object.keys(claim).length !== 8 ||
      !identityString(claim.obligationId)
    )
      return false;
    const row = await this.deliveryWith(runner, claim.obligationId);
    const outbox = await this.outboxWith(runner, claim.obligationId);
    return (
      !!row &&
      !!outbox &&
      row.status === 'claimed' &&
      row.acknowledgement === null &&
      row.owner === claim.owner &&
      row.generation === claim.generation &&
      row.leaseUntil === claim.leaseUntil &&
      storedInteger(row.leaseUntil) > now &&
      row.destinationId === claim.destinationId &&
      row.destinationProfile === claim.destinationProfile &&
      row.payloadHash === claim.payloadHash &&
      outbox.payloadHash === claim.payloadHash &&
      outbox.payload === claim.payload
    );
  }
  async validateDeliveryClaim(
    claim: DeliveryClaim,
    now: bigint,
  ): Promise<boolean> {
    const copy = structuredClone(claim);
    return this.enqueue(async () => {
      const runner = this.#db.createQueryRunner();
      try {
        return await this.matchesClaim(runner, copy, now);
      } finally {
        await runner.release();
      }
    });
  }
  /** The verifier is a trusted composition dependency; no transport boolean is an acknowledgement. */
  async acknowledgeDelivery(
    claim: DeliveryClaim,
    raw: unknown,
    clock: () => bigint,
    verifier: AcknowledgementVerifier,
  ): Promise<boolean> {
    const copy = structuredClone(claim);
    const capturedRaw = structuredClone(raw);
    if (!(await this.validateDeliveryClaim(copy, clock()))) return false;
    // External verifier work never holds the producer's transaction or operation queue.
    const verified = await verifier.verify(
      capturedRaw,
      Object.freeze({ ...copy }),
    );
    const bytes = acknowledgementBytes(verified, copy);
    if (!bytes) return false;
    return this.enqueue(() =>
      this.transaction(async (runner) => {
        await this.lockOutbox(runner, copy.obligationId);
        if (!(await this.matchesClaim(runner, copy, clock()))) return false;
        const p =
          this.#db.options.type === 'postgres'
            ? ['$1', '$2', '$3', '$4']
            : ['?', '?', '?', '?'];
        await runner.query(
          `UPDATE "monero_credit_delivery" SET "status"='delivered', "acknowledgement"=${p[0]}
        WHERE "obligationId"=${p[1]} AND "generation"=${p[2]} AND "owner"=${p[3]} AND "status"='claimed'`,
          [bytes, copy.obligationId, copy.generation, copy.owner],
        );
        const stored = await this.deliveryWith(runner, copy.obligationId);
        if (stored?.status !== 'delivered' || stored.acknowledgement !== bytes)
          throw new Error('Delivery acknowledgement CAS failed');
        await this.fault?.('afterDeliveryAck');
        return true;
      }),
    );
  }
  private async insert(
    runner: QueryRunner,
    table: string,
    row: object,
  ): Promise<void> {
    const columns = Object.keys(row);
    await runner.query(
      `INSERT INTO "${table}" (${columns.map((name) => `"${name}"`).join(',')}) VALUES (${this.placeholders(columns.length)})`,
      Object.values(row),
    );
  }
  private async transaction<T>(
    work: (runner: QueryRunner) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const runner = this.#db.createQueryRunner();
      try {
        await runner.startTransaction('SERIALIZABLE');
        const result = await work(runner);
        await runner.commitTransaction();
        return result;
      } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        const code = (error as { code?: string }).code;
        if (
          (code === 'SQLITE_BUSY' || code === '40001' || code === '40P01') &&
          attempt < 7
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, 10 * (attempt + 1)),
          );
          continue;
        }
        if (
          (code === 'SQLITE_CONSTRAINT' &&
            /UNIQUE constraint failed/.test((error as Error).message)) ||
          code === '23505'
        )
          throw new RegistryConflict('Unique ownership conflict');
        throw error;
      } finally {
        await runner.release();
      }
    }
  }
}
