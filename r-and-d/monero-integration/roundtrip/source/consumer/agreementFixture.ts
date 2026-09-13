import {Communicator} from '@rosen-bridge/communication';
import type {PaymentTransaction} from '@rosen-chains/abstract-chain';
import TxAgreement from '../guard-service/src/agreement/txAgreement';
import {getTxDataHash} from './integration';
import {state} from './agreementPorts';

export class FixtureAgreement extends TxAgreement{
  constructor(){super();(TxAgreement as any).dialer={sendMessage:()=>{state.events.push('transport');}};}
  prepare=async()=>{await this.getIndex();};
  approve=(tx:PaymentTransaction,signatures:string[],timestamp:number)=>this.processApprovalMessage(tx,0,signatures,timestamp,'fixture-peer');
  respond=(tx:PaymentTransaction,index:number,signature:string,timestamp:number)=>this.processAgreementResponse(getTxDataHash(tx),index,signature,timestamp);
  request=(tx:PaymentTransaction)=>this.verifyTransactionRequest(tx,0);
  // Inserts only the normal queue selection; it cannot issue private provenance.
  select=(tx:PaymentTransaction,timestamp:number)=>{this.transactions.set(getTxDataHash(tx),{tx,timestamp});};
  candidateTime=(tx:PaymentTransaction)=>this.transactions.get(getTxDataHash(tx))?.timestamp;
}
export async function votes(tx:PaymentTransaction,timestamp:number){return Promise.all(state.signers.map((signer,i)=>signer.sign(
  Communicator.generatePayloadToSign({txDataHash:getTxDataHash(tx)},timestamp,state.keys[i],'1.0.0'))));}
