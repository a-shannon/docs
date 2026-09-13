import type {
  DepositConfig,
  FeePolicy,
  Verification,
  VerificationProviders,
} from './evidence.js';
import { NATIVE_SOURCE_PIN } from './evidence.js';
import {
  atomic,
  decodeIntent,
  hex32,
  intentHash,
  IntentCodecError,
  MAX_OUTPUTS,
  MAX_U64,
  uint64,
} from './intentCodec.js';

export interface AcceptedOutput {
  outputIndex: bigint;
  publicKey: string;
  amount: bigint;
  locator: string;
  economicId: string;
}

export interface AcceptedDeposit {
  status: 'accepted';
  authority: 'stateless-candidate';
  evidenceMode: 'fixture' | 'independent';
  depositId: string;
  intentHash: string;
  intentBytesHex: string;
  sourceNetwork: string;
  txid: string;
  blockHash: string;
  blockHeight: bigint;
  snapshotId: string;
  checkedAtHeight: bigint;
  expiresAtHeight: bigint;
  vaultEpoch: string;
  vaultAddress: string;
  destinationNetwork: string;
  destinationAsset: string;
  recipient: string;
  amount: bigint;
  bridgeFee: bigint;
  networkFee: bigint;
  netAmount: bigint;
  destinationAmount: bigint;
  retainedAtomicRemainder: bigint;
  outputs: readonly AcceptedOutput[];
  verifierReferences: readonly string[];
}
export type DepositDecision =
  | AcceptedDeposit
  | { status: 'rejected'; reason: string }
  | { status: 'indeterminate'; reason: string };

class DecisionError extends Error {
  constructor(
    readonly status: 'rejected' | 'indeterminate',
    readonly reason: string,
  ) {
    super(reason);
  }
}

function requireEvidence(
  ok: boolean,
  reason: string,
  status: 'rejected' | 'indeterminate' = 'rejected',
): asserts ok {
  if (!ok) throw new DecisionError(status, reason);
}

async function verified<T>(
  scope: string,
  operation: () => Promise<Verification<T>>,
): Promise<T> {
  let result: Verification<T>;
  try {
    result = await operation();
  } catch {
    throw new DecisionError('indeterminate', `${scope}:unavailable`);
  }
  requireEvidence(
    result !== null && typeof result === 'object',
    `${scope}:malformed`,
    'indeterminate',
  );
  if (result.status === 'invalid' || result.status === 'unavailable') {
    requireEvidence(
      typeof result.reason === 'string' && result.reason.length > 0,
      `${scope}:malformed`,
      'indeterminate',
    );
  }
  if (result.status === 'invalid')
    throw new DecisionError('rejected', `${scope}:${result.reason}`);
  if (result.status === 'unavailable')
    throw new DecisionError('indeterminate', `${scope}:${result.reason}`);
  requireEvidence(
    result.status === 'verified',
    `${scope}:malformed`,
    'indeterminate',
  );
  return structuredClone(result.value);
}

type FieldCheck = (value: unknown) => boolean;
const textField: FieldCheck = (value) =>
  typeof value === 'string' && value.length > 0;
const boolField: FieldCheck = (value) => typeof value === 'boolean';
const uintField: FieldCheck = (value) =>
  typeof value === 'bigint' && value >= 0n && value <= MAX_U64;
const hashField: FieldCheck = (value) =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const networkField: FieldCheck = (value) =>
  value === 'mainnet' || value === 'testnet' || value === 'stagenet';

/** Incomplete or malformed observations cannot establish a negative fact. */
function observationShape(
  scope: string,
  value: unknown,
  fields: Record<string, FieldCheck>,
): void {
  requireEvidence(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${scope}:malformed`,
    'indeterminate',
  );
  const record = value as Record<string, unknown>;
  requireEvidence(
    Object.entries(fields).every(
      ([name, check]) => Object.hasOwn(record, name) && check(record[name]),
    ),
    `${scope}:malformed`,
    'indeterminate',
  );
}

function network(
  value: unknown,
): asserts value is 'mainnet' | 'testnet' | 'stagenet' {
  requireEvidence(
    value === 'mainnet' || value === 'testnet' || value === 'stagenet',
    'network:unsupported',
  );
}

export function depositIdentity(sourceNetwork: string, txid: string): string {
  network(sourceNetwork);
  return `monero:deposit:${sourceNetwork}:${hex32(txid, 'txid')}`;
}

export function outputLocator(
  sourceNetwork: string,
  txid: string,
  index: bigint,
): string {
  return `${depositIdentity(sourceNetwork, txid)}:${uint64(index, 'output_index')}`;
}

export function economicOutputIdentity(
  sourceNetwork: string,
  publicKey: string,
): string {
  network(sourceNetwork);
  return `monero:output-key:${sourceNetwork}:${hex32(publicKey, 'output_public_key')}`;
}

const acceptedCandidates = new WeakSet<AcceptedDeposit>();

/**
 * All providers and config are trusted composition dependencies. ReceiptEvidence
 * and depositor bytes are untrusted inputs; no caller-supplied verdict is read.
 * Acceptance is provisional even with independent providers: D2/D3 own durable
 * reservation, currentness at commitment, distributed authority and settlement.
 */
export async function verifyDeposit(
  intentBytes: Uint8Array,
  proof: string,
  receiptEvidence: unknown,
  inputConfig: DepositConfig,
  inputFeePolicy: FeePolicy,
  providers?: VerificationProviders,
): Promise<DepositDecision> {
  try {
    const intent = decodeIntent(intentBytes);
    const raw = Uint8Array.from(intentBytes);
    // Snapshot mutable caller inputs before the first asynchronous boundary.
    const config = structuredClone(inputConfig);
    const feePolicy = structuredClone(inputFeePolicy);
    const receiptInput = structuredClone(receiptEvidence);
    const snapshot = config.snapshot;
    try {
      network(config.sourceNetwork);
      hex32(snapshot.txid, 'snapshot_txid');
      hex32(snapshot.blockHash, 'snapshot_block');
      uint64(snapshot.blockHeight, 'block_height');
      uint64(snapshot.chainHeight, 'chain_height');
      uint64(snapshot.minConfirmations, 'min_confirmations');
      requireEvidence(
        snapshot.id.length > 0 &&
          snapshot.network === config.sourceNetwork &&
          snapshot.minConfirmations > 0n &&
          snapshot.chainHeight > snapshot.blockHeight,
        'config:snapshot',
        'indeterminate',
      );
      requireEvidence(
        config.nativeSourcePin === NATIVE_SOURCE_PIN,
        'config:native-source-pin',
        'indeterminate',
      );
      requireEvidence(
        config.creditedOutputIds instanceof Set &&
          config.creditedDepositIds instanceof Set,
        'config:credit-view',
        'indeterminate',
      );
      atomic(feePolicy.bridgeFee, 'quoted_bridge_fee');
      atomic(feePolicy.networkFee, 'quoted_network_fee');
      requireEvidence(
        feePolicy.sourceDecimals === 12 &&
          Number.isInteger(feePolicy.destinationDecimals) &&
          feePolicy.destinationDecimals >= 0 &&
          feePolicy.destinationDecimals <= 18 &&
          (feePolicy.remainder === 'reject' ||
            feePolicy.remainder === 'retain'),
        'config:conversion',
        'indeterminate',
      );
    } catch (error) {
      if (error instanceof DecisionError) throw error;
      throw new DecisionError('indeterminate', 'config:malformed');
    }

    const fields = [
      ['domain', config.domain],
      ['version', config.version],
      ['source_network', config.sourceNetwork],
      ['vault_epoch', config.vaultEpoch],
      ['vault_address', config.vaultAddress],
      ['destination_network', config.destinationNetwork],
      ['destination_asset', config.destinationAsset],
      ['bridge_fee', feePolicy.bridgeFee],
      ['network_fee', feePolicy.networkFee],
      ['txid', snapshot.txid],
    ] as const;
    for (const [name, expected] of fields)
      requireEvidence(intent[name] === expected, `config:${name}`);
    requireEvidence(
      snapshot.chainHeight <= intent.expiry_height,
      'intent:expired',
    );
    const amount = atomic(intent.amount, 'amount');
    const bridgeFee = atomic(intent.bridge_fee, 'bridge_fee');
    const networkFee = atomic(intent.network_fee, 'network_fee');
    requireEvidence(
      amount > bridgeFee + networkFee,
      'amount:fees-consume-deposit',
    );
    const netAmount = amount - bridgeFee - networkFee;
    const decimalDifference =
      feePolicy.destinationDecimals - feePolicy.sourceDecimals;
    const factor = 10n ** BigInt(Math.abs(decimalDifference));
    const destinationAmount =
      decimalDifference >= 0 ? netAmount * factor : netAmount / factor;
    const remainder = decimalDifference >= 0 ? 0n : netAmount % factor;
    requireEvidence(destinationAmount > 0n, 'amount:zero-destination');
    requireEvidence(
      remainder === 0n || feePolicy.remainder === 'retain',
      'amount:conversion-remainder',
    );
    uint64(destinationAmount, 'destination_amount');
    requireEvidence(
      typeof proof === 'string' && proof.startsWith('OutProofV2'),
      'proof:outbound-v2',
    );
    const body = proof.slice(10);
    requireEvidence(
      body.length >= 132 &&
        body.length <= 65536 &&
        body.length % 132 === 0 &&
        /^[1-9A-HJ-NP-Za-km-z]+$/.test(body),
      'proof:encoding',
    );
    requireEvidence(
      !!providers?.proof?.verify &&
        !!providers.receipt?.reconstruct &&
        !!providers.addresses?.verify,
      'verifier:unavailable',
      'indeterminate',
    );
    const identities = structuredClone([
      providers.proof.identity,
      providers.receipt.identity,
      providers.addresses.identity,
    ]);
    for (const identity of identities) {
      requireEvidence(
        (identity.kind === 'fixture' || identity.kind === 'independent') &&
          typeof identity.id === 'string' &&
          identity.id.length > 0 &&
          /^[0-9a-f]{40,64}$/.test(identity.sourcePin),
        'verifier:identity',
        'indeterminate',
      );
    }
    requireEvidence(
      identities[0].sourcePin === config.nativeSourcePin,
      'verifier:native-source-pin',
      'indeterminate',
    );
    const verifyAddress = providers.addresses.verify.bind(providers.addresses);
    const verifyProof = providers.proof.verify.bind(providers.proof);
    const reconstruct = providers.receipt.reconstruct.bind(providers.receipt);
    const addressRequest = {
      sourceNetwork: config.sourceNetwork,
      vaultAddress: intent.vault_address,
      destinationNetwork: intent.destination_network,
      destinationAsset: intent.destination_asset,
      recipient: intent.to_address,
    };
    const addresses = await verified('address', () =>
      verifyAddress(structuredClone(addressRequest)),
    );
    observationShape('address', addresses, {
      sourceNetwork: networkField,
      vaultAddress: textField,
      destinationNetwork: textField,
      destinationAsset: textField,
      recipient: textField,
    });
    for (const name of Object.keys(
      addressRequest,
    ) as (keyof typeof addressRequest)[]) {
      requireEvidence(
        addresses[name] === addressRequest[name],
        `address:${name}`,
      );
    }
    const proofRequest = {
      sourcePin: config.nativeSourcePin,
      network: config.sourceNetwork,
      txid: intent.txid,
      vaultAddress: intent.vault_address,
      messageBytes: Uint8Array.from(raw),
      proof,
      snapshotId: snapshot.id,
    };
    const native = await verified('proof', () =>
      verifyProof(structuredClone(proofRequest)),
    );
    observationShape('proof', native, {
      sourcePin: (value) =>
        typeof value === 'string' && /^[0-9a-f]{40}$/.test(value),
      network: networkField,
      txid: hashField,
      vaultAddress: textField,
      messageBytes: (value) => value instanceof Uint8Array,
      proof: textField,
      snapshotId: textField,
      good: boolField,
      received: uintField,
      inPool: boolField,
      confirmations: uintField,
    });
    for (const name of [
      'sourcePin',
      'network',
      'txid',
      'vaultAddress',
      'proof',
      'snapshotId',
    ] as const) {
      requireEvidence(native[name] === proofRequest[name], `proof:${name}`);
    }
    requireEvidence(
      native.messageBytes instanceof Uint8Array &&
        Buffer.from(native.messageBytes).equals(Buffer.from(raw)),
      'proof:message',
    );
    requireEvidence(native.good === true, 'proof:cryptographic-result');
    requireEvidence(native.inPool === false, 'proof:pool', 'indeterminate');
    requireEvidence(
      uint64(native.received, 'proof_received') === amount,
      'proof:amount',
    );
    requireEvidence(
      uint64(native.confirmations, 'proof_confirmations') ===
        snapshot.chainHeight - snapshot.blockHeight,
      'proof:confirmation-snapshot',
      'indeterminate',
    );
    requireEvidence(
      native.confirmations >= snapshot.minConfirmations,
      'proof:confirmations',
      'indeterminate',
    );
    const receipt = await verified('receipt', () =>
      reconstruct(intent, receiptInput, structuredClone(snapshot)),
    );
    observationShape('receipt', receipt, {
      network: networkField,
      txid: hashField,
      vaultAddress: textField,
      blockHash: hashField,
      blockHeight: uintField,
      snapshotId: textField,
      inPool: boolField,
      outputs: Array.isArray,
    });
    requireEvidence(
      receipt.outputs.length > 0 && receipt.outputs.length <= MAX_OUTPUTS,
      'receipt:output-count',
    );
    // Validate every output before interpreting any economic observation.
    for (const output of receipt.outputs) {
      observationShape('output', output, {
        index: uintField,
        publicKey: hashField,
        amount: uintField,
        owned: boolField,
        maturity: (value) =>
          value === 'unlocked' || value === 'locked' || value === 'unknown',
        spent: (value) =>
          value === 'unspent' || value === 'spent' || value === 'unknown',
        keyOccurrences: uintField,
      });
    }
    for (const [name, expected] of [
      ['network', config.sourceNetwork],
      ['txid', intent.txid],
      ['vaultAddress', intent.vault_address],
    ] as const) {
      requireEvidence(receipt[name] === expected, `receipt:${name}`);
    }
    requireEvidence(
      receipt.snapshotId === snapshot.id &&
        receipt.blockHash === snapshot.blockHash &&
        receipt.blockHeight === snapshot.blockHeight,
      'receipt:snapshot',
      'indeterminate',
    );
    requireEvidence(receipt.inPool === false, 'receipt:pool', 'indeterminate');
    requireEvidence(
      intent.version !== 1 || receipt.outputs.length === 1,
      'receipt:v1-one-output',
    );
    const seenIndices = new Set<bigint>();
    const seenKeys = new Set<string>();
    let sum = 0n;
    const id = depositIdentity(config.sourceNetwork, intent.txid);
    const outputs = receipt.outputs
      .map((output) => {
        const index = uint64(output.index, 'output_index');
        const key = hex32(output.publicKey, 'output_public_key');
        requireEvidence(!seenIndices.has(index), 'output:duplicate-index');
        requireEvidence(!seenKeys.has(key), 'output:duplicate-key');
        seenIndices.add(index);
        seenKeys.add(key);
        requireEvidence(output.owned === true, 'output:ownership');
        requireEvidence(
          output.maturity === 'unlocked',
          'output:maturity',
          'indeterminate',
        );
        requireEvidence(
          output.spent !== 'unknown',
          'output:spent-unavailable',
          'indeterminate',
        );
        requireEvidence(output.spent === 'unspent', 'output:spent');
        requireEvidence(
          uint64(output.keyOccurrences, 'key_occurrences') === 1n,
          'output:canonical-key-duplicate',
        );
        const value = uint64(output.amount, 'output_amount');
        requireEvidence(value > 0n, 'output:zero');
        sum = uint64(sum + value, 'receipt_sum');
        const economicId = economicOutputIdentity(config.sourceNetwork, key);
        requireEvidence(
          !config.creditedOutputIds.has(economicId),
          'output:already-assigned',
        );
        return Object.freeze({
          outputIndex: index,
          publicKey: key,
          amount: value,
          locator: outputLocator(config.sourceNetwork, intent.txid, index),
          economicId,
        });
      })
      .sort((left, right) => (left.outputIndex < right.outputIndex ? -1 : 1));
    requireEvidence(sum === amount, 'receipt:amount');
    if (intent.version === 2) {
      requireEvidence(
        intent.outputs.length === outputs.length,
        'receipt:intent-output-count',
      );
      for (const [index, expected] of intent.outputs.entries()) {
        const output = outputs[index];
        requireEvidence(
          output.outputIndex === expected.output_index,
          'output:intent-index',
        );
        requireEvidence(
          output.publicKey === expected.output_public_key,
          'output:intent-key',
        );
        requireEvidence(
          output.amount === BigInt(expected.amount),
          'output:intent-amount',
        );
      }
    }
    requireEvidence(
      !config.creditedDepositIds.has(id),
      'deposit:already-assigned',
    );
    const result: AcceptedDeposit = Object.freeze({
      status: 'accepted',
      authority: 'stateless-candidate',
      evidenceMode: identities.some((identity) => identity.kind === 'fixture')
        ? 'fixture'
        : 'independent',
      depositId: id,
      intentHash: intentHash(raw),
      intentBytesHex: Buffer.from(raw).toString('hex'),
      sourceNetwork: config.sourceNetwork,
      txid: intent.txid,
      blockHash: snapshot.blockHash,
      blockHeight: snapshot.blockHeight,
      snapshotId: snapshot.id,
      checkedAtHeight: snapshot.chainHeight,
      expiresAtHeight: intent.expiry_height,
      vaultEpoch: intent.vault_epoch,
      vaultAddress: intent.vault_address,
      destinationNetwork: intent.destination_network,
      destinationAsset: intent.destination_asset,
      recipient: intent.to_address,
      amount,
      bridgeFee,
      networkFee,
      netAmount,
      destinationAmount,
      retainedAtomicRemainder: remainder,
      outputs: Object.freeze(outputs),
      verifierReferences: Object.freeze(
        identities.map(
          (identity) => `${identity.kind}:${identity.id}@${identity.sourcePin}`,
        ),
      ),
    });
    acceptedCandidates.add(result);
    return result;
  } catch (error) {
    if (error instanceof DecisionError)
      return { status: error.status, reason: error.reason };
    if (error instanceof IntentCodecError)
      return { status: 'rejected', reason: error.code };
    return { status: 'indeterminate', reason: 'evidence:malformed' };
  }
}

/** Proposal with explicit units/identities; not the activated scanner EventTrigger ABI. */
export function toRosenObservation(candidate: AcceptedDeposit) {
  if (!acceptedCandidates.has(candidate))
    throw new Error('Candidate must come from verifyDeposit in this process');
  return Object.freeze({
    projectionVersion: 'monero-deposit-candidate-v1' as const,
    authority: candidate.authority,
    evidenceMode: candidate.evidenceMode,
    amountUnit: 'monero-atomic' as const,
    sourceNetwork: candidate.sourceNetwork,
    fromChain: 'monero',
    toChain: candidate.destinationNetwork,
    fromAddress: `intent:sha256:${candidate.intentHash}`,
    toAddress: candidate.recipient,
    amount: candidate.amount.toString(),
    bridgeFee: candidate.bridgeFee.toString(),
    networkFee: candidate.networkFee.toString(),
    sourceChainTokenId: 'XMR',
    targetChainTokenId: candidate.destinationAsset,
    sourceTxId: candidate.txid,
    sourceBlockId: candidate.blockHash,
    sourceChainHeight: candidate.blockHeight.toString(),
    depositId: candidate.depositId,
    intentHash: candidate.intentHash,
    outputIds: Object.freeze(
      candidate.outputs.map((output) => output.economicId),
    ),
    destinationAmount: candidate.destinationAmount.toString(),
    retainedAtomicRemainder: candidate.retainedAtomicRemainder.toString(),
  });
}
