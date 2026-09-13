import * as wasm from 'ergo-lib-wasm-nodejs';
import { isAbsolute } from 'node:path';

import { DataSource, type QueryRunner } from '@rosen-bridge/extended-typeorm';
import { economicOutputIdentity } from '@rosen-bridge/monero-deposit';

import {
  identityString,
  boundedInteger,
  storedInteger,
  type DeliveryTarget,
  type DeliveryClaim,
  type DurableAcknowledgement,
  acknowledgementBytes,
} from '../deposit/creditDelivery';
import { canonicalDecision } from '../deposit/depositAdmission';
import {
  parseCanonical,
  recordShape,
  exactHex,
} from '../deposit/ergoCreditAdmission';
import type { VerifiedUnsignedCredit } from '../deposit/ergoCreditConsumer';
import {
  checkedCreditPreparation,
  type CreditPreparationBinding,
} from '../deposit/ergoCreditExecution';
import {
  verifySignedPreparation,
  type SignedCreditRecord,
} from '../deposit/ergoCreditNative';
import { digest, type SqliteStorageSettings } from './depositRegistry';
import { Migration1789240000000 } from './migrations/ergoCredit/sqlite/1789240000000-migration';
import { Migration1789326400000 } from './migrations/ergoCredit/sqlite/1789326400000-migration';
import { Migration1789412800000 } from './migrations/ergoCredit/sqlite/1789412800000-migration';

export interface CreditEffectFence extends CreditSigningFence {
  signedHash: string;
}
export type CreditEffectResult =
  | { status: 'effected'; acknowledgement: Readonly<DurableAcknowledgement> }
  | {
      status:
        | 'busy'
        | 'stale'
        | 'conflict'
        | 'indeterminate'
        | 'missing'
        | 'rejected';
      reason: string;
    };
export type CreditEffectClaimResult =
  | CreditEffectResult
  | { status: 'claimed'; fence: Readonly<CreditEffectFence> };
interface EffectExecutionRow {
  obligationId: string;
  preparationHash: string;
  signedHash: string;
  state: 'pending' | 'effecting' | 'effected';
  owner: string;
  generation: string;
  leaseUntil: string;
  updatedAt: string;
}
interface LedgerBox {
  boxId: string;
  boxHex: string;
}
interface UtxoRow extends LedgerBox {
  originEffect: string | null;
  state: 'unspent' | 'spent';
  spentBy: string | null;
}
interface EffectRow {
  obligationId: string;
  effectId: string;
  nativeTxId: string;
  preparationHash: string;
  signedHash: string;
  inputsJson: string;
  outputsJson: string;
  acknowledgement: string;
  acknowledgementHash: string;
}
const ledgerBox = (boxHex: string): LedgerBox => {
  exactHex(boxHex, 'ledger-box');
  const box = wasm.ErgoBox.sigma_parse_bytes(Buffer.from(boxHex, 'hex'));
  try {
    if (Buffer.from(box.sigma_serialize_bytes()).toString('hex') !== boxHex)
      throw Error('Noncanonical ledger box');
    return { boxId: box.box_id().to_str(), boxHex };
  } finally {
    box.free();
  }
};

export interface CreditSigningFence {
  obligationId: string;
  preparationHash: string;
  destinationId: string;
  destinationProfile: string;
  owner: string;
  generation: string;
  leaseUntil: string;
}
export type CreditSigningResult =
  | { status: 'staged'; signed: Readonly<SignedCreditRecord> }
  | {
      status:
        | 'busy'
        | 'stale'
        | 'conflict'
        | 'indeterminate'
        | 'missing'
        | 'rejected';
      reason: string;
    };
export type CreditSigningClaimResult =
  | CreditSigningResult
  | {
      status: 'claimed';
      fence: Readonly<CreditSigningFence>;
      preparation: Readonly<DurableCreditPreparation>;
    };
interface ExecutionRow {
  obligationId: string;
  state: 'prepared' | 'signing' | 'signed';
  owner: string;
  generation: string;
  leaseUntil: string;
  updatedAt: string;
}

export interface DurableCreditPreparation {
  obligationId: string;
  bindingJson: string;
  candidateJson: string;
  candidateHash: string;
  preparationHash: string;
  status: 'prepared';
}
export type CreditPreparationResult =
  | {
      status: 'created' | 'existing';
      preparation: Readonly<DurableCreditPreparation>;
    }
  | {
      status: 'conflict' | 'rejected' | 'indeterminate' | 'missing';
      reason: string;
    };
export type CreditPreparationFault =
  | 'afterPreparation'
  | `afterEconomicOutput:${number}`
  | `afterErgoInput:${number}`
  | 'beforeCommit'
  | 'afterCommit'
  | 'afterClaimWrite'
  | 'beforeClaimCommit'
  | 'afterClaimCommit'
  | 'afterSignedWrite'
  | 'afterSigningState'
  | 'beforeSignedCommit'
  | 'afterSignedCommit'
  | 'afterEffectClaimWrite'
  | 'beforeEffectClaimCommit'
  | 'afterEffectClaimCommit'
  | 'afterEffectWrite'
  | 'afterEffectAck'
  | `afterEffectSpend:${number}`
  | `afterEffectOutput:${number}`
  | 'afterEffectState'
  | 'beforeEffectCommit'
  | 'afterEffectCommit';
type Fault = (point: CreditPreparationFault) => Promise<void>;
const owner = Symbol('ergo-credit-connection');
class Conflict extends Error {}
const inputRows = (candidate: VerifiedUnsignedCredit) =>
  candidate.inputHex
    .map((boxHex) => {
      exactHex(boxHex, 'input');
      const box = wasm.ErgoBox.sigma_parse_bytes(Buffer.from(boxHex, 'hex'));
      if (Buffer.from(box.sigma_serialize_bytes()).toString('hex') !== boxHex)
        throw Error('Noncanonical input');
      return { boxId: box.box_id().to_str(), boxHex };
    })
    .sort((a, b) => a.boxId.localeCompare(b.boxId));
const preparationHash = (bindingJson: string, candidateJson: string) =>
  digest(
    canonicalDecision({
      domain: 'rosen-monero-ergo-prepared-bytes',
      version: 1,
      bindingJson,
      candidateJson,
    }),
  );

/** One local SQLite destination authority; its UTXO effect is synthetic, not chain settlement. */
export class ErgoCreditRegistry {
  readonly #db: DataSource;
  #tail: Promise<unknown> = Promise.resolve();
  #closing = false;
  private constructor(
    token: symbol,
    db: DataSource,
    readonly target: Readonly<DeliveryTarget>,
    readonly storageSettings: Readonly<SqliteStorageSettings>,
    private readonly fault?: Fault,
    private readonly executionClock?: () => bigint,
  ) {
    if (token !== owner) throw Error('Use owned connection factory');
    this.#db = db;
  }
  static async open(
    database: string,
    target: DeliveryTarget,
    fault?: Fault,
    executionClock?: () => bigint,
  ): Promise<ErgoCreditRegistry> {
    if (!isAbsolute(database) || database === ':memory:')
      throw Error('Real absolute database path required');
    const captured = structuredClone(target);
    recordShape(captured, ['id', 'profile'], 'destination');
    if (!identityString(captured.id) || !identityString(captured.profile))
      throw Error('Invalid destination');
    const db = new DataSource({
      type: 'sqlite',
      database,
      synchronize: false,
      migrations: [
        Migration1789240000000,
        Migration1789326400000,
        Migration1789412800000,
      ],
    });
    try {
      await db.initialize();
      await db.query('PRAGMA synchronous=FULL');
      await db.query('PRAGMA foreign_keys=ON');
      await db.query('PRAGMA read_uncommitted=OFF');
      await db.query('PRAGMA busy_timeout=1000');
      const settings: SqliteStorageSettings = {
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
        throw Error('Durability settings unavailable');
      await db.runMigrations();
      const registry = new ErgoCreditRegistry(
        owner,
        db,
        Object.freeze(captured),
        Object.freeze(settings),
        fault,
        executionClock,
      );
      await registry.transaction(async (runner) => {
        const identity = await runner.query(
          'SELECT * FROM ergo_credit_identity',
        );
        if (
          !identity.length &&
          (await runner.query('SELECT 1 FROM ergo_credit LIMIT 1')).length
        )
          throw Error('Missing identity with existing work');
        await runner.query(
          'INSERT OR IGNORE INTO ergo_credit_identity VALUES (1,?,?)',
          [captured.id, captured.profile],
        );
        await registry.checkIdentity(runner);
      }, false);
      return registry;
    } catch (error) {
      if (db.isInitialized) await db.destroy();
      throw error;
    }
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(Error('Destination closing'));
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
  private async checkIdentity(runner: QueryRunner): Promise<void> {
    const rows = await runner.query('SELECT * FROM ergo_credit_identity');
    if (
      rows.length !== 1 ||
      rows[0].singleton !== 1 ||
      rows[0].id !== this.target.id ||
      rows[0].profile !== this.target.profile
    )
      throw new Conflict('destination:identity');
  }
  private parseBinding(json: string): CreditPreparationBinding {
    const binding = parseCanonical(
      json,
      'preparation-binding',
    ) as unknown as CreditPreparationBinding;
    recordShape(
      binding,
      [
        'domain',
        'version',
        'mode',
        'obligationId',
        'payload',
        'payloadHash',
        'destinationId',
        'destinationProfile',
        'envelopeDigest',
        'executionProfileDigest',
        'economicOutputs',
      ],
      'binding',
    );
    if (
      binding.domain !== 'rosen-monero-ergo-preparation' ||
      binding.version !== 1 ||
      binding.mode !== 'synthetic' ||
      binding.destinationId !== this.target.id ||
      binding.destinationProfile !== this.target.profile ||
      digest(binding.payload) !== binding.payloadHash
    )
      throw new Conflict('preparation:binding');
    if (
      !Array.isArray(binding.economicOutputs) ||
      !binding.economicOutputs.length ||
      binding.economicOutputs.length > 128
    )
      throw Error('Invalid economic outputs');
    for (const output of binding.economicOutputs) {
      recordShape(
        output,
        [
          'economicId',
          'sourceNetwork',
          'publicKey',
          'txid',
          'outputIndex',
          'amount',
          'vaultEpoch',
        ],
        'economic-output',
      );
      if (
        output.economicId !==
        economicOutputIdentity(output.sourceNetwork, output.publicKey)
      )
        throw Error('Invalid economic identity');
    }
    if (
      new Set(binding.economicOutputs.map((o) => o.economicId)).size !==
      binding.economicOutputs.length
    )
      throw Error('Duplicate economic output');
    return binding;
  }
  private parseCandidate(
    json: string,
    binding: CreditPreparationBinding,
  ): VerifiedUnsignedCredit {
    const c = parseCanonical(
      json,
      'prepared-candidate',
    ) as unknown as VerifiedUnsignedCredit;
    recordShape(
      c,
      [
        'status',
        'obligationId',
        'envelopeDigest',
        'executionProfileDigest',
        'triggerId',
        'eventId',
        'transactionJson',
        'reducedHex',
        'inputHex',
        'dataInputHex',
        'contextJson',
        'contextDigest',
        'netAmount',
      ],
      'candidate',
    );
    if (
      c.status !== 'verified-unsigned' ||
      c.obligationId !== binding.obligationId ||
      c.envelopeDigest !== binding.envelopeDigest ||
      c.executionProfileDigest !== binding.executionProfileDigest ||
      digest(c.contextJson) !== c.contextDigest
    )
      throw new Conflict('preparation:candidate-binding');
    if (
      !Array.isArray(c.inputHex) ||
      c.inputHex.length < 2 ||
      c.inputHex.length > 128
    )
      throw Error('Invalid input set');
    const rows = inputRows(c);
    if (new Set(rows.map((i) => i.boxId)).size !== rows.length)
      throw Error('Duplicate Ergo input');
    return c;
  }
  private async load(
    runner: QueryRunner,
    obligationId: string,
  ): Promise<DurableCreditPreparation | undefined> {
    const rows = await runner.query(
      'SELECT * FROM ergo_credit WHERE obligationId=?',
      [obligationId],
    );
    if (!rows.length) return;
    const row = rows[0] as DurableCreditPreparation;
    recordShape(
      row,
      [
        'obligationId',
        'bindingJson',
        'candidateJson',
        'candidateHash',
        'preparationHash',
        'status',
      ],
      'stored-preparation',
    );
    const binding = this.parseBinding(row.bindingJson);
    const c = this.parseCandidate(row.candidateJson, binding);
    if (
      row.status !== 'prepared' ||
      row.obligationId !== binding.obligationId ||
      digest(row.candidateJson) !== row.candidateHash ||
      preparationHash(row.bindingJson, row.candidateJson) !==
        row.preparationHash
    )
      throw Error('Corrupt prepared bytes');
    const economic = await runner.query(
      'SELECT economicId,sourceNetwork,publicKey,txid,outputIndex,amount,vaultEpoch FROM ergo_credit_output WHERE obligationId=? ORDER BY economicId',
      [obligationId],
    );
    if (
      canonicalDecision(economic) !== canonicalDecision(binding.economicOutputs)
    )
      throw Error('Incomplete economic ownership');
    const inputs = await runner.query(
      'SELECT boxId,boxHex FROM ergo_credit_input WHERE obligationId=? ORDER BY boxId',
      [obligationId],
    );
    if (canonicalDecision(inputs) !== canonicalDecision(inputRows(c)))
      throw Error('Incomplete Ergo input ownership');
    return Object.freeze({ ...row });
  }
  async prepareChecked(capability: unknown): Promise<CreditPreparationResult> {
    const checked = checkedCreditPreparation(capability, this);
    if (!checked)
      return { status: 'rejected', reason: 'preparation:capability' };
    const { bindingJson, candidateJson } = checked;
    try {
      return await this.queue(() =>
        this.transaction(async (runner) => {
          await this.checkIdentity(runner);
          const binding = this.parseBinding(bindingJson);
          const old = await this.load(runner, binding.obligationId);
          if (old) {
            await this.executionWith(runner, old.obligationId);
            if (old.bindingJson !== bindingJson)
              throw new Conflict('preparation:obligation');
            if (candidateJson !== null && old.candidateJson !== candidateJson)
              throw new Conflict('preparation:candidate');
            return { status: 'existing' as const, preparation: old };
          }
          if (candidateJson === null)
            return {
              status: 'missing' as const,
              reason: 'preparation:missing',
            };
          const candidate = this.parseCandidate(candidateJson, binding);
          const row: DurableCreditPreparation = {
            obligationId: binding.obligationId,
            bindingJson,
            candidateJson,
            candidateHash: digest(candidateJson),
            preparationHash: preparationHash(bindingJson, candidateJson),
            status: 'prepared',
          };
          await runner.query('INSERT INTO ergo_credit VALUES (?,?,?,?,?,?)', [
            row.obligationId,
            row.bindingJson,
            row.candidateJson,
            row.candidateHash,
            row.preparationHash,
            row.status,
          ]);
          await runner.query(
            "INSERT INTO ergo_credit_execution VALUES (?,'prepared','','0','0','0')",
            [row.obligationId],
          );
          await this.fault?.('afterPreparation');
          for (const [index, output] of binding.economicOutputs.entries()) {
            await runner.query(
              'INSERT INTO ergo_credit_output VALUES (?,?,?,?,?,?,?,?)',
              [
                output.economicId,
                output.sourceNetwork,
                output.publicKey,
                output.txid,
                output.outputIndex,
                output.amount,
                output.vaultEpoch,
                row.obligationId,
              ],
            );
            await this.fault?.(`afterEconomicOutput:${index}`);
          }
          for (const [index, input] of inputRows(candidate).entries()) {
            await runner.query('INSERT INTO ergo_credit_input VALUES (?,?,?)', [
              input.boxId,
              input.boxHex,
              row.obligationId,
            ]);
            await this.fault?.(`afterErgoInput:${index}`);
          }
          await this.fault?.('beforeCommit');
          return {
            status: 'created' as const,
            preparation: Object.freeze(row),
          };
        }),
      );
    } catch (error) {
      return error instanceof Conflict
        ? { status: 'conflict', reason: error.message }
        : { status: 'indeterminate', reason: 'preparation:storage' };
    }
  }
  private async executionWith(
    runner: QueryRunner,
    obligationId: string,
  ): Promise<ExecutionRow> {
    const rows = await runner.query(
      'SELECT * FROM ergo_credit_execution WHERE obligationId=?',
      [obligationId],
    );
    if (rows.length !== 1) throw Error('Missing execution state');
    const row = rows[0] as ExecutionRow;
    recordShape(
      row,
      [
        'obligationId',
        'state',
        'owner',
        'generation',
        'leaseUntil',
        'updatedAt',
      ],
      'execution',
    );
    const generation = storedInteger(row.generation),
      lease = storedInteger(row.leaseUntil),
      updated = storedInteger(row.updatedAt);
    if (row.state === 'prepared') {
      if (
        row.owner !== '' ||
        generation !== 0n ||
        lease !== 0n ||
        updated !== 0n
      )
        throw Error('Invalid prepared execution');
    } else if (
      (row.state !== 'signing' && row.state !== 'signed') ||
      !identityString(row.owner) ||
      generation === 0n ||
      updated >= lease
    )
      throw Error('Invalid execution');
    const signed = await runner.query(
      'SELECT obligationId,preparationHash,signedHash FROM ergo_credit_signed WHERE obligationId=?',
      [obligationId],
    );
    if (signed.length !== (row.state === 'signed' ? 1 : 0))
      throw Error('Inconsistent signed state');
    const effects = await runner.query(
      'SELECT * FROM ergo_credit_effect_execution WHERE obligationId=?',
      [obligationId],
    );
    if (effects.length !== signed.length)
      throw Error('Missing or orphan effect execution');
    if (effects.length) this.parseEffectExecution(effects[0], signed[0]);
    return row;
  }
  private async signingTime(runner: QueryRunner): Promise<bigint> {
    if (!this.executionClock) throw Error('Signing clock unavailable');
    const now = boundedInteger(this.executionClock());
    const rows = await runner.query(
      'SELECT * FROM ergo_credit_execution_clock',
    );
    if (rows.length !== 1 || rows[0].singleton !== 1)
      throw Error('Missing execution clock');
    recordShape(rows[0], ['singleton', 'observedAt'], 'execution-clock');
    if (now < storedInteger(rows[0].observedAt))
      throw Error('Clock moved backwards');
    await runner.query(
      'UPDATE ergo_credit_execution_clock SET observedAt=? WHERE singleton=1',
      [now.toString()],
    );
    return now;
  }
  private async signedWith(
    runner: QueryRunner,
    preparation: DurableCreditPreparation,
  ): Promise<Readonly<SignedCreditRecord>> {
    const rows = await runner.query(
      'SELECT * FROM ergo_credit_signed WHERE obligationId=?',
      [preparation.obligationId],
    );
    if (rows.length !== 1) throw Error('Missing signed record');
    const row = rows[0] as SignedCreditRecord;
    recordShape(
      row,
      [
        'obligationId',
        'preparationHash',
        'signedHex',
        'signedHash',
        'nativeTxId',
        'verificationJson',
        'verificationHash',
      ],
      'signed-record',
    );
    const checked = verifySignedPreparation(preparation, row.signedHex);
    if (canonicalDecision(row) !== canonicalDecision(checked))
      throw Error('Corrupt signed record');
    return checked;
  }
  private fenceMatches(
    row: ExecutionRow,
    fence: CreditSigningFence,
    preparation: DurableCreditPreparation,
    now: bigint,
    state: 'signing' | 'signed',
  ): boolean {
    return (
      row.state === state &&
      row.obligationId === fence.obligationId &&
      preparation.preparationHash === fence.preparationHash &&
      fence.destinationId === this.target.id &&
      fence.destinationProfile === this.target.profile &&
      row.owner === fence.owner &&
      row.generation === fence.generation &&
      row.leaseUntil === fence.leaseUntil &&
      storedInteger(row.leaseUntil) > now
    );
  }
  async claimSigningChecked(
    capability: unknown,
    owner: string,
    lease: bigint,
  ): Promise<CreditSigningClaimResult> {
    const cap = checkedCreditPreparation(capability, this);
    if (!cap || cap.purpose !== 'signing')
      return { status: 'rejected', reason: 'signing:capability' };
    const bindingJson = cap.bindingJson;
    try {
      if (!identityString(owner) || boundedInteger(lease) === 0n)
        throw Error('Invalid signing lease');
      return await this.queue(async () => {
        const result = await this.transaction<CreditSigningClaimResult>(
          async (runner) => {
            await this.checkIdentity(runner);
            const binding = this.parseBinding(bindingJson),
              preparation = await this.load(runner, binding.obligationId);
            if (!preparation)
              return { status: 'missing', reason: 'signing:preparation' };
            if (preparation.bindingJson !== bindingJson)
              throw new Conflict('signing:binding');
            const row = await this.executionWith(runner, binding.obligationId);
            const now = await this.signingTime(runner);
            if (row.state === 'signed')
              return {
                status: 'staged',
                signed: await this.signedWith(runner, preparation),
              };
            if (row.state === 'signing' && storedInteger(row.leaseUntil) > now)
              return { status: 'busy', reason: 'signing:lease' };
            const fence = Object.freeze({
              obligationId: binding.obligationId,
              preparationHash: preparation.preparationHash,
              destinationId: this.target.id,
              destinationProfile: this.target.profile,
              owner,
              generation: boundedInteger(
                storedInteger(row.generation) + 1n,
              ).toString(),
              leaseUntil: boundedInteger(now + lease).toString(),
            });
            await runner.query(
              "UPDATE ergo_credit_execution SET state='signing',owner=?,generation=?,leaseUntil=?,updatedAt=? WHERE obligationId=? AND generation=? AND state=?",
              [
                owner,
                fence.generation,
                fence.leaseUntil,
                now.toString(),
                binding.obligationId,
                row.generation,
                row.state,
              ],
            );
            if ((await runner.query('SELECT changes() AS n'))[0].n !== 1)
              throw new Conflict('signing:claim-cas');
            await this.fault?.('afterClaimWrite');
            await this.fault?.('beforeClaimCommit');
            if (
              !this.fenceMatches(
                await this.executionWith(runner, binding.obligationId),
                fence,
                preparation,
                await this.signingTime(runner),
                'signing',
              )
            )
              throw new Conflict('signing:claim-expired');
            return { status: 'claimed', fence, preparation };
          },
          false,
        );
        if (result.status === 'claimed') await this.fault?.('afterClaimCommit');
        return result;
      });
    } catch (error) {
      return error instanceof Conflict
        ? { status: 'conflict', reason: error.message }
        : { status: 'indeterminate', reason: 'signing:storage' };
    }
  }
  async stageSigningChecked(
    capability: unknown,
    fence: CreditSigningFence,
    signedHex: string,
  ): Promise<CreditSigningResult> {
    const cap = checkedCreditPreparation(capability, this);
    if (!cap || cap.purpose !== 'signing')
      return { status: 'rejected', reason: 'signing:capability' };
    const bindingJson = cap.bindingJson;
    try {
      const captured = Object.freeze(structuredClone(fence));
      recordShape(
        captured,
        [
          'obligationId',
          'preparationHash',
          'destinationId',
          'destinationProfile',
          'owner',
          'generation',
          'leaseUntil',
        ],
        'signing-fence',
      );
      storedInteger(captured.generation);
      storedInteger(captured.leaseUntil);
      exactHex(signedHex, 'signed');
      return await this.queue(async () => {
        const result = await this.transaction<CreditSigningResult>(
          async (runner) => {
            await this.checkIdentity(runner);
            const binding = this.parseBinding(bindingJson),
              preparation = await this.load(runner, binding.obligationId);
            if (!preparation)
              return { status: 'missing', reason: 'signing:preparation' };
            if (preparation.bindingJson !== bindingJson)
              throw new Conflict('signing:binding');
            const row = await this.executionWith(runner, binding.obligationId);
            const now = await this.signingTime(runner);
            // A late completion never releases another owner's already staged bytes.
            if (!this.fenceMatches(row, captured, preparation, now, 'signing'))
              return { status: 'stale', reason: 'signing:fence' };
            const signed = verifySignedPreparation(preparation, signedHex);
            await runner.query(
              'INSERT INTO ergo_credit_signed VALUES (?,?,?,?,?,?,?)',
              [
                signed.obligationId,
                signed.preparationHash,
                signed.signedHex,
                signed.signedHash,
                signed.nativeTxId,
                signed.verificationJson,
                signed.verificationHash,
              ],
            );
            await runner.query(
              "INSERT INTO ergo_credit_effect_execution VALUES (?,?,?,'pending','','0','0','0')",
              [signed.obligationId, signed.preparationHash, signed.signedHash],
            );
            await this.fault?.('afterSignedWrite');
            await runner.query(
              "UPDATE ergo_credit_execution SET state='signed' WHERE obligationId=? AND state='signing' AND owner=? AND generation=? AND leaseUntil=?",
              [
                captured.obligationId,
                captured.owner,
                captured.generation,
                captured.leaseUntil,
              ],
            );
            if ((await runner.query('SELECT changes() AS n'))[0].n !== 1)
              throw new Conflict('signing:stage-cas');
            await this.fault?.('afterSigningState');
            await this.fault?.('beforeSignedCommit');
            if (
              !this.fenceMatches(
                await this.executionWith(runner, binding.obligationId),
                captured,
                preparation,
                await this.signingTime(runner),
                'signed',
              )
            )
              throw new Conflict('signing:stage-expired');
            return { status: 'staged', signed };
          },
          false,
        );
        if (result.status === 'staged') await this.fault?.('afterSignedCommit');
        return result;
      });
    } catch (error) {
      return error instanceof Conflict
        ? { status: 'conflict', reason: error.message }
        : { status: 'indeterminate', reason: 'signing:storage' };
    }
  }
  private parseEffectExecution(
    raw: unknown,
    signed: Pick<
      SignedCreditRecord,
      'obligationId' | 'preparationHash' | 'signedHash'
    >,
  ): EffectExecutionRow {
    recordShape(
      raw,
      [
        'obligationId',
        'preparationHash',
        'signedHash',
        'state',
        'owner',
        'generation',
        'leaseUntil',
        'updatedAt',
      ],
      'effect-execution',
    );
    const row = raw as EffectExecutionRow;
    if (
      row.obligationId !== signed.obligationId ||
      row.preparationHash !== signed.preparationHash ||
      row.signedHash !== signed.signedHash
    )
      throw Error('Effect execution binding');
    const gen = storedInteger(row.generation),
      lease = storedInteger(row.leaseUntil),
      updated = storedInteger(row.updatedAt);
    if (row.state === 'pending') {
      if (row.owner !== '' || gen !== 0n || lease !== 0n || updated !== 0n)
        throw Error('Invalid pending effect');
    } else if (
      !['effecting', 'effected'].includes(row.state) ||
      !identityString(row.owner) ||
      gen === 0n ||
      updated >= lease
    )
      throw Error('Invalid effect execution');
    return row;
  }
  private async effectExecutionWith(
    runner: QueryRunner,
    signed: Readonly<SignedCreditRecord>,
  ): Promise<EffectExecutionRow> {
    const rows = await runner.query(
      'SELECT * FROM ergo_credit_effect_execution WHERE obligationId=?',
      [signed.obligationId],
    );
    if (rows.length !== 1) throw Error('Missing effect execution');
    return this.parseEffectExecution(rows[0], signed);
  }
  private effectRecord(
    preparation: DurableCreditPreparation,
    signed: Readonly<SignedCreditRecord>,
  ): EffectRow {
    const binding = this.parseBinding(preparation.bindingJson),
      candidate = this.parseCandidate(preparation.candidateJson, binding);
    const tx = wasm.Transaction.sigma_parse_bytes(
      Buffer.from(signed.signedHex, 'hex'),
    );
    let outputBoxes: wasm.ErgoBoxes | undefined;
    try {
      outputBoxes = tx.outputs();
      const outputs: LedgerBox[] = [];
      for (let i = 0; i < outputBoxes.len(); i++) {
        const box = outputBoxes.get(i);
        try {
          outputs.push(
            ledgerBox(Buffer.from(box.sigma_serialize_bytes()).toString('hex')),
          );
        } finally {
          box.free();
        }
      }
      const inputs = candidate.inputHex.map(ledgerBox);
      if (new Set(outputs.map((b) => b.boxId)).size !== outputs.length)
        throw Error('Duplicate native output');
      const identity = {
        obligationId: binding.obligationId,
        destinationId: binding.destinationId,
        destinationProfile: binding.destinationProfile,
        payloadHash: binding.payloadHash,
        envelopeDigest: binding.envelopeDigest,
        executionProfileDigest: binding.executionProfileDigest,
        preparationHash: preparation.preparationHash,
        candidateHash: preparation.candidateHash,
        signedHash: signed.signedHash,
        nativeTxId: signed.nativeTxId,
      };
      const effectId = digest(
        canonicalDecision({
          domain: 'rosen-monero-local-effect-id',
          version: 1,
          ...identity,
          inputs: inputs.map((b) => b.boxId),
          outputs: outputs.map((b) => b.boxId),
        }),
      );
      const acknowledgement = acknowledgementBytes(
        {
          mode: 'synthetic',
          destinationId: binding.destinationId,
          destinationProfile: binding.destinationProfile,
          obligationId: binding.obligationId,
          payloadHash: binding.payloadHash,
          result: canonicalDecision({
            domain: 'rosen-monero-local-effect',
            version: 1,
            ...identity,
            effectId,
          }),
        },
        { ...binding, owner: 'effect', generation: '0', leaseUntil: '0' },
      );
      if (!acknowledgement) throw Error('Invalid effect acknowledgement');
      return {
        obligationId: binding.obligationId,
        effectId,
        nativeTxId: signed.nativeTxId,
        preparationHash: preparation.preparationHash,
        signedHash: signed.signedHash,
        inputsJson: canonicalDecision(inputs),
        outputsJson: canonicalDecision(outputs),
        acknowledgement,
        acknowledgementHash: digest(acknowledgement),
      };
    } finally {
      outputBoxes?.free();
      tx.free();
    }
  }
  /** Explicit synthetic genesis. It cannot add inventory to an already initialized ledger. */
  async seedLedger(boxes: readonly string[]): Promise<'seeded' | 'existing'> {
    const captured = [...boxes]
      .map(ledgerBox)
      .sort((a, b) => a.boxId.localeCompare(b.boxId));
    if (
      !captured.length ||
      new Set(captured.map((b) => b.boxId)).size !== captured.length
    )
      throw Error('Invalid seed set');
    const seedJson = canonicalDecision(captured),
      seedHash = digest(seedJson);
    return this.queue(() =>
      this.transaction(async (runner) => {
        await this.checkIdentity(runner);
        const old = await runner.query(
          'SELECT * FROM ergo_credit_ledger_identity',
        );
        if (old.length) {
          if (
            old.length !== 1 ||
            old[0].seedJson !== seedJson ||
            old[0].seedHash !== seedHash
          )
            throw new Conflict('effect:seed');
          await this.ledgerWith(runner);
          return 'existing' as const;
        }
        if (
          (
            await runner.query(
              'SELECT 1 FROM ergo_credit_utxo UNION ALL SELECT 1 FROM ergo_credit_effect LIMIT 1',
            )
          ).length
        )
          throw Error('Missing seed with ledger history');
        await runner.query(
          'INSERT INTO ergo_credit_ledger_identity VALUES (1,?,?,?,?)',
          [this.target.id, this.target.profile, seedJson, seedHash],
        );
        for (const box of captured)
          await runner.query(
            "INSERT INTO ergo_credit_utxo VALUES (?,?,NULL,'unspent',NULL)",
            [box.boxId, box.boxHex],
          );
        await this.ledgerWith(runner);
        return 'seeded' as const;
      }, false),
    );
  }
  /** Reconstruct this bounded fixture ledger from exact native transactions, not mutable flags. */
  private async ledgerWith(runner: QueryRunner): Promise<Map<string, UtxoRow>> {
    const identity = await runner.query(
      'SELECT * FROM ergo_credit_ledger_identity',
    );
    if (identity.length !== 1) throw Error('Ledger not seeded');
    const seed = identity[0];
    recordShape(
      seed,
      [
        'singleton',
        'destinationId',
        'destinationProfile',
        'seedJson',
        'seedHash',
      ],
      'ledger-identity',
    );
    if (
      seed.singleton !== 1 ||
      seed.destinationId !== this.target.id ||
      seed.destinationProfile !== this.target.profile ||
      digest(seed.seedJson) !== seed.seedHash
    )
      throw Error('Ledger identity mismatch');
    const seedBoxes = parseCanonical(seed.seedJson, 'ledger-seed');
    if (!Array.isArray(seedBoxes) || !seedBoxes.length)
      throw Error('Invalid seed inventory');
    const expected = new Map<string, UtxoRow>();
    const add = (raw: LedgerBox, originEffect: string | null) => {
      recordShape(raw, ['boxId', 'boxHex'], 'ledger-box');
      if (
        canonicalDecision(ledgerBox(raw.boxHex)) !== canonicalDecision(raw) ||
        expected.has(raw.boxId)
      )
        throw Error('Invalid/duplicate ledger creation');
      expected.set(raw.boxId, {
        ...raw,
        originEffect,
        state: 'unspent',
        spentBy: null,
      });
    };
    for (const box of seedBoxes) add(box, null);
    const effects = (await runner.query(
      'SELECT * FROM ergo_credit_effect',
    )) as EffectRow[];
    const inputSets = new Map<string, LedgerBox[]>();
    for (const effect of effects) {
      recordShape(
        effect,
        [
          'obligationId',
          'effectId',
          'nativeTxId',
          'preparationHash',
          'signedHash',
          'inputsJson',
          'outputsJson',
          'acknowledgement',
          'acknowledgementHash',
        ],
        'stored-effect',
      );
      const prep = await this.load(runner, effect.obligationId);
      if (
        !prep ||
        (await this.executionWith(runner, effect.obligationId)).state !==
          'signed'
      )
        throw Error('Effect without staged preparation');
      const signed = await this.signedWith(runner, prep);
      const execution = await this.effectExecutionWith(runner, signed);
      if (
        execution.state !== 'effected' ||
        canonicalDecision(effect) !==
          canonicalDecision(this.effectRecord(prep, signed))
      )
        throw Error('Corrupt effect bytes/state');
      inputSets.set(effect.effectId, JSON.parse(effect.inputsJson));
      for (const box of JSON.parse(effect.outputsJson))
        add(box, effect.effectId);
    }
    const markers = (await runner.query(
      'SELECT * FROM ergo_credit_effect_execution',
    )) as EffectExecutionRow[];
    const signedRows = (await runner.query(
      'SELECT * FROM ergo_credit_signed',
    )) as SignedCreditRecord[];
    if (markers.length !== signedRows.length)
      throw Error('Missing effect history marker');
    for (const marker of markers) {
      const signed = signedRows.find(
        (s) => s.obligationId === marker.obligationId,
      );
      if (!signed) throw Error('Orphan effect execution');
      this.parseEffectExecution(marker, signed);
      if (
        effects.filter((e) => e.obligationId === marker.obligationId).length !==
        (marker.state === 'effected' ? 1 : 0)
      )
        throw Error('Incomplete effect projection');
    }
    for (const [effectId, inputs] of inputSets)
      for (const input of inputs) {
        const old = expected.get(input.boxId);
        if (!old || old.boxHex !== input.boxHex || old.state !== 'unspent')
          throw Error('Invalid ledger spend');
        old.state = 'spent';
        old.spentBy = effectId;
      }
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw Error('Cyclic synthetic effects');
      if (visited.has(id)) return;
      visiting.add(id);
      const inputs = inputSets.get(id);
      if (!inputs) throw Error('Missing spending effect');
      for (const input of inputs) {
        const origin = expected.get(input.boxId)!.originEffect;
        if (origin) visit(origin);
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of inputSets.keys()) visit(id);
    const actual = await runner.query(
      'SELECT * FROM ergo_credit_utxo ORDER BY boxId',
    );
    if (
      canonicalDecision(actual) !==
      canonicalDecision(
        [...expected.values()].sort((a, b) => a.boxId.localeCompare(b.boxId)),
      )
    )
      throw Error('Ledger projection mismatch');
    return expected;
  }
  private effectFenceMatches(
    row: EffectExecutionRow,
    fence: CreditEffectFence,
    now: bigint,
  ): boolean {
    return (
      row.state === 'effecting' &&
      row.obligationId === fence.obligationId &&
      row.preparationHash === fence.preparationHash &&
      row.signedHash === fence.signedHash &&
      fence.destinationId === this.target.id &&
      fence.destinationProfile === this.target.profile &&
      row.owner === fence.owner &&
      row.generation === fence.generation &&
      row.leaseUntil === fence.leaseUntil &&
      storedInteger(row.leaseUntil) > now
    );
  }
  private effectAcknowledgement(
    effect: EffectRow,
  ): Readonly<DurableAcknowledgement> {
    return Object.freeze(JSON.parse(effect.acknowledgement));
  }
  async claimEffectChecked(
    capability: unknown,
    owner: string,
    lease: bigint,
  ): Promise<CreditEffectClaimResult> {
    const cap = checkedCreditPreparation(capability, this);
    if (!cap || cap.purpose !== 'effect')
      return { status: 'rejected', reason: 'effect:capability' };
    const bindingJson = cap.bindingJson;
    try {
      if (!identityString(owner) || boundedInteger(lease) === 0n)
        throw Error('Invalid effect lease');
      return await this.queue(async () => {
        const result = await this.transaction<CreditEffectClaimResult>(
          async (runner) => {
            await this.checkIdentity(runner);
            const binding = this.parseBinding(bindingJson),
              prep = await this.load(runner, binding.obligationId);
            if (!prep)
              return { status: 'missing', reason: 'effect:preparation' };
            if (prep.bindingJson !== bindingJson)
              throw new Conflict('effect:binding');
            if (
              (await this.executionWith(runner, prep.obligationId)).state !==
              'signed'
            )
              return { status: 'missing', reason: 'effect:unsigned' };
            const signed = await this.signedWith(runner, prep),
              row = await this.effectExecutionWith(runner, signed);
            const now = await this.signingTime(runner);
            await this.ledgerWith(runner);
            if (row.state === 'effected')
              return {
                status: 'effected',
                acknowledgement: this.effectAcknowledgement(
                  this.effectRecord(prep, signed),
                ),
              };
            if (
              row.state === 'effecting' &&
              storedInteger(row.leaseUntil) > now
            )
              return { status: 'busy', reason: 'effect:lease' };
            const fence = Object.freeze({
              obligationId: prep.obligationId,
              preparationHash: prep.preparationHash,
              signedHash: signed.signedHash,
              destinationId: this.target.id,
              destinationProfile: this.target.profile,
              owner,
              generation: boundedInteger(
                storedInteger(row.generation) + 1n,
              ).toString(),
              leaseUntil: boundedInteger(now + lease).toString(),
            });
            await runner.query(
              "UPDATE ergo_credit_effect_execution SET state='effecting',owner=?,generation=?,leaseUntil=?,updatedAt=? WHERE obligationId=? AND state=? AND generation=?",
              [
                owner,
                fence.generation,
                fence.leaseUntil,
                now.toString(),
                prep.obligationId,
                row.state,
                row.generation,
              ],
            );
            if ((await runner.query('SELECT changes() AS n'))[0].n !== 1)
              throw new Conflict('effect:claim-cas');
            await this.fault?.('afterEffectClaimWrite');
            await this.fault?.('beforeEffectClaimCommit');
            if (
              !this.effectFenceMatches(
                await this.effectExecutionWith(runner, signed),
                fence,
                await this.signingTime(runner),
              )
            )
              throw new Conflict('effect:claim-expired');
            return { status: 'claimed', fence };
          },
          false,
        );
        if (result.status === 'claimed')
          await this.fault?.('afterEffectClaimCommit');
        return result;
      });
    } catch (error) {
      return error instanceof Conflict
        ? { status: 'conflict', reason: error.message }
        : { status: 'indeterminate', reason: 'effect:storage' };
    }
  }
  async applyEffectChecked(
    capability: unknown,
    fence: CreditEffectFence,
  ): Promise<CreditEffectResult> {
    const cap = checkedCreditPreparation(capability, this);
    if (!cap || cap.purpose !== 'effect')
      return { status: 'rejected', reason: 'effect:capability' };
    const bindingJson = cap.bindingJson;
    try {
      const captured = Object.freeze(structuredClone(fence));
      recordShape(
        captured,
        [
          'obligationId',
          'preparationHash',
          'signedHash',
          'destinationId',
          'destinationProfile',
          'owner',
          'generation',
          'leaseUntil',
        ],
        'effect-fence',
      );
      storedInteger(captured.generation);
      storedInteger(captured.leaseUntil);
      return await this.queue(async () => {
        const result = await this.transaction<CreditEffectResult>(
          async (runner) => {
            await this.checkIdentity(runner);
            const binding = this.parseBinding(bindingJson),
              prep = await this.load(runner, binding.obligationId);
            if (!prep)
              return { status: 'missing', reason: 'effect:preparation' };
            if (prep.bindingJson !== bindingJson)
              throw new Conflict('effect:binding');
            if (
              (await this.executionWith(runner, prep.obligationId)).state !==
              'signed'
            )
              return { status: 'missing', reason: 'effect:unsigned' };
            const signed = await this.signedWith(runner, prep),
              row = await this.effectExecutionWith(runner, signed);
            if (
              !this.effectFenceMatches(
                row,
                captured,
                await this.signingTime(runner),
              )
            )
              return { status: 'stale', reason: 'effect:fence' };
            const ledger = await this.ledgerWith(runner),
              effect = this.effectRecord(prep, signed);
            const inputs = JSON.parse(effect.inputsJson) as LedgerBox[],
              outputs = JSON.parse(effect.outputsJson) as LedgerBox[];
            for (const input of inputs) {
              const present = ledger.get(input.boxId);
              if (
                !present ||
                present.state !== 'unspent' ||
                present.boxHex !== input.boxHex
              )
                throw new Conflict('effect:input-unavailable');
            }
            await runner.query(
              'INSERT INTO ergo_credit_effect VALUES (?,?,?,?,?,?,?,?,?)',
              [
                effect.obligationId,
                effect.effectId,
                effect.nativeTxId,
                effect.preparationHash,
                effect.signedHash,
                effect.inputsJson,
                effect.outputsJson,
                effect.acknowledgement,
                effect.acknowledgementHash,
              ],
            );
            await this.fault?.('afterEffectWrite');
            await this.fault?.('afterEffectAck');
            for (const [i, input] of inputs.entries()) {
              await runner.query(
                "UPDATE ergo_credit_utxo SET state='spent',spentBy=? WHERE boxId=? AND boxHex=? AND state='unspent' AND spentBy IS NULL",
                [effect.effectId, input.boxId, input.boxHex],
              );
              if ((await runner.query('SELECT changes() AS n'))[0].n !== 1)
                throw new Conflict('effect:input-cas');
              await this.fault?.(`afterEffectSpend:${i}`);
            }
            for (const [i, output] of outputs.entries()) {
              await runner.query(
                "INSERT INTO ergo_credit_utxo VALUES (?,?,?,'unspent',NULL)",
                [output.boxId, output.boxHex, effect.effectId],
              );
              await this.fault?.(`afterEffectOutput:${i}`);
            }
            await runner.query(
              "UPDATE ergo_credit_effect_execution SET state='effected' WHERE obligationId=? AND state='effecting' AND owner=? AND generation=? AND leaseUntil=?",
              [
                captured.obligationId,
                captured.owner,
                captured.generation,
                captured.leaseUntil,
              ],
            );
            if ((await runner.query('SELECT changes() AS n'))[0].n !== 1)
              throw new Conflict('effect:apply-cas');
            await this.fault?.('afterEffectState');
            await this.fault?.('beforeEffectCommit');
            await this.ledgerWith(runner);
            const final = await this.effectExecutionWith(runner, signed);
            if (
              final.state !== 'effected' ||
              !this.effectFenceMatches(
                { ...final, state: 'effecting' },
                captured,
                await this.signingTime(runner),
              )
            )
              throw new Conflict('effect:commit-expired');
            return {
              status: 'effected',
              acknowledgement: this.effectAcknowledgement(effect),
            };
          },
          false,
        );
        if (result.status === 'effected')
          await this.fault?.('afterEffectCommit');
        return result;
      });
    } catch (error) {
      return error instanceof Conflict
        ? { status: 'conflict', reason: error.message }
        : { status: 'indeterminate', reason: 'effect:storage' };
    }
  }
  async verifyEffectAcknowledgement(
    raw: unknown,
    expected: Readonly<DeliveryClaim>,
  ): Promise<DurableAcknowledgement | undefined> {
    try {
      const copy = structuredClone(expected),
        bytes = acknowledgementBytes(structuredClone(raw), copy);
      if (!bytes) return;
      return await this.queue(() =>
        this.transaction(async (runner) => {
          await this.checkIdentity(runner);
          const prep = await this.load(runner, copy.obligationId);
          if (!prep) return;
          const binding = this.parseBinding(prep.bindingJson);
          if (
            binding.payload !== copy.payload ||
            binding.payloadHash !== copy.payloadHash ||
            binding.destinationId !== copy.destinationId ||
            binding.destinationProfile !== copy.destinationProfile
          )
            return;
          if (
            (await this.executionWith(runner, prep.obligationId)).state !==
            'signed'
          )
            return;
          const signed = await this.signedWith(runner, prep);
          if (
            (await this.effectExecutionWith(runner, signed)).state !==
            'effected'
          )
            return;
          await this.ledgerWith(runner);
          const effect = this.effectRecord(prep, signed);
          if (effect.acknowledgement !== bytes) return;
          return this.effectAcknowledgement(effect);
        }, false),
      );
    } catch {
      return;
    }
  }
  private async transaction<T>(
    operation: (runner: QueryRunner) => Promise<T>,
    withFault = true,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const runner = this.#db.createQueryRunner();
      try {
        await runner.startTransaction('SERIALIZABLE');
        await runner.query(
          'UPDATE ergo_credit_identity SET id=id WHERE singleton=1',
        );
        const result = await operation(runner);
        await runner.commitTransaction();
        if (withFault) await this.fault?.('afterCommit');
        return result;
      } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        const code = (error as { code?: string }).code;
        if (code === 'SQLITE_BUSY' && attempt < 5) {
          await new Promise((resolve) =>
            setTimeout(resolve, 10 * (attempt + 1)),
          );
          continue;
        }
        if (
          code === 'SQLITE_CONSTRAINT' &&
          /UNIQUE constraint failed/.test((error as Error).message)
        )
          throw new Conflict('preparation:ownership');
        throw error;
      } finally {
        await runner.release();
      }
    }
  }
}
