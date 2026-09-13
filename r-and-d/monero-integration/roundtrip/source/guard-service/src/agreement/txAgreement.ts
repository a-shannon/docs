import { DefaultLogger } from '@rosen-bridge/abstract-logger';
import { Communicator } from '@rosen-bridge/communication';
import { RosenDialerNode } from '@rosen-bridge/dialer';
import { Semaphore } from '@rosen-bridge/semaphore';
import {
  ImpossibleBehavior,
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import RosenDialer from '../communication/rosenDialer';
import Configs from '../configs/configs';
import { DatabaseAction } from '../db/databaseAction';
import DatabaseHandler from '../db/databaseHandler';
import ChainHandler from '../handlers/chainHandler';
import GuardPkHandler from '../handlers/guardPkHandler';
import * as TransactionSerializer from '../transaction/transactionSerializer';
import {
  EventStatus,
  OrderStatus,
  TransactionStatus,
} from '../utils/constants';
import GuardTurn from '../utils/guardTurn';
import RequestVerifier from '../verification/requestVerifier';
import TransactionVerifier from '../verification/transactionVerifier';
import type { VerifiedEventRequestSnapshot } from '../verification/requestVerifier';
import { commitMoneroAgreement } from '../db/moneroAgreementCommit';
import {
  CandidateTransaction,
  TransactionRequest,
  GuardResponse,
  TransactionApproved,
  ApprovedCandidate,
  AgreementMessageTypes,
} from './interfaces';

const logger = DefaultLogger.getInstance().child(import.meta.url);

export interface VerifiedAgreementSnapshot {
  readonly certificate: Readonly<ApprovedCandidate>;
  readonly provenance: Readonly<VerifiedEventRequestSnapshot>;
}
const verifiedReceipts = new WeakMap<object, { snapshot: Readonly<VerifiedAgreementSnapshot>; current: () => boolean }>();
const consumedAgreements = new WeakMap<object, () => boolean>();
/** Only snapshots consumed from a genuine receipt have this continuing live check. */
export function assertVerifiedAgreementCurrent(value: unknown): void {
  if (!value || typeof value !== 'object' || !consumedAgreements.get(value)?.()) throw Error('agreement:consumed-authority-expired');
}
/** Consumes before checking freshness; structural certificates and replay cannot authorize. */
export function consumeVerifiedAgreement(value: unknown): Readonly<VerifiedAgreementSnapshot> {
  if (!value || typeof value !== 'object') throw Error('agreement:unissued-receipt');
  const issued = verifiedReceipts.get(value);
  verifiedReceipts.delete(value);
  if (!issued || !issued.current()) throw Error('agreement:unissued-or-expired-receipt');
  consumedAgreements.set(issued.snapshot, issued.current);
  return issued.snapshot;
}

class TxAgreement extends Communicator {
  #moneroProvenance = new Map<string, Readonly<VerifiedEventRequestSnapshot>>();
  #pendingVerified = new Map<string, Readonly<object>>();
  #issuedMonero = new Set<string>();
  #agreementGeneration = 0n;
  takeVerifiedAgreement = (txDataHash: string): Readonly<object> | undefined => {
    const receipt = this.#pendingVerified.get(txDataHash);
    this.#pendingVerified.delete(txDataHash);
    return receipt;
  };
  private static instance: TxAgreement;
  protected readonly protocolVersion = '1.0.0';
  protected static CHANNEL = 'tx-agreement';
  protected static dialer: RosenDialerNode;
  protected transactionQueue: PaymentTransaction[];
  protected transactions: Map<string, CandidateTransaction>; // txDataHash -> candidate tx
  protected eventAgreedTransactions: Map<string, string>; // eventId -> txDataHash
  protected orderAgreedTransactions: Map<string, string>; // orderId -> txDataHash
  protected agreedColdStorageTransactions: Map<string, string>; // chainName -> txDataHash
  protected transactionApprovals: Map<string, string[]>; // txDataHash -> signatures
  protected approvedTransactions: ApprovedCandidate[];
  protected approvalSemaphore: Semaphore;

  protected constructor() {
    super(
      logger,
      Configs.guardSecretEcdsa,
      TxAgreement.sendMessageWrapper,
      GuardPkHandler.getInstance().publicKeys,
      GuardTurn.UP_TIME_LENGTH,
    );
    this.transactionQueue = [];
    this.transactions = new Map();
    this.eventAgreedTransactions = new Map();
    this.agreedColdStorageTransactions = new Map();
    this.orderAgreedTransactions = new Map();
    this.transactionApprovals = new Map();
    this.approvedTransactions = [];
    this.approvalSemaphore = new Semaphore(1);
  }

  /**
   * wraps communicator send message to dialer
   * @param msg
   * @param peers
   */
  static sendMessageWrapper = async (msg: string, peers: Array<string>) => {
    if (peers.length === 0) {
      TxAgreement.dialer.sendMessage(TxAgreement.CHANNEL, msg);
    } else {
      for (const peerId of peers) {
        TxAgreement.dialer.sendMessage(TxAgreement.CHANNEL, msg, peerId);
      }
    }
  };

  /**
   * wraps dialer handle message to communicator
   * @param msg
   * @param channel
   * @param peerId
   */
  messageHandlerWrapper = async (
    msg: string,
    channel: string,
    peerId: string,
  ) => {
    this.handleMessage(msg, peerId);
  };

  /**
   * generates a TxAgreement object if it doesn't exist
   * @returns TxAgreement instance
   */
  public static getInstance = async () => {
    if (!TxAgreement.instance) {
      logger.debug("TxAgreement instance didn't exist. Creating a new one");
      TxAgreement.instance = new TxAgreement();
      this.dialer = RosenDialer.getInstance().getDialer();
      this.dialer.subscribeChannel(
        TxAgreement.CHANNEL,
        TxAgreement.instance.messageHandlerWrapper,
      );
    }
    return TxAgreement.instance;
  };

  /**
   * adds a transaction to agreement queue
   * @param tx
   */
  addTransactionToQueue = (tx: PaymentTransaction): void => {
    this.transactionQueue.push(tx);
  };

  /**
   * adds all unsigned transactions which failed in sign process to agreement queue
   */
  enqueueSignFailedTxs = async (): Promise<void> => {
    const txs = await DatabaseAction.getInstance().getUnsignedFailedSignTxs();
    txs
      .filter((tx) => tx.type !== TransactionType.manual)
      .forEach((tx) =>
        this.transactionQueue.push(
          TransactionSerializer.fromJson(
            tx.txJson,
            ChainHandler.getInstance().getChain,
          ),
        ),
      );
  };

  /**
   * starts agreement process for created PaymentTransactions in queue
   */
  processAgreementQueue = async (): Promise<void> => {
    let tx: PaymentTransaction;
    while (this.transactionQueue.length > 0) {
      tx = this.transactionQueue.pop()!;
      try {
        const timestamp = tx.network === 'monero' ? Math.floor(Date.now() / 1000) : Math.round(Date.now() / 1000);
        const txDataHash = TransactionSerializer.getTxDataHash(tx);

        // Creator votes require the same original request provenance as receivers.
        const monero = tx.network === 'monero';
        const generation = this.#agreementGeneration;
        if (monero) {
          const creatorIndex = await this.getIndex();
          if (generation !== this.#agreementGeneration || !(await this.verifyTransactionRequest(tx, creatorIndex))) continue;
        }
        const initialContext = monero ? this.captureCertificate(tx, Array(this.guardPks.length).fill(''), timestamp) : undefined;
        if (monero && (!initialContext || !this.#certificateContextCurrent(initialContext) || generation !== this.#agreementGeneration)) continue;

        // broadcast the transaction
        await this.broadcastTransactionRequest(tx, timestamp);
        if (monero && (!initialContext || !this.#certificateContextCurrent(initialContext) || generation !== this.#agreementGeneration)) continue;
        const signature = await this.signCandidateMessage(
          txDataHash,
          timestamp,
        );
        if (monero && (!initialContext || !this.#certificateContextCurrent(initialContext) || generation !== this.#agreementGeneration)) continue;

        const approvals = Array(this.guardPks.length).fill('');
        approvals[this.index] = signature;
        this.transactions.set(txDataHash, { tx, timestamp });
        this.transactionApprovals.set(txDataHash, approvals);
        logger.info(`Started agreement process for tx [${tx.txId}]`);
      } catch (e) {
        logger.warn(
          `An error occurred while starting agreement process for tx [${tx.txId}]: ${e}`,
        );
        logger.warn(e.stack);
      }
    }
  };

  /**
   * sends request to all other guards to agree on a transaction
   * @param tx the created PaymentTransaction
   * @param timestamp
   */
  protected broadcastTransactionRequest = async (
    tx: PaymentTransaction,
    timestamp: number,
  ): Promise<void> => {
    const candidatePayload: TransactionRequest = {
      txJson: tx.toJson(),
    };

    // broadcast the transaction
    await this.sendMessage(
      AgreementMessageTypes.request,
      candidatePayload,
      [],
      timestamp,
    );
  };

  /**
   * handles received message from tx-agreement channel
   * @param type
   * @param payload
   * @param signature
   * @param senderIndex
   * @param peerId
   * @param timestamp
   */
  processMessage = async (
    type: string,
    payload: unknown,
    signature: string,
    senderIndex: number,
    peerId: string,
    timestamp: number,
  ): Promise<void> => {
    try {
      switch (type) {
        case AgreementMessageTypes.request: {
          const candidate = payload as TransactionRequest;
          const tx = TransactionSerializer.fromJson(
            candidate.txJson,
            ChainHandler.getInstance().getChain,
          );
          await this.processTransactionRequest(
            tx,
            senderIndex,
            timestamp,
            peerId,
          );
          break;
        }
        case AgreementMessageTypes.response: {
          const response = payload as GuardResponse;
          await this.processAgreementResponse(
            response.txDataHash,
            senderIndex,
            signature,
            timestamp,
          );
          break;
        }
        case AgreementMessageTypes.approval: {
          const approval = payload as TransactionApproved;
          const tx = TransactionSerializer.fromJson(
            approval.txJson,
            ChainHandler.getInstance().getChain,
          );
          await this.processApprovalMessage(
            tx,
            senderIndex,
            approval.signatures,
            timestamp,
            peerId,
          );
          break;
        }
        default:
          logger.warn(
            `Received unexpected message type [${type}] in tx-agreement channel`,
          );
      }
    } catch (e) {
      logger.warn(
        `An error occurred while handling tx-agreement message: ${e}}`,
      );
      logger.warn(e.stack);
    }
  };

  /**
   * verifies the transaction sent by other guards
   * sends response if conditions are met
   * otherwise does nothing
   * @param tx the created payment transaction
   * @param creatorId id of the guard that created the transaction
   * @param timestamp
   * @param receiver the guard who will receive this response
   */
  protected processTransactionRequest = async (
    tx: PaymentTransaction,
    creatorId: number,
    timestamp: number,
    receiver: string,
  ): Promise<void> => {
    // verify transaction
    if (!(await this.verifyTransactionRequest(tx, creatorId))) return;

    // agree to transaction
    const txDataHash = TransactionSerializer.getTxDataHash(tx);
    this.transactions.set(txDataHash, { tx, timestamp });
    const agreementPayload: GuardResponse = { txDataHash };

    // send response to creator guard
    await this.sendMessage(
      AgreementMessageTypes.response,
      agreementPayload,
      [receiver],
      timestamp,
    );
  };

  /**
   * verifies the transaction sent by other guards
   * @param tx
   * @param creatorId creator guard index
   * @returns true if transaction verified
   */
  protected verifyTransactionRequest = async (
    tx: PaymentTransaction,
    creatorId: number,
  ): Promise<boolean> => {
    const txDataHash = TransactionSerializer.getTxDataHash(tx);
    const generation = this.#agreementGeneration;

    // verify general conditions
    const guardTurn = GuardTurn.guardTurn();
    if (guardTurn !== creatorId) {
      logger.warn(
        `Received tx [${tx.txId}] from sender [${creatorId}] but it's not sender's turn [${guardTurn} != ${creatorId}]`,
      );
      return false;
    }
    if (!(await TransactionVerifier.verifyTxCommonConditions(tx))) {
      logger.warn(
        `Received tx [${tx.txId}] but tx common conditions hasn't verified`,
      );
      return false;
    }
    if (tx.network === 'monero' && generation !== this.#agreementGeneration) return false;

    // verify unique conditions
    if (
      tx.txType === TransactionType.payment ||
      tx.txType === TransactionType.reward
    ) {
      const eventId = tx.eventId;
      // verify if agreed to other txs
      if (
        this.eventAgreedTransactions.has(eventId) &&
        this.eventAgreedTransactions.get(eventId) !== txDataHash
      ) {
        logger.warn(
          `Received tx [${tx.txId}] for event [${eventId}] but already agreed to a different tx for this event (txDataHash: ${this.eventAgreedTransactions.get(
            eventId,
          )})`,
        );
        return false;
      }
      // verify conditions
      if (tx.network === 'monero') {
        const provenance = await RequestVerifier.captureVerifiedMoneroEventRequest(tx);
        if (!provenance || generation !== this.#agreementGeneration || provenance.txJson !== tx.toJson() || TransactionSerializer.getTxDataHash(tx) !== txDataHash) return false;
        this.#moneroProvenance.set(txDataHash, provenance);
      } else if (!(await RequestVerifier.verifyEventTransactionRequest(tx))) return false;

      logger.info(`Agreed with tx [${tx.txId}] for event [${eventId}]`);
      this.eventAgreedTransactions.set(eventId, txDataHash);
    } else if (tx.txType === TransactionType.coldStorage) {
      // verify if agreed to other txs
      if (
        this.agreedColdStorageTransactions.has(tx.network) &&
        this.agreedColdStorageTransactions.get(tx.network) !== txDataHash
      ) {
        logger.warn(
          `Received cold storage tx [${tx.txId}] but already agreed to a different tx for this chain (txDataHash: ${this.agreedColdStorageTransactions.get(
            tx.network,
          )})`,
        );
        return false;
      }
      // verify conditions
      if (!(await RequestVerifier.verifyColdStorageTransactionRequest(tx)))
        return false;

      logger.info(`Agreed with cold storage tx [${tx.txId}]`);
      this.agreedColdStorageTransactions.set(tx.network, txDataHash);
    } else if (tx.txType === TransactionType.arbitrary) {
      const orderId = tx.eventId;
      // verify if agreed to other txs
      if (
        this.orderAgreedTransactions.has(orderId) &&
        this.orderAgreedTransactions.get(orderId) !== txDataHash
      ) {
        logger.warn(
          `Received tx [${tx.txId}] for order [${orderId}] but already agreed to a different tx for this order (txDataHash: ${this.orderAgreedTransactions.get(
            orderId,
          )})`,
        );
        return false;
      }
      // verify conditions
      if (!(await RequestVerifier.verifyArbitraryTransactionRequest(tx)))
        return false;

      logger.info(
        `Agreed with tx [${tx.txId}] for arbitrary order [${orderId}]`,
      );
      this.orderAgreedTransactions.set(orderId, txDataHash);
    } else {
      logger.info(
        `Received tx [${tx.txId}] but type [${tx.txType}] is not supported`,
      );
      return false;
    }

    return true;
  };

  /**
   * verifies the agreement response sent by other guards, save their signature if they agreed
   * @param txDataHash hash of the serialized payment transaction guards agreed on
   * @param signerIndex index of the guard that sent the response
   * @param signature signature of creator guard over request data
   * @param timestamp
   */
  private captureCertificate = (
    tx: PaymentTransaction,
    signatures: unknown,
    timestamp: number,
  ): ApprovedCandidate | undefined => {
    try {
      const publicKeys = [...this.guardPks];
      const requiredSign = GuardPkHandler.getInstance().requiredSign;
      if (
        !publicKeys.length ||
        publicKeys.some((key) => typeof key !== 'string' || key === '') ||
        new Set(publicKeys).size !== publicKeys.length ||
        !Number.isInteger(requiredSign) ||
        requiredSign < 1 ||
        requiredSign > publicKeys.length ||
        !Number.isSafeInteger(timestamp) ||
        timestamp < 0 ||
        !Array.isArray(signatures) ||
        signatures.length !== publicKeys.length
      )
        return;
      const copied: string[] = [];
      for (let i = 0; i < signatures.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(signatures, i)) return;
        const signature: unknown = signatures[i];
        if (typeof signature !== 'string') return;
        copied.push(signature);
      }
      const txJson = tx.toJson();
      const privateTx = TransactionSerializer.fromJson(
        txJson,
        ChainHandler.getInstance().getChain,
      );
      if (privateTx.toJson() !== txJson) return;
      return Object.freeze({
        txJson,
        txId: privateTx.txId,
        txDataHash: TransactionSerializer.getTxDataHash(privateTx),
        signatures: Object.freeze(copied),
        timestamp,
        publicKeys: Object.freeze(publicKeys),
        protocolVersion: this.protocolVersion,
        requiredSign,
      });
    } catch {
      return;
    }
  };

  private verifyCanonicalVote = async (
    certificate: ApprovedCandidate,
    index: number,
    signature: string,
  ): Promise<boolean> => {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= certificate.publicKeys.length ||
      typeof signature !== 'string' ||
      signature === ''
    )
      return false;
    try {
      return await this.messageEnc.verify(
        Communicator.generatePayloadToSign(
          { txDataHash: certificate.txDataHash },
          certificate.timestamp,
          certificate.publicKeys[index],
          certificate.protocolVersion,
        ),
        signature,
        certificate.publicKeys[index],
      );
    } catch {
      return false;
    }
  };

  private verifyCertificate = async (
    certificate: ApprovedCandidate,
    isCurrent: () => boolean,
  ): Promise<boolean> => {
    if (!this.#certificateContextCurrent(certificate)) return false;
    let count = 0;
    for (let i = 0; i < certificate.signatures.length; i++) {
      if (certificate.signatures[i] === '') continue;
      if (
        !(await this.verifyCanonicalVote(
          certificate,
          i,
          certificate.signatures[i],
        )) ||
        !isCurrent() || !this.#certificateContextCurrent(certificate)
      )
        return false;
      count++;
    }
    return count >= certificate.requiredSign && isCurrent() && this.#certificateContextCurrent(certificate);
  };

  #certificateContextCurrent = (certificate: ApprovedCandidate): boolean => {
    try {
      // Preserve the old non-Monero acceptance contract.
      if (JSON.parse(certificate.txJson).network !== 'monero') return true;
      const handler = GuardPkHandler.getInstance();
      const now = this.getDate();
      return Number.isSafeInteger(now) && Number.isSafeInteger(this.messageValidDuration) && this.messageValidDuration > 0 &&
        certificate.timestamp <= now && certificate.timestamp >= now - this.messageValidDuration &&
        certificate.protocolVersion === this.protocolVersion && certificate.requiredSign === handler.requiredSign &&
        certificate.publicKeys.length === this.guardPks.length && certificate.publicKeys.length === handler.publicKeys.length &&
        certificate.publicKeys.every((key, i) => key === this.guardPks[i] && key === handler.publicKeys[i]);
    } catch { return false; }
  };

  /** Checked original persistence; only this private verified branch can issue a receipt. */
  #completeMoneroApproval = async (tx: PaymentTransaction, certificate: ApprovedCandidate, isCurrent: () => boolean): Promise<boolean> => {
    const provenance = this.#moneroProvenance.get(certificate.txDataHash);
    const generation = this.#agreementGeneration;
    const current = () => isCurrent() && generation === this.#agreementGeneration && this.#certificateContextCurrent(certificate) && tx.toJson() === certificate.txJson && TransactionSerializer.getTxDataHash(tx) === certificate.txDataHash;
    if (!provenance || provenance.txJson !== certificate.txJson || provenance.eventId !== tx.eventId || this.#issuedMonero.has(certificate.txDataHash) || !current()) return false;
    try {
      if (!(await commitMoneroAgreement(DatabaseAction.getInstance().dataSource,
        tx, provenance, certificate.requiredSign, current)) || !current()) return false;
      // Receiver acceptance may overlap across awaits; only one completion wins.
      if (this.#issuedMonero.has(certificate.txDataHash)) return false;
      // Capture provenance before cleanup; the receipt does not reread mutable maps.
      const verified = Object.freeze({ certificate, provenance });
      const token = Object.freeze({});
      verifiedReceipts.set(token, { snapshot: verified, current: () => generation === this.#agreementGeneration && this.#certificateContextCurrent(certificate) });
      this.#issuedMonero.add(certificate.txDataHash);
      this.#pendingVerified.set(certificate.txDataHash, token);
      this.transactions.delete(certificate.txDataHash);
      this.transactionApprovals.delete(certificate.txDataHash);
      this.eventAgreedTransactions.delete(tx.eventId);
      this.#moneroProvenance.delete(certificate.txDataHash);
      return true;
    } catch { return false; }
  };

  private decodeCertificate = (
    certificate: ApprovedCandidate,
  ): PaymentTransaction => {
    const tx = TransactionSerializer.fromJson(
      certificate.txJson,
      ChainHandler.getInstance().getChain,
    );
    if (
      tx.toJson() !== certificate.txJson ||
      tx.txId !== certificate.txId ||
      TransactionSerializer.getTxDataHash(tx) !== certificate.txDataHash
    )
      throw new ImpossibleBehavior(
        'Approved transaction snapshot changed during decoding',
      );
    return tx;
  };

  private isCurrentCandidate = (
    candidate: CandidateTransaction,
    certificate: ApprovedCandidate,
  ): boolean => {
    try {
      return (
        this.transactions.get(certificate.txDataHash) === candidate &&
        candidate.timestamp === certificate.timestamp &&
        candidate.tx.toJson() === certificate.txJson
      );
    } catch {
      return false;
    }
  };

  protected processAgreementResponse = async (
    txDataHash: string,
    signerIndex: number,
    signature: string,
    timestamp: number,
  ): Promise<void> => {
    const candidateTx = this.transactions.get(txDataHash);
    const generation = this.#agreementGeneration;
    if (candidateTx === undefined) return;
    if (candidateTx.timestamp !== timestamp) {
      logger.debug(
        `Received guard [${signerIndex}] agreement for tx [${candidateTx.tx.txId}] but timestamp is wrong [${candidateTx.timestamp} !== ${timestamp}]`,
      );
      return;
    }

    const initial = this.captureCertificate(
      candidateTx.tx,
      this.transactionApprovals.get(txDataHash),
      timestamp,
    );
    if (!initial || initial.txDataHash !== txDataHash) return;
    const release = await this.approvalSemaphore.acquire();
    try {
      if (!this.isCurrentCandidate(candidateTx, initial) || (candidateTx.tx.network === 'monero' && generation !== this.#agreementGeneration)) return;
      const approvals = this.transactionApprovals.get(txDataHash);
      if (!approvals || approvals.length !== initial.publicKeys.length) return;
      if (
        !(await this.verifyCanonicalVote(initial, signerIndex, signature)) ||
        !this.isCurrentCandidate(candidateTx, initial) ||
        (candidateTx.tx.network === 'monero' && generation !== this.#agreementGeneration) ||
        this.transactionApprovals.get(txDataHash) !== approvals ||
        approvals.length !== initial.publicKeys.length
      )
        return;
      approvals[signerIndex] = signature;
      // The same immutable certificate authorizes all later consumers.
      const certificate: ApprovedCandidate = Object.freeze({
        ...initial,
        signatures: Object.freeze([...approvals]),
      });
      if (
        !(await this.verifyCertificate(certificate, () =>
          this.isCurrentCandidate(candidateTx, certificate) && (candidateTx.tx.network !== 'monero' || generation === this.#agreementGeneration),
        ))
      )
        return;
      await this.broadcastApprovalMessage(certificate);
      if (!this.isCurrentCandidate(candidateTx, certificate) || (candidateTx.tx.network === 'monero' && generation !== this.#agreementGeneration)) return;
      if (
        !this.approvedTransactions.some(
          (approved) => approved.txId === certificate.txId,
        )
      )
        this.approvedTransactions.push(certificate);
      if (candidateTx.tx.network === 'monero') {
        await this.#completeMoneroApproval(this.decodeCertificate(certificate), certificate, () => this.isCurrentCandidate(candidateTx, certificate) && generation === this.#agreementGeneration);
      } else await this.setTxAsApproved(this.decodeCertificate(certificate), certificate.requiredSign, () => this.isCurrentCandidate(candidateTx, certificate));
    } finally {
      release();
    }
  };

  /**
   * sends approval message to all other guards
   * @param approvedCandidate approved candidate transaction
   */
  protected broadcastApprovalMessage = async (
    approvedCandidate: ApprovedCandidate,
  ): Promise<void> => {
    const approvalPayload: TransactionApproved = {
      txJson: approvedCandidate.txJson,
      signatures: [...approvedCandidate.signatures],
    };

    // broadcast the transaction
    await this.sendMessage(
      AgreementMessageTypes.approval,
      approvalPayload,
      [],
      approvedCandidate.timestamp,
    );
  };

  /**
   * verifies approval message sent by other guards, set tx as approved if enough guards agreed with tx
   * @param tx
   * @param senderIndex
   * @param signatures
   * @param timestamp
   * @param sender
   */
  protected processApprovalMessage = async (
    tx: PaymentTransaction,
    senderIndex: number,
    signatures: string[],
    timestamp: number,
    sender: string,
  ): Promise<void> => {
    const certificate = this.captureCertificate(tx, signatures, timestamp);
    if (!certificate) return;
    const generation = this.#agreementGeneration;
    const txDataHash = certificate.txDataHash;
    const selected = this.transactions.get(txDataHash);
    const current = () =>
      (tx.network !== 'monero' || (generation === this.#agreementGeneration && this.#certificateContextCurrent(certificate))) && (selected
        ? this.isCurrentCandidate(selected, certificate)
        : this.transactions.get(txDataHash) === undefined);
    let baseError = `Received approval message for tx [${tx.txId}] (with data hash [${txDataHash}]) from sender [${sender}] `;
    if (!(await this.verifyCertificate(certificate, current))) return;
    const approvedGuards = certificate.signatures.flatMap((signature, i) =>
      signature === '' ? [] : [i],
    );
    const checkedTx = this.decodeCertificate(certificate);
    logger.info(
      `Guards [${approvedGuards}] agreed on tx [${tx.txId}] (with data hash [${txDataHash}])`,
    );

    const agreedTx = selected;
    if (agreedTx) {
      logger.info(`Transaction [${agreedTx.tx.txId}] approved`);
      if (checkedTx.network === 'monero') await this.#completeMoneroApproval(checkedTx, certificate, current);
      else await this.setTxAsApproved(checkedTx, certificate.requiredSign, current);
    } else {
      baseError = `Other guards [${approvedGuards}] agreed on tx [${tx.txId}] `;
      const currentAgreedTxDataHash = this.eventAgreedTransactions.get(
        checkedTx.eventId,
      );
      if (currentAgreedTxDataHash === undefined) {
        const requestCurrent = () =>
          current() &&
          TransactionSerializer.getTxDataHash(checkedTx) ===
            certificate.txDataHash &&
          (checkedTx.txType === TransactionType.coldStorage
            ? this.agreedColdStorageTransactions.get(checkedTx.network) ===
              txDataHash
            : checkedTx.txType === TransactionType.arbitrary
              ? this.orderAgreedTransactions.get(checkedTx.eventId) ===
                txDataHash
              : this.eventAgreedTransactions.get(checkedTx.eventId) ===
                txDataHash);
        if (
          !(await this.verifyTransactionRequest(checkedTx, senderIndex)) ||
          !requestCurrent()
        ) {
          logger.warn(baseError + `but tx doesn't verified`);
          return;
        } else {
          logger.info(`Transaction [${tx.txId}] verified and approved`);
          if (checkedTx.network === 'monero') await this.#completeMoneroApproval(this.decodeCertificate(certificate), certificate, requestCurrent);
          else await this.setTxAsApproved(this.decodeCertificate(certificate), certificate.requiredSign, requestCurrent);
        }
      } else if (currentAgreedTxDataHash !== txDataHash) {
        logger.warn(
          baseError +
            `but already agreed to a different tx for event [${tx.eventId}] (txDataHash: ${currentAgreedTxDataHash})`,
        );
        return;
      } else
        throw new ImpossibleBehavior(
          `Guards agreed on tx [${tx.txId}] for event [${tx.eventId}] but the tx itself wasn't found in memory (txDataHash: ${txDataHash})`,
        );
    }
  };

  /**
   * sets the transaction as approved in db and removes it from memory
   * @param tx
   */
  protected setTxAsApproved = async (
    tx: PaymentTransaction,
    requiredSign: number,
    isCurrent: () => boolean = () => true,
  ): Promise<void> => {
    const txRecord = await DatabaseAction.getInstance().getTxById(tx.txId);
    if (!isCurrent()) return;
    try {
      if (txRecord === null) {
        await DatabaseHandler.insertTx(tx, requiredSign);
        await this.updateEventOrOrderOfApprovedTx(tx);
      } else {
        if (txRecord.status === TransactionStatus.invalid) {
          logger.debug(
            `Tx [${tx.txId}] is already in database and invalid. Reinsertion is skipped`,
          );
        } else {
          logger.debug(
            `Tx [${tx.txId}] is already in database. Only reinserting tx...`,
          );
          await DatabaseHandler.insertTx(tx, requiredSign);
        }
      }
      const txDataHash = TransactionSerializer.getTxDataHash(tx);
      this.transactions.delete(txDataHash);
      this.transactionApprovals.delete(txDataHash);
      if (this.eventAgreedTransactions.has(tx.eventId))
        this.eventAgreedTransactions.delete(tx.eventId);
      if (this.agreedColdStorageTransactions.has(tx.network))
        this.agreedColdStorageTransactions.delete(tx.network);
      if (this.orderAgreedTransactions.has(tx.eventId))
        this.orderAgreedTransactions.delete(tx.eventId);
    } catch (e) {
      logger.warn(
        `An error occurred while setting tx [${tx.txId}] as approved: ${e}`,
      );
      logger.warn(e.stack);
    }
  };

  /**
   * updates event or order status for a tx
   * @param tx
   */
  protected updateEventOrOrderOfApprovedTx = async (
    tx: PaymentTransaction,
  ): Promise<void> => {
    try {
      if (tx.txType === TransactionType.payment)
        await DatabaseAction.getInstance().setEventStatus(
          tx.eventId,
          EventStatus.inPayment,
        );
      else if (tx.txType === TransactionType.reward)
        await DatabaseAction.getInstance().setEventStatus(
          tx.eventId,
          EventStatus.inReward,
        );
      else if (tx.txType === TransactionType.arbitrary)
        await DatabaseAction.getInstance().setOrderStatus(
          tx.eventId,
          OrderStatus.inProcess,
        );
    } catch (e) {
      logger.warn(
        `An error occurred while setting database ${
          tx.txType === TransactionType.arbitrary ? 'order' : 'event'
        } [${tx.eventId}] status: ${e}`,
      );
      logger.warn(e.stack);
    }
  };

  /**
   * signs an agreement message
   * @param txDataHash hash of the serialized payment transaction being agreed on
   * @param timestamp
   */
  protected signCandidateMessage = async (
    txDataHash: string,
    timestamp: number,
  ): Promise<string> => {
    return await this.messageEnc.sign(
      Communicator.generatePayloadToSign(
        { txDataHash },
        timestamp,
        this.guardPks[this.index],
        this.protocolVersion,
      ),
    );
  };

  /**
   * iterates over active transactions and resend their requests
   */
  resendTransactionRequests = async (): Promise<void> => {
    logger.info(
      `Resending [${this.transactions.size}] generated transactions for agreement`,
    );
    for (const candidateTx of this.transactions.values()) {
      try {
        await this.broadcastTransactionRequest(
          candidateTx.tx,
          candidateTx.timestamp,
        );
      } catch (e) {
        logger.warn(
          `An error occurred while resending tx [${candidateTx.tx.txId}]: ${e}`,
        );
        logger.warn(e.stack);
      }
    }
  };

  /**
   * iterates over approved transactions and resend their approval messages
   */
  resendApprovalMessages = async (): Promise<void> => {
    logger.info(
      `Resending approval messages for [${this.approvedTransactions.length}] transactions`,
    );
    for (const approved of this.approvedTransactions) {
      try {
        await this.broadcastApprovalMessage(approved);
      } catch (e) {
        logger.warn(
          `An error occurred while resending approval message for tx [${approved.txId}]: ${e.stack}`,
        );
      }
    }
  };

  /**
   * clears all pending for agreement and approved txs in memory
   */
  clearTransactions = (): void => {
    this.#agreementGeneration++;
    this.#moneroProvenance.clear(); this.#pendingVerified.clear();
    logger.info(
      `Removing [${this.transactionQueue.length}] generated transactions from agreement queue and [${this.transactionApprovals.size}] from memory`,
    );
    this.transactionQueue = [];
    this.transactions.clear();
    this.transactionApprovals.clear();
    this.approvedTransactions = [];
  };

  /**
   * clears all pending for approval txs in memory and db
   */
  clearAgreedTransactions = async (): Promise<void> => {
    this.#agreementGeneration++;
    this.#moneroProvenance.clear(); this.#pendingVerified.clear();
    logger.info(
      `Removing [${this.eventAgreedTransactions.size}e, ${this.agreedColdStorageTransactions.size}c, ${this.orderAgreedTransactions.size}o] agreed transactions from memory`,
    );
    this.transactions.clear();
    this.eventAgreedTransactions.clear();
    this.agreedColdStorageTransactions.clear();
    this.orderAgreedTransactions.clear();
  };

  /**
   * returns list of pending transactions of a chain
   * @param chain
   */
  getChainPendingTransactions = (chain: string): PaymentTransaction[] => {
    const inProgressTxs = Array.from(this.transactions.values()).filter(
      (candidateTx) => candidateTx.tx.network === chain,
    );
    const inQueueTxs = Array.from(this.transactionQueue.values()).filter(
      (paymentTx) => paymentTx.network === chain,
    );
    return [
      ...inProgressTxs.map((candidateTx) => candidateTx.tx),
      ...inQueueTxs,
    ];
  };
}

export default TxAgreement;
