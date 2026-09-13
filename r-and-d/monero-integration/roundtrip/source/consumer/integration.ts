import * as actualSerializer from '../guard-service/src/transaction/transactionSerializer';
import TransactionVerifier from '../guard-service/src/verification/transactionVerifier';
import {boundJson} from './codec';
import {getChain} from './resolver';
import type {PaymentTransaction} from '@rosen-chains/abstract-chain';
export function fromJson(text:string){boundJson(text);return actualSerializer.fromJson(text,getChain);}
export function getTxDataHash(tx:PaymentTransaction){getChain(tx.network).extractTransactionOrder(tx);return actualSerializer.getTxDataHash(tx);}
export const verify=TransactionVerifier.verifyTxCommonConditions;
