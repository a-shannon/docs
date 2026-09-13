import type {
  DepositConfig,
  FeePolicy,
  NativeProofResult,
  Receipt,
  VerificationProviders,
} from '../lib/evidence';
import { NATIVE_SOURCE_PIN } from '../lib/evidence';
import type { DepositIntent } from '../lib/intentCodec';
import { encodeIntent } from '../lib/intentCodec';

export const TXID = 'a'.repeat(64);
export const BLOCK = 'b'.repeat(64);
export const KEY = 'c'.repeat(64);
export const PROOF = 'OutProofV2' + '1'.repeat(132); // Shape only; not cryptographic proof.

export function fixture() {
  const intent: DepositIntent = {
    domain: 'rosen-monero-experiment',
    version: 1,
    source_network: 'stagenet',
    vault_epoch: 'epoch-1',
    vault_address: 'synthetic-vault',
    txid: TXID,
    destination_network: 'ergo-testnet',
    destination_asset: 'rsXMR',
    to_address: 'synthetic-recipient',
    amount: '1000000000000',
    bridge_fee: '100',
    network_fee: '20',
    expiry_height: 120n,
  };
  const config: DepositConfig = {
    version: 1,
    domain: intent.domain,
    sourceNetwork: 'stagenet',
    vaultEpoch: 'epoch-1',
    vaultAddress: intent.vault_address,
    destinationNetwork: intent.destination_network,
    destinationAsset: intent.destination_asset,
    nativeSourcePin: NATIVE_SOURCE_PIN,
    snapshot: {
      id: 'snapshot-1',
      network: 'stagenet',
      txid: TXID,
      blockHash: BLOCK,
      blockHeight: 100n,
      chainHeight: 110n,
      minConfirmations: 10n,
    },
    creditedOutputIds: new Set(),
    creditedDepositIds: new Set(),
  };
  const fees: FeePolicy = {
    bridgeFee: '100',
    networkFee: '20',
    sourceDecimals: 12,
    destinationDecimals: 12,
    remainder: 'reject',
  };
  const native: NativeProofResult = {
    sourcePin: NATIVE_SOURCE_PIN,
    network: 'stagenet',
    txid: TXID,
    vaultAddress: intent.vault_address,
    messageBytes: encodeIntent(intent),
    proof: PROOF,
    snapshotId: 'snapshot-1',
    good: true,
    received: 1000000000000n,
    inPool: false,
    confirmations: 10n,
  };
  const receipt: Receipt = {
    network: 'stagenet',
    txid: TXID,
    vaultAddress: intent.vault_address,
    blockHash: BLOCK,
    blockHeight: 100n,
    snapshotId: 'snapshot-1',
    inPool: false,
    outputs: [
      {
        index: 0n,
        publicKey: KEY,
        amount: 1000000000000n,
        owned: true,
        maturity: 'unlocked',
        spent: 'unspent',
        keyOccurrences: 1n,
      },
    ],
  };
  const identity = {
    kind: 'fixture' as const,
    id: 'synthetic-policy-fixture',
    sourcePin: NATIVE_SOURCE_PIN,
  };
  const providers: VerificationProviders = {
    proof: {
      identity,
      verify: vi.fn(async () => ({
        status: 'verified' as const,
        value: native,
      })),
    },
    receipt: {
      identity,
      reconstruct: vi.fn(async () => ({
        status: 'verified' as const,
        value: receipt,
      })),
    },
    addresses: {
      identity,
      verify: vi.fn(async (request) => ({
        status: 'verified' as const,
        value: request,
      })),
    },
  };
  return {
    intent: intent as DepositIntent,
    config,
    fees,
    native,
    receipt,
    providers,
  };
}

export function multiFixture() {
  const f = fixture();
  f.intent = {
    ...f.intent,
    version: 2,
    domain: 'rosen-monero-deposit',
    outputs: [
      { output_index: 0n, output_public_key: KEY, amount: '400000000000' },
      {
        output_index: 3n,
        output_public_key: 'd'.repeat(64),
        amount: '600000000000',
      },
    ],
  };
  f.config.version = 2;
  f.config.domain = f.intent.domain;
  f.native.messageBytes = encodeIntent(f.intent);
  f.receipt.outputs = [
    { ...f.receipt.outputs[0], amount: 400000000000n },
    {
      ...f.receipt.outputs[0],
      index: 3n,
      publicKey: 'd'.repeat(64),
      amount: 600000000000n,
    },
  ];
  return f;
}
