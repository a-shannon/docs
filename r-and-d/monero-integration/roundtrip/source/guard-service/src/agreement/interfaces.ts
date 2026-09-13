import { PaymentTransaction } from '@rosen-chains/abstract-chain';

interface CandidateTransaction {
  tx: PaymentTransaction;
  timestamp: number;
}

interface TransactionRequest {
  txJson: string;
}

interface GuardResponse {
  txDataHash: string;
}

interface TransactionApproved {
  txJson: string;
  signatures: string[];
}

interface ApprovedCandidate {
  readonly txJson: string;
  readonly txId: string;
  readonly txDataHash: string;
  readonly signatures: readonly string[];
  readonly timestamp: number;
  readonly publicKeys: readonly string[];
  readonly protocolVersion: string;
  readonly requiredSign: number;
}

class AgreementMessageTypes {
  static request = 'request';
  static response = 'response';
  static approval = 'approval';
}

export type {
  CandidateTransaction,
  TransactionRequest,
  GuardResponse,
  TransactionApproved,
  ApprovedCandidate,
};

export { AgreementMessageTypes };
