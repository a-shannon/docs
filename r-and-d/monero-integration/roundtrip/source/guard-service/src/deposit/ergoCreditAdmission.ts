import * as wasm from 'ergo-lib-wasm-nodejs';
import { createHash } from 'node:crypto';

import {
  verifyDeposit,
  decodeIntent,
  depositIdentity,
  economicOutputIdentity,
  type AcceptedDeposit,
  type DepositConfig,
  type FeePolicy,
  type ChainSnapshot,
  type VerificationProviders,
} from '@rosen-bridge/monero-deposit';

import {
  digest,
  type DepositRegistry,
  type DurableDecision,
  type DurableOutbox,
  type DurableOutput,
} from '../db/depositRegistry';
import type { DeliveryClaim } from './creditDelivery';
import { canonicalDecision, contextRecord } from './depositAdmission';

export interface ErgoExecutionProfile {
  domain: 'rosen-monero-ergo-execution';
  version: 1;
  configurationId: string;
  destinationId: string;
  authorityProfile: string;
  sourceNetwork: 'mainnet' | 'testnet' | 'stagenet';
  destinationNetwork: string;
  sourceAsset: 'XMR';
  destinationAsset: string;
  sourceDecimals: 12;
  destinationDecimals: 12;
  fees: {
    bridgeFee: string;
    networkFee: string;
    feeRatio: string;
    feeRatioDivisor: string;
    rsnRatio: string;
    rsnRatioDivisor: string;
  };
  rewards: {
    watchersPercent: number;
    watchersEmissionPercent: number;
    distribution: { address: string; percent: number }[];
    defaultAddress: string;
    networkAddress: string;
    emissionAddress: string;
    emissionTokenId: string;
  };
  contracts: {
    artifactDigest: string;
    trigger: string;
    permit: string;
    fraud: string;
    lock: string;
    guard: string;
    guardNFT: string;
    rwtId: string;
  };
  funding: { minerFee: string; minimumErg: string; additionalErg: string };
  guardBoxDigest: string;
  stateContextDigest: string;
}
export interface StoredErgoAdmission {
  decision: DurableDecision;
  outbox: DurableOutbox;
  outputs: DurableOutput[];
}
export interface ErgoAdmissionDependencies {
  registry: DepositRegistry;
  profile: ErgoExecutionProfile;
  providers: VerificationProviders;
  now(): bigint;
  readStoredAdmission(
    obligationId: string,
  ): Promise<StoredErgoAdmission | undefined>;
}
export interface VerifiedErgoAdmission {
  status: 'verified';
  claim: Readonly<DeliveryClaim>;
  profile: ErgoExecutionProfile;
  executionProfileDigest: string;
  envelopeDigest: string;
  obligationId: string;
  candidate: AcceptedDeposit;
  observation: {
    fromChain: 'monero';
    toChain: 'ergo';
    fromAddress: string;
    toAddress: string;
    amount: string;
    bridgeFee: string;
    networkFee: string;
    sourceChainTokenId: 'XMR';
    targetChainTokenId: string;
    sourceTxId: string;
    sourceBlockId: string;
    height: number;
  };
}
export type ErgoAdmissionResult =
  | VerifiedErgoAdmission
  | { status: 'rejected' | 'indeterminate'; reason: string };
const MAX_BYTES = 1_048_576;
export const MAX_ERGO_AMOUNT = (1n << 63n) - 1n;
const MAX_U64 = (1n << 64n) - 1n;
export class CreditRefusal extends Error {
  constructor(
    readonly reason: string,
    readonly status: 'rejected' | 'indeterminate' = 'rejected',
  ) {
    super(reason);
  }
}
export function requireCredit(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new CreditRefusal(reason);
}
export function recordShape(
  value: unknown,
  fields: string[],
  label: string,
): Record<string, unknown> {
  requireCredit(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    `${label}:schema`,
  );
  const object = value as Record<string, unknown>;
  requireCredit(
    Object.keys(object).sort().join(',') === fields.slice().sort().join(','),
    `${label}:fields`,
  );
  return object;
}
export function exactInteger(
  value: unknown,
  label: string,
  max = MAX_U64,
): bigint {
  requireCredit(
    typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value),
    `${label}:integer`,
  );
  const integer = BigInt(value);
  requireCredit(integer <= max, `${label}:range`);
  return integer;
}
export function exactHex(
  value: unknown,
  label: string,
  bytes?: number,
): string {
  requireCredit(
    typeof value === 'string' &&
      value.length <= MAX_BYTES * 2 &&
      /^(?:[0-9a-f]{2})+$/.test(value),
    `${label}:hex`,
  );
  requireCredit(
    bytes === undefined || value.length === bytes * 2,
    `${label}:length`,
  );
  return value;
}
export const boxDigest = (hex: string): string =>
  createHash('sha256')
    .update(Buffer.from(exactHex(hex, 'box'), 'hex'))
    .digest('hex');
function boundedText(
  value: unknown,
  label: string,
  limit = 4096,
): asserts value is string {
  requireCredit(
    typeof value === 'string' &&
      value.length > 0 &&
      Buffer.byteLength(value) <= limit,
    `${label}:text`,
  );
}
export function parseCanonical(bytes: unknown, label: string): unknown {
  boundedText(bytes, label, MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new CreditRefusal(`${label}:json`);
  }
  requireCredit(canonicalDecision(parsed) === bytes, `${label}:canonical`);
  return parsed;
}
/** Inverse of D2a's tagged evidence encoding. Keys and numeric spellings are unique. */
export function decodeTaggedEvidence(value: unknown, depth = 0): unknown {
  requireCredit(
    depth <= 16 &&
      Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= 2,
    'evidence:tag',
  );
  const [tag, item] = value;
  if (tag === 'null') {
    requireCredit(value.length === 1, 'evidence:null');
    return null;
  }
  requireCredit(value.length === 2, 'evidence:arity');
  if (tag === 'string' || tag === 'boolean') {
    requireCredit(typeof item === tag, 'evidence:type');
    return item;
  }
  if (tag === 'number') {
    requireCredit(
      typeof item === 'number' &&
        Number.isSafeInteger(item) &&
        !Object.is(item, -0),
      'evidence:number',
    );
    return item;
  }
  if (tag === 'bigint') {
    requireCredit(
      typeof item === 'string' && /^(0|-?[1-9][0-9]{0,99})$/.test(item),
      'evidence:bigint',
    );
    return BigInt(item);
  }
  if (tag === 'bytes') {
    requireCredit(
      typeof item === 'string' &&
        item.length <= MAX_BYTES * 2 &&
        /^(?:[0-9a-f]{2})*$/.test(item),
      'evidence:bytes',
    );
    return Uint8Array.from(Buffer.from(item, 'hex'));
  }
  requireCredit(Array.isArray(item) && item.length <= 4096, 'evidence:items');
  if (tag === 'array')
    return item.map((child) => decodeTaggedEvidence(child, depth + 1));
  requireCredit(tag === 'object', 'evidence:unknown-tag');
  const keys: string[] = [];
  const entries = item.map((entry) => {
    requireCredit(
      Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string',
      'evidence:entry',
    );
    keys.push(entry[0]);
    return [entry[0], decodeTaggedEvidence(entry[1], depth + 1)] as const;
  });
  requireCredit(
    new Set(keys).size === keys.length &&
      canonicalDecision(keys) === canonicalDecision(keys.slice().sort()),
    'evidence:keys',
  );
  return Object.fromEntries(entries);
}
export function profileDigest(profile: ErgoExecutionProfile): string {
  return digest(canonicalDecision(profile));
}
function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
export function profileTarget(profile: ErgoExecutionProfile) {
  return {
    id: profile.destinationId,
    profile: `rosen-monero-ergo-credit:v1:${profileDigest(profile)}`,
  };
}
export function validateProfile(value: ErgoExecutionProfile): void {
  recordShape(
    value,
    [
      'domain',
      'version',
      'configurationId',
      'destinationId',
      'authorityProfile',
      'sourceNetwork',
      'destinationNetwork',
      'sourceAsset',
      'destinationAsset',
      'sourceDecimals',
      'destinationDecimals',
      'fees',
      'rewards',
      'contracts',
      'funding',
      'guardBoxDigest',
      'stateContextDigest',
    ],
    'profile',
  );
  requireCredit(
    value.domain === 'rosen-monero-ergo-execution' && value.version === 1,
    'profile:version',
  );
  requireCredit(
    value.sourceDecimals === 12 && value.destinationDecimals === 12,
    'profile:decimals',
  );
  requireCredit(
    ['mainnet', 'testnet', 'stagenet'].includes(value.sourceNetwork) &&
      value.sourceAsset === 'XMR',
    'profile:source',
  );
  for (const name of [
    'configurationId',
    'destinationId',
    'authorityProfile',
    'destinationNetwork',
  ] as const)
    boundedText(value[name], `profile:${name}`, 256);
  for (const name of [
    'destinationAsset',
    'guardBoxDigest',
    'stateContextDigest',
  ] as const)
    exactHex(value[name], `profile:${name}`, 32);
  recordShape(
    value.fees,
    [
      'bridgeFee',
      'networkFee',
      'feeRatio',
      'feeRatioDivisor',
      'rsnRatio',
      'rsnRatioDivisor',
    ],
    'profile:fees',
  );
  for (const [name, amount] of Object.entries(value.fees))
    exactInteger(amount, `profile:${name}`, MAX_ERGO_AMOUNT);
  requireCredit(
    BigInt(value.fees.feeRatioDivisor) > 0n &&
      BigInt(value.fees.rsnRatioDivisor) > 0n,
    'profile:divisor',
  );
  recordShape(
    value.funding,
    ['minerFee', 'minimumErg', 'additionalErg'],
    'profile:funding',
  );
  for (const [name, amount] of Object.entries(value.funding))
    exactInteger(amount, `profile:${name}`, MAX_ERGO_AMOUNT);
  requireCredit(
    BigInt(value.funding.minimumErg) > 0n &&
      BigInt(value.funding.minerFee) > 0n,
    'profile:funding-zero',
  );
  recordShape(
    value.contracts,
    [
      'artifactDigest',
      'trigger',
      'permit',
      'fraud',
      'lock',
      'guard',
      'guardNFT',
      'rwtId',
    ],
    'profile:contracts',
  );
  requireCredit(
    value.contracts.artifactDigest ===
      'db9430417360cc6ed2955e1980f22accf143d05431a67db75495cb17a202062f',
    'profile:artifact',
  );
  for (const name of ['guardNFT', 'rwtId'] as const)
    exactHex(value.contracts[name], `profile:${name}`, 32);
  recordShape(
    value.rewards,
    [
      'watchersPercent',
      'watchersEmissionPercent',
      'distribution',
      'defaultAddress',
      'networkAddress',
      'emissionAddress',
      'emissionTokenId',
    ],
    'profile:rewards',
  );
  for (const name of ['watchersPercent', 'watchersEmissionPercent'] as const)
    requireCredit(
      Number.isInteger(value.rewards[name]) &&
        value.rewards[name] >= 0 &&
        value.rewards[name] <= 100,
      'profile:percent',
    );
  exactHex(value.rewards.emissionTokenId, 'profile:emissionTokenId', 32);
  requireCredit(
    Array.isArray(value.rewards.distribution) &&
      value.rewards.distribution.length <= 16,
    'profile:distribution',
  );
  let percent = 0;
  for (const receiver of value.rewards.distribution) {
    recordShape(receiver, ['address', 'percent'], 'profile:receiver');
    requireCredit(
      Number.isInteger(receiver.percent) &&
        receiver.percent >= 0 &&
        receiver.percent < 100,
      'profile:receiver-percent',
    );
    percent += receiver.percent;
    wasm.Address.from_base58(receiver.address);
  }
  requireCredit(percent < 100, 'profile:distribution-total');
  for (const address of [
    value.contracts.trigger,
    value.contracts.permit,
    value.contracts.fraud,
    value.contracts.lock,
    value.contracts.guard,
    value.rewards.defaultAddress,
    value.rewards.networkAddress,
    value.rewards.emissionAddress,
  ]) {
    boundedText(address, 'profile:address');
    wasm.Address.from_base58(address);
  }
}
function snapshot(value: unknown): ChainSnapshot {
  const r = recordShape(
    value,
    [
      'id',
      'network',
      'txid',
      'blockHash',
      'blockHeight',
      'chainHeight',
      'minConfirmations',
    ],
    'snapshot',
  );
  return {
    ...r,
    blockHeight: exactInteger(r.blockHeight, 'snapshot:blockHeight'),
    chainHeight: exactInteger(r.chainHeight, 'snapshot:chainHeight'),
    minConfirmations: exactInteger(
      r.minConfirmations,
      'snapshot:minConfirmations',
    ),
  } as ChainSnapshot;
}
/** Only an authenticated local delivery is reproduced; no new chain observation is implied. */
export async function verifyErgoCreditAdmission(
  claim: DeliveryClaim,
  deps: ErgoAdmissionDependencies,
): Promise<ErgoAdmissionResult> {
  try {
    recordShape(
      claim,
      [
        'obligationId',
        'payloadHash',
        'payload',
        'destinationId',
        'destinationProfile',
        'owner',
        'generation',
        'leaseUntil',
      ],
      'claim',
    );
    for (const [name, value] of Object.entries(claim))
      boundedText(value, `claim:${name}`, name === 'payload' ? MAX_BYTES : 256);
    const copy = Object.freeze({ ...claim });
    const profile = structuredClone(deps.profile);
    validateProfile(profile);
    if (!(await deps.registry.validateDeliveryClaim(copy, deps.now())))
      throw new CreditRefusal('claim:stale');
    const target = profileTarget(profile);
    requireCredit(
      copy.destinationId === target.id &&
        copy.destinationProfile === target.profile,
      'claim:destination',
    );
    exactHex(copy.payloadHash, 'payloadHash', 32);
    requireCredit(digest(copy.payload) === copy.payloadHash, 'payload:digest');
    const payload = recordShape(
      parseCanonical(copy.payload, 'payload'),
      [
        'domain',
        'version',
        'authorityMode',
        'evidenceMode',
        'obligationId',
        'envelopeDigest',
        'envelope',
        'authority',
      ],
      'payload',
    );
    requireCredit(
      payload.domain === 'rosen-monero-credit-outbox' &&
        payload.version === 1 &&
        payload.authorityMode === 'synthetic',
      'payload:version',
    );
    const envelope = recordShape(
      parseCanonical(payload.envelope, 'envelope'),
      [
        'domain',
        'version',
        'authorityMode',
        'authorityProfile',
        'obligationId',
        'retryFingerprint',
        'rawInputs',
        'candidate',
        'configuration',
        'configurationDigest',
        'feePolicy',
        'feePolicyDigest',
        'context',
      ],
      'envelope',
    );
    requireCredit(
      envelope.domain === 'rosen-monero-deposit-decision' &&
        envelope.version === 1 &&
        envelope.authorityMode === 'synthetic',
      'envelope:version',
    );
    const envelopeBytes = payload.envelope as string;
    const envelopeDigest = digest(envelopeBytes);
    requireCredit(
      envelopeDigest === payload.envelopeDigest &&
        payload.obligationId === copy.obligationId &&
        envelope.obligationId === copy.obligationId,
      'envelope:binding',
    );
    requireCredit(
      envelope.authorityProfile === profile.authorityProfile,
      'authority:profile',
    );
    const authority = recordShape(
      payload.authority,
      ['mode', 'profile', 'decisionDigest'],
      'authority',
    );
    requireCredit(
      authority.mode === 'synthetic' &&
        authority.profile === profile.authorityProfile &&
        authority.decisionDigest === envelopeDigest,
      'authority:binding',
    );
    const raw = recordShape(
      envelope.rawInputs,
      ['intentBytesHex', 'proof', 'receipt'],
      'rawInputs',
    );
    const intentBytes = Buffer.from(
      exactHex(raw.intentBytesHex, 'intent'),
      'hex',
    );
    boundedText(raw.proof, 'proof', MAX_BYTES);
    const intent = decodeIntent(intentBytes);
    const depositId = depositIdentity(intent.source_network, intent.txid);
    requireCredit(
      copy.obligationId ===
        `monero:credit:${intent.source_network}:${intent.txid}`,
      'obligation:identity',
    );
    const configuration = recordShape(
      envelope.configuration,
      ['revision', 'value'],
      'configuration',
    );
    const configurationValue = recordShape(
      configuration.value,
      [
        'version',
        'domain',
        'sourceNetwork',
        'vaultEpoch',
        'vaultAddress',
        'destinationNetwork',
        'destinationAsset',
        'nativeSourcePin',
      ],
      'configuration:value',
    );
    const feePolicy = recordShape(
      envelope.feePolicy,
      [
        'bridgeFee',
        'networkFee',
        'sourceDecimals',
        'destinationDecimals',
        'remainder',
      ],
      'feePolicy',
    );
    requireCredit(
      digest(canonicalDecision(configuration)) ===
        envelope.configurationDigest &&
        digest(canonicalDecision(feePolicy)) === envelope.feePolicyDigest,
      'configuration:digest',
    );
    requireCredit(
      configurationValue.sourceNetwork === profile.sourceNetwork &&
        configurationValue.destinationNetwork === profile.destinationNetwork &&
        configurationValue.destinationAsset === profile.destinationAsset,
      'profile:configuration',
    );
    requireCredit(
      feePolicy.sourceDecimals === 12 && feePolicy.destinationDecimals === 12,
      'admission:decimals',
    );
    const context = recordShape(
      envelope.context,
      ['id', 'revision', 'digest', 'snapshot'],
      'context',
    );
    const originalSnapshot = snapshot(context.snapshot);
    const rebuiltContext = contextRecord({
      id: context.id as string,
      revision: exactInteger(context.revision, 'context:revision'),
      configurationRevision: configuration.revision as string,
      configuration: configurationValue as unknown as Omit<
        DepositConfig,
        'snapshot' | 'creditedOutputIds' | 'creditedDepositIds'
      >,
      feePolicy: feePolicy as unknown as FeePolicy,
      snapshot: originalSnapshot,
    });
    requireCredit(rebuiltContext.digest === context.digest, 'context:digest');
    const retryFingerprint = digest(
      canonicalDecision({
        domain: 'rosen-monero-deposit-retry',
        version: 1,
        contextId: context.id,
        configurationDigest: envelope.configurationDigest,
        feePolicyDigest: envelope.feePolicyDigest,
        authorityProfile: profile.authorityProfile,
        rawInputs: raw,
      }),
    );
    requireCredit(
      retryFingerprint === envelope.retryFingerprint,
      'retry:binding',
    );
    const stored = structuredClone(
      await deps.readStoredAdmission(copy.obligationId),
    );
    if (!stored)
      throw new CreditRefusal('storage:unavailable', 'indeterminate');
    const expectedDecision: DurableDecision = {
      id: depositId,
      sourceNetwork: intent.source_network,
      txid: intent.txid,
      retryFingerprint,
      envelopeDigest,
      envelope: envelopeBytes,
      authority: canonicalDecision(authority),
      contextDigest: rebuiltContext.digest,
    };
    const expectedOutbox: DurableOutbox = {
      decisionId: depositId,
      obligationId: copy.obligationId,
      payloadHash: copy.payloadHash,
      payload: copy.payload,
      status: 'pending',
    };
    requireCredit(
      canonicalDecision(stored.decision) ===
        canonicalDecision(expectedDecision) &&
        canonicalDecision(stored.outbox) === canonicalDecision(expectedOutbox),
      'storage:decision',
    );
    const receipt = decodeTaggedEvidence(raw.receipt);
    const candidate = await verifyDeposit(
      intentBytes,
      raw.proof,
      receipt,
      {
        ...(configurationValue as unknown as Omit<
          DepositConfig,
          'snapshot' | 'creditedOutputIds' | 'creditedDepositIds'
        >),
        snapshot: originalSnapshot,
        creditedOutputIds: new Set(),
        creditedDepositIds: new Set(),
      },
      feePolicy as unknown as FeePolicy,
      deps.providers,
    );
    if (candidate.status !== 'accepted') return candidate;
    requireCredit(
      canonicalDecision(candidate) === canonicalDecision(envelope.candidate),
      'decision:recomputation',
    );
    requireCredit(
      candidate.evidenceMode === payload.evidenceMode,
      'evidence:mode',
    );
    const expectedOutputs: DurableOutput[] = candidate.outputs.map(
      (output) => ({
        economicId: economicOutputIdentity(
          candidate.sourceNetwork,
          output.publicKey,
        ),
        sourceNetwork: candidate.sourceNetwork,
        publicKey: output.publicKey,
        txid: candidate.txid,
        outputIndex: output.outputIndex.toString(),
        amount: output.amount.toString(),
        decisionId: depositId,
      }),
    );
    requireCredit(
      Array.isArray(stored.outputs) &&
        stored.outputs.length === expectedOutputs.length &&
        new Set(stored.outputs.map((o) => o.economicId)).size ===
          expectedOutputs.length,
      'storage:outputs',
    );
    const sortOutputs = (outputs: DurableOutput[]) =>
      outputs.slice().sort((a, b) => a.economicId.localeCompare(b.economicId));
    requireCredit(
      canonicalDecision(sortOutputs(stored.outputs)) ===
        canonicalDecision(sortOutputs(expectedOutputs)),
      'storage:ownership',
    );
    for (const amount of [
      candidate.amount,
      candidate.bridgeFee,
      candidate.networkFee,
      candidate.netAmount,
      candidate.destinationAmount,
    ])
      requireCredit(
        amount >= 0n && amount <= MAX_ERGO_AMOUNT,
        'amount:ergo-range',
      );
    requireCredit(
      candidate.retainedAtomicRemainder === 0n &&
        candidate.netAmount === candidate.destinationAmount,
      'amount:units',
    );
    requireCredit(
      candidate.blockHeight <= BigInt(Number.MAX_SAFE_INTEGER),
      'height:precision',
    );
    const executionProfileDigest = profileDigest(profile);
    const binding = canonicalDecision({
      domain: 'rosen-monero-credit',
      version: 1,
      obligationId: copy.obligationId,
      envelopeDigest,
      executionProfileDigest,
    });
    if (!(await deps.registry.validateDeliveryClaim(copy, deps.now())))
      throw new CreditRefusal('claim:stale');
    return freezeTree({
      status: 'verified' as const,
      claim: copy,
      profile,
      executionProfileDigest,
      envelopeDigest,
      obligationId: copy.obligationId,
      candidate,
      observation: {
        fromChain: 'monero',
        toChain: 'ergo',
        fromAddress: `rosen-monero-credit:v1:${digest(binding)}`,
        toAddress: candidate.recipient,
        amount: candidate.amount.toString(),
        bridgeFee: candidate.bridgeFee.toString(),
        networkFee: candidate.networkFee.toString(),
        sourceChainTokenId: 'XMR' as const,
        targetChainTokenId: candidate.destinationAsset,
        sourceTxId: candidate.txid,
        sourceBlockId: candidate.blockHash,
        height: Number(candidate.blockHeight),
      },
    } as VerifiedErgoAdmission);
  } catch (error) {
    return error instanceof CreditRefusal
      ? { status: error.status, reason: error.reason }
      : { status: 'indeterminate', reason: 'credit:unavailable' };
  }
}
