import {
  decodeIntent,
  depositIdentity,
  verifyDeposit,
  uint64,
  IntentCodecError,
  type ChainSnapshot,
  type DepositConfig,
  type FeePolicy,
  type VerificationProviders,
} from '@rosen-bridge/monero-deposit';

import {
  DepositRegistry,
  digest,
  type RegistryResult,
  type ContextRecord,
} from '../db/depositRegistry';

export interface DepositContext {
  id: string;
  revision: bigint;
  configurationRevision: string;
  configuration: Omit<
    DepositConfig,
    'snapshot' | 'creditedOutputIds' | 'creditedDepositIds'
  >;
  feePolicy: FeePolicy;
  snapshot: ChainSnapshot;
}
export interface DepositRequest {
  intentBytes: Uint8Array;
  proof: string;
  receiptEvidence: unknown;
}
export interface SyntheticAuthority {
  profile: string;
  authorize(
    bytes: Uint8Array,
    decisionDigest: string,
  ): Promise<{ mode: 'synthetic'; profile: string; decisionDigest: string }>;
}
export interface AdmissionDependencies {
  registry: DepositRegistry;
  contextId: string;
  providers: VerificationProviders;
  authority: SyntheticAuthority;
}
export type AdmissionResult =
  | RegistryResult
  | { status: 'rejected'; reason: string };

/** Versioned envelope schema represents its declared bigint fields as decimal strings. */
export function canonicalDecision(value: unknown): string {
  function normalize(item: unknown, depth = 0): unknown {
    if (depth > 32) throw new Error('Envelope nesting limit');
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return item;
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'number' && Number.isSafeInteger(item)) return item;
    if (Array.isArray(item))
      return item.map((child) => normalize(child, depth + 1));
    if (
      typeof item === 'object' &&
      item !== null &&
      Object.getPrototypeOf(item) === Object.prototype
    )
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [
            key,
            normalize((item as Record<string, unknown>)[key], depth + 1),
          ]),
      );
    throw new Error('Unsupported canonical value');
  }
  return JSON.stringify(normalize(value));
}
// Tag every raw evidence type, preventing bigint/string/depositor-object collisions.
function taggedEvidence(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new Error('Evidence nesting limit');
  if (value === null) return ['null'];
  if (typeof value === 'string' || typeof value === 'boolean')
    return [typeof value, value];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return ['number', value];
  if (value instanceof Uint8Array)
    return ['bytes', Buffer.from(value).toString('hex')];
  if (Array.isArray(value))
    return ['array', value.map((child) => taggedEvidence(child, depth + 1))];
  if (
    value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return [
      'object',
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          taggedEvidence((value as Record<string, unknown>)[key], depth + 1),
        ]),
    ];
  throw new Error('Unsupported evidence');
}
/** Trusted operator composition records a deciding context before admission. */
export function contextRecord(context: DepositContext): ContextRecord {
  if (
    !context.id ||
    !context.configurationRevision ||
    uint64(context.revision, 'context_revision') < 1n
  )
    throw new Error('Invalid context identity');
  const body = canonicalDecision(context);
  return { id: context.id, body, digest: digest(body) };
}
function decodeContext(record: ContextRecord): DepositContext {
  if (digest(record.body) !== record.digest)
    throw new Error('Context digest mismatch');
  const parsed = JSON.parse(record.body);
  parsed.revision = BigInt(parsed.revision);
  for (const name of ['blockHeight', 'chainHeight', 'minConfirmations'])
    parsed.snapshot[name] = BigInt(parsed.snapshot[name]);
  if (contextRecord(parsed).body !== record.body || parsed.id !== record.id)
    throw new Error('Noncanonical context');
  return parsed;
}
/** Raw inputs only; providers and synthetic authority are trusted composition. */
export async function admitDeposit(
  request: DepositRequest,
  deps: AdmissionDependencies,
): Promise<AdmissionResult> {
  try {
    if (
      !request ||
      !(request.intentBytes instanceof Uint8Array) ||
      typeof request.proof !== 'string' ||
      Object.keys(request).sort().join(',') !==
        'intentBytes,proof,receiptEvidence'
    )
      return { status: 'rejected', reason: 'request:schema' };
    const input = structuredClone(request);
    const intent = decodeIntent(input.intentBytes);
    const contextId = deps.contextId;
    const authorityProfile = deps.authority.profile;
    if (typeof authorityProfile !== 'string' || !authorityProfile)
      return { status: 'indeterminate', reason: 'authority:profile' };
    const storedContext = await deps.registry.readContext(contextId);
    if (!storedContext)
      return { status: 'indeterminate', reason: 'context:missing' };
    const context = decodeContext(storedContext);
    const configuration = {
      revision: context.configurationRevision,
      value: context.configuration,
    };
    const configurationDigest = digest(canonicalDecision(configuration));
    const feePolicyDigest = digest(canonicalDecision(context.feePolicy));
    const rawInputs = {
      intentBytesHex: Buffer.from(input.intentBytes).toString('hex'),
      proof: input.proof,
      receipt: taggedEvidence(input.receiptEvidence),
    };
    if (Buffer.byteLength(canonicalDecision(rawInputs)) > 1_048_576)
      return { status: 'indeterminate', reason: 'request:evidence-limit' };
    const retryFingerprint = digest(
      canonicalDecision({
        domain: 'rosen-monero-deposit-retry',
        version: 1,
        contextId,
        configurationDigest,
        feePolicyDigest,
        authorityProfile,
        rawInputs,
      }),
    );
    const id = depositIdentity(intent.source_network, intent.txid);
    // Exact committed retries retain their original context/expiry; no reauthorization.
    const replay = await deps.registry.replay(id, retryFingerprint);
    if (replay) return replay;
    const candidate = await verifyDeposit(
      input.intentBytes,
      input.proof,
      input.receiptEvidence,
      {
        ...context.configuration,
        snapshot: context.snapshot,
        creditedOutputIds: new Set(),
        creditedDepositIds: new Set(),
      },
      context.feePolicy,
      deps.providers,
    );
    if (candidate.status !== 'accepted') return candidate;
    const obligationId = `monero:credit:${candidate.sourceNetwork}:${candidate.txid}`;
    const envelope = canonicalDecision({
      domain: 'rosen-monero-deposit-decision',
      version: 1,
      authorityMode: 'synthetic',
      authorityProfile,
      obligationId,
      retryFingerprint,
      rawInputs,
      candidate,
      configuration,
      configurationDigest,
      feePolicy: context.feePolicy,
      feePolicyDigest,
      context: {
        id: context.id,
        revision: context.revision,
        digest: storedContext.digest,
        snapshot: context.snapshot,
      },
    });
    const envelopeDigest = digest(envelope);
    const authority = structuredClone(
      await deps.authority.authorize(Buffer.from(envelope), envelopeDigest),
    );
    if (
      !authority ||
      authority.mode !== 'synthetic' ||
      authority.profile !== authorityProfile ||
      authority.decisionDigest !== envelopeDigest ||
      Object.keys(authority).sort().join(',') !== 'decisionDigest,mode,profile'
    )
      return { status: 'indeterminate', reason: 'authority:binding' };
    const payload = canonicalDecision({
      domain: 'rosen-monero-credit-outbox',
      version: 1,
      authorityMode: 'synthetic',
      evidenceMode: candidate.evidenceMode,
      obligationId,
      envelopeDigest,
      envelope,
      authority,
    });
    return await deps.registry.commit({
      contextId,
      expiresAtHeight: candidate.expiresAtHeight.toString(),
      decision: {
        id,
        sourceNetwork: candidate.sourceNetwork,
        txid: candidate.txid,
        retryFingerprint,
        envelopeDigest,
        envelope,
        authority: canonicalDecision(authority),
        contextDigest: storedContext.digest,
      },
      outputs: candidate.outputs.map((output) => ({
        economicId: output.economicId,
        sourceNetwork: candidate.sourceNetwork,
        publicKey: output.publicKey,
        txid: candidate.txid,
        outputIndex: output.outputIndex.toString(),
        amount: output.amount.toString(),
        decisionId: id,
      })),
      outbox: {
        decisionId: id,
        obligationId,
        payloadHash: digest(payload),
        payload,
        status: 'pending',
      },
    });
  } catch (error) {
    if (error instanceof IntentCodecError)
      return { status: 'rejected', reason: error.code };
    return { status: 'indeterminate', reason: 'admission:unavailable' };
  }
}
