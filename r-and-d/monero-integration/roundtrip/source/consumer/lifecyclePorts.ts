import { Not } from '@rosen-bridge/extended-typeorm';
import type { AgreementDatabase } from './agreementDatabase';
import { TransactionEntity } from '../guard-service/src/db/entities/transactionEntity';
import { ConfirmedEventEntity } from '../guard-service/src/db/entities/confirmedEventEntity';
export const lifecycleState = { database: undefined as AgreementDatabase | undefined };
export const lifecycleSource = () => ({source:{event:{height:100,fromChain:'ergo',toChain:'monero',fromAddress:'local-source',toAddress:'local-recipient',amount:'100',bridgeFee:'0',networkFee:'0',sourceChainTokenId:'a'.repeat(64),targetChainTokenId:'XMR',sourceTxId:'b'.repeat(64),sourceChainHeight:90,sourceBlockId:'c'.repeat(64),WIDsHash:'d'.repeat(64),WIDsCount:1},triggerTransactionId:'e'.repeat(64),triggerBoxId:'f'.repeat(64),wids:['01'.repeat(32)]}} as Parameters<typeof AgreementDatabase.open>[1]);
const database = () => { if (!lifecycleState.database) throw Error('Lifecycle DB missing'); return lifecycleState.database; };
export const DatabaseAction = { getInstance: () => ({
  getActiveTransactions: () => database().dataSource.manager.find(TransactionEntity, { where: { status: Not('completed') }, relations: ['event', 'order'] }),
  setTxStatus: (txId: string, status: string) => database().dataSource.manager.update(TransactionEntity, { txId }, { status }),
  setEventStatus: (id: string, status: string) => database().setEventStatus(id, status),
  updateTxLastCheck: (txId: string, lastCheck: number) => database().dataSource.manager.update(TransactionEntity, { txId }, { lastCheck }),
  setEventStatusToPending: (id: string, status: string) => database().dataSource.manager.update(ConfirmedEventEntity, { id }, { status, firstTry: null } as any),
}) };
export const NotificationHandler = { getInstance: () => ({ notify: async () => undefined }) };
export const dataSource = undefined;
export const TokenHandler = undefined;
/** Unused constructor configuration facts; scoped bootstrap skips those constructors. */
export default {};
