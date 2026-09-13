import type { DepositIntent } from './intentCodec.js';

export const NATIVE_SOURCE_PIN = '4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5';
export type MoneroNetwork = 'mainnet' | 'testnet' | 'stagenet';

/** Identity of a trusted implementation, not evidence supplied by a depositor. */
export interface VerifierIdentity {
  kind: 'fixture' | 'independent';
  id: string;
  sourcePin: string;
}

export type Verification<T> =
  | { status: 'verified'; value: T }
  | { status: 'invalid'; reason: string }
  | { status: 'unavailable'; reason: string };

export interface ChainSnapshot {
  id: string;
  network: MoneroNetwork;
  txid: string;
  blockHash: string;
  blockHeight: bigint;
  /** Daemon block count, not tip block index. */
  chainHeight: bigint;
  minConfirmations: bigint;
}

export interface ProofRequest {
  sourcePin: string;
  network: MoneroNetwork;
  txid: string;
  vaultAddress: string;
  messageBytes: Uint8Array;
  proof: string;
  snapshotId: string;
}

/** Normalized result of the exact native call, not check_tx_proof JSON alone. */
export interface NativeProofResult {
  sourcePin: string;
  network: MoneroNetwork;
  txid: string;
  vaultAddress: string;
  messageBytes: Uint8Array;
  proof: string;
  snapshotId: string;
  good: boolean;
  received: bigint;
  inPool: boolean;
  confirmations: bigint;
}

export interface ReceiptOutput {
  index: bigint;
  publicKey: string;
  amount: bigint;
  owned: boolean;
  maturity: 'unlocked' | 'locked' | 'unknown';
  spent: 'unspent' | 'spent' | 'unknown';
  /** Count in the agreed canonical history, not just prior credit records. */
  keyOccurrences: bigint;
}

/** Complete set of qualifying vault outputs independently reconstructed. */
export interface Receipt {
  network: MoneroNetwork;
  txid: string;
  vaultAddress: string;
  blockHash: string;
  blockHeight: bigint;
  snapshotId: string;
  inPool: boolean;
  outputs: readonly ReceiptOutput[];
}

export interface AddressRequest {
  sourceNetwork: MoneroNetwork;
  vaultAddress: string;
  destinationNetwork: string;
  destinationAsset: string;
  recipient: string;
}

export interface VerificationProviders {
  /** Must invoke/check outbound proof verification on the exact supplied bytes. */
  proof: {
    identity: VerifierIdentity;
    verify(request: ProofRequest): Promise<Verification<NativeProofResult>>;
  };
  /** Must reconstruct ownership, amounts, inclusion, maturity and spent evidence. */
  receipt: {
    identity: VerifierIdentity;
    reconstruct(
      intent: DepositIntent,
      evidence: unknown,
      snapshot: ChainSnapshot,
    ): Promise<Verification<Receipt>>;
  };
  /** Must validate actual source/destination address formats and network binding. */
  addresses: {
    identity: VerifierIdentity;
    verify(request: AddressRequest): Promise<Verification<AddressRequest>>;
  };
}

export interface DepositConfig {
  /** Stateless reporting policy; persistent backing authority is a separate gate. */
  outputHistoryPolicy?: 'authenticated-backing-v1';
  version: 1 | 2;
  domain: string;
  sourceNetwork: MoneroNetwork;
  vaultEpoch: string;
  vaultAddress: string;
  destinationNetwork: string;
  destinationAsset: string;
  nativeSourcePin: string;
  snapshot: ChainSnapshot;
  /** Advisory local view only. D2/D3 must atomically claim these identities. */
  creditedOutputIds: ReadonlySet<string>;
  creditedDepositIds: ReadonlySet<string>;
}

export interface FeePolicy {
  bridgeFee: string;
  networkFee: string;
  sourceDecimals: 12;
  destinationDecimals: number;
  remainder: 'reject' | 'retain';
}
