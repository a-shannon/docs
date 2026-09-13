import { DefaultLogger } from '@rosen-bridge/abstract-logger';
import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { ERGO_CHAIN } from '@rosen-chains/ergo';

import { DatabaseAction } from '../db/databaseAction';
import EventSerializer from '../event/eventSerializer';
import EventSynchronization from '../synchronization/eventSynchronization';
import { EventStatus, OrderStatus } from '../utils/constants';
import EventVerifier from './eventVerifier';
import TransactionVerifier from './transactionVerifier';
import type { VerifiedEventOrderSnapshot } from './transactionVerifier';

export interface VerifiedEventRequestSnapshot extends VerifiedEventOrderSnapshot {
  readonly eventId: string;
  readonly eventStatus: string;
  readonly activeTransactionIds: readonly string[];
  readonly txJson: string;
}

const logger = DefaultLogger.getInstance().child(import.meta.url);

class RequestVerifier {
  /** Original database observation, serializer and order comparison; no later reconstruction. */
  static captureVerifiedMoneroEventRequest = async (tx: PaymentTransaction): Promise<Readonly<VerifiedEventRequestSnapshot> | undefined> => {
    if (tx.network !== 'monero' || tx.txType !== TransactionType.payment) return;
    const txJson = tx.toJson();
    const found = await DatabaseAction.getInstance().getEventById(tx.eventId);
    if (!found) return;
    // Clone at observation, before the next database await can mutate returned entities.
    const observed = structuredClone(found);
    Object.freeze(observed.eventData); Object.freeze(observed);
    const event = Object.freeze(EventSerializer.fromConfirmedEntity(observed));
    const eventId = observed.id;
    const eventStatus = observed.status;
    const triggerTransactionId = observed.eventData.txId;
    const triggerBoxId = observed.eventData.identifier;
    if (eventId !== tx.eventId || tx.network !== event.toChain || typeof triggerTransactionId !== 'string' || typeof triggerBoxId !== 'string') return;
    const active = await DatabaseAction.getInstance().getEventValidTxsByType(eventId, tx.txType);
    const activeTransactionIds = Object.freeze(active.map(record => record.txId));
    if (activeTransactionIds.some(id => id !== tx.txId)) return;
    if (!activeTransactionIds.length && !EventVerifier.isEventPendingToType(observed, tx.txType)) return;
    const checked = await TransactionVerifier.verifyMoneroEventOrderSnapshot(tx, event, triggerTransactionId, triggerBoxId);
    if (!checked || tx.toJson() !== txJson) return;
    return Object.freeze({ ...checked, eventId, eventStatus, activeTransactionIds, txJson });
  };
  /**
   * verifies the transaction request sent by other guards
   * conditions:
   * - transaction is compatible with the event
   * - event has no active transaction for requested tx type
   * - event status is compatible with requested tx type
   * - requested tx is compatible with event and not malicious
   * @param tx the created payment transaction
   * @returns true if conditions are met
   */
  static verifyEventTransactionRequest = async (
    tx: PaymentTransaction,
  ): Promise<boolean> => {
    if (tx.network === 'monero') return (await this.captureVerifiedMoneroEventRequest(tx)) !== undefined;
    const eventId = tx.eventId;
    const baseError = `Received tx [${tx.txId}] for event [${eventId}] `;

    // get event from database
    const eventEntity =
      await DatabaseAction.getInstance().getEventById(eventId);
    if (eventEntity === null) {
      logger.warn(baseError + `but event not found`);
      return false;
    }
    const event = EventSerializer.fromConfirmedEntity(eventEntity);

    // transaction is compatible with the event
    if (tx.txType === TransactionType.payment) {
      if (tx.network !== event.toChain) {
        logger.warn(
          baseError +
            `but transaction chain is unexpected (expected [${event.toChain}] found [${tx.network}])`,
        );
        return false;
      }
    } else if (tx.txType === TransactionType.reward) {
      if (tx.network !== ERGO_CHAIN) {
        logger.warn(
          baseError +
            `but reward transactions are only on Ergo (found [${tx.network}])`,
        );
        return false;
      }
    } else {
      logger.warn(
        baseError + `but tx type is unexpected (found [${tx.network}])`,
      );
      return false;
    }

    // check if event has any active tx for requested tx type
    const eventTxs = await DatabaseAction.getInstance().getEventValidTxsByType(
      eventId,
      tx.txType,
    );
    if (eventTxs.length !== 0 && eventTxs[0].txId !== tx.txId) {
      logger.warn(baseError + `but event has active tx [${eventTxs[0].txId}]`);
      return false;
    }

    // verify requested tx type with event status
    if (
      eventTxs.length === 0 &&
      !EventVerifier.isEventPendingToType(eventEntity, tx.txType)
    ) {
      logger.warn(
        baseError +
          `but event status [${eventEntity.status}] is not compatible with requested tx type [${tx.txType}]`,
      );
      if (
        eventEntity.status === EventStatus.pendingPayment &&
        tx.txType === TransactionType.reward
      ) {
        EventSynchronization.getInstance().addEventToQueue(eventEntity.id);
      }
      return false;
    }

    // verify requested tx
    if (
      !(await TransactionVerifier.verifyEventTransaction(
        tx,
        event,
        eventEntity.eventData.txId,
      ))
    ) {
      logger.warn(baseError + `but tx hasn't verified`);
      return false;
    }

    return true;
  };

  /**
   * verifies the cold storage transaction request sent by other guards
   * conditions:
   * - tx has no eventId
   * - requested tx is not malicious
   * @param tx the created payment transaction
   * @returns true if conditions are met
   */
  static verifyColdStorageTransactionRequest = async (
    tx: PaymentTransaction,
  ): Promise<boolean> => {
    const baseError = `Received cold storage tx [${tx.txId}] `;

    // verify tx eventId
    if (tx.eventId !== '') {
      logger.warn(baseError + `but tx has eventId [${tx.eventId}]`);
      return false;
    }

    // verify requested tx
    if (!(await TransactionVerifier.verifyColdStorageTransaction(tx))) {
      logger.warn(baseError + `but tx hasn't verified`);
      return false;
    }

    return true;
  };

  /**
   * verifies the transaction request sent by other guards
   * conditions:
   * - transaction network is compatible with the order
   * - order has no active transaction for requested tx type
   * - order status is compatible with requested tx type
   * - requested tx is compatible with order and not malicious
   * @param tx the created payment transaction
   * @returns true if conditions are met
   */
  static verifyArbitraryTransactionRequest = async (
    tx: PaymentTransaction,
  ): Promise<boolean> => {
    const orderId = tx.eventId;
    const baseError = `Received tx [${tx.txId}] for arbitrary order [${orderId}] `;

    // get arbitrary order from database
    const orderEntity =
      await DatabaseAction.getInstance().getOrderById(orderId);
    if (orderEntity === null) {
      logger.warn(baseError + `but order is not found`);
      return false;
    }

    // transaction network is compatible with the order
    if (tx.network !== orderEntity.chain) {
      logger.warn(
        baseError +
          `but transaction chain is unexpected (expected [${orderEntity.chain}] found [${tx.network}])`,
      );
      return false;
    }

    // check if order has any active tx for requested tx type
    const orderTxs =
      await DatabaseAction.getInstance().getOrderValidTxs(orderId);
    if (orderTxs.length !== 0 && orderTxs[0].txId !== tx.txId) {
      logger.warn(baseError + `but order has active tx [${orderTxs[0].txId}]`);
      return false;
    }

    // verify requested tx type with order status
    if (orderTxs.length === 0 && orderEntity.status !== OrderStatus.pending) {
      logger.warn(
        baseError +
          `but order status [${orderEntity.status}] is not compatible with requested tx type [${tx.txType}]`,
      );
      return false;
    }

    // verify requested tx
    if (
      !(await TransactionVerifier.verifyArbitraryTransaction(
        tx,
        orderEntity.orderJson,
      ))
    ) {
      logger.warn(baseError + `but tx hasn't verified`);
      return false;
    }

    return true;
  };
}

export default RequestVerifier;
