import {ECDSA} from '@rosen-bridge/encryption';
import type {PaymentTransaction} from '@rosen-chains/abstract-chain';
import {terms} from './projectionFixture';
import {trace} from './trace';
import {AgreementDatabase} from './agreementDatabase';

// Local committee/DB/transport facts. Actual agreement and request verifiers run unchanged by the loader.
export const EventStatus={pendingPayment:'pending-payment',pendingReward:'pending-reward',inPayment:'in-payment',inReward:'in-reward'};
export const TransactionStatus={approved:'approved',invalid:'invalid'};
export const OrderStatus={pending:'pending',inProcess:'in-process'};
export const ChainNativeToken={ergo:'ERG',monero:'XMR'};
export const ERGO_CHAIN='ergo';
export const state={keys:[] as string[],signers:[] as ECDSA[],local:0,required:3,turn:0,
  source:terms(),events:[] as string[],database:undefined as AgreementDatabase|undefined};
export function agreementDatabase(){if(!state.database)throw Error('Agreement database unconfigured');return state.database;}
export async function closeAgreementDatabase(){const owned=state.database;state.database=undefined;await owned?.close();}
const db={
  get publicKeys(){return state.keys;},get requiredSign(){return state.required;},
  get dataSource(){return agreementDatabase().dataSource;},
  getEventById:async(id:string)=>{state.events.push('event-read');return agreementDatabase().getEventById(id);},
  getEventValidTxsByType:async(id:string,type:string)=>agreementDatabase().getEventValidTxsByType(id,type),
  getEventCommitments:async()=>state.source.source.wids.map(WID=>({WID})),
  getTxById:async(id:string)=>agreementDatabase().getTxById(id),
  setEventStatus:async(id:string,status:string)=>agreementDatabase().setEventStatus(id,status),
  getDialer:()=>({sendMessage:()=>{state.events.push('transport');trace('agreement-transport',{});},subscribeChannel:()=>undefined}),
};
export const DatabaseAction={getInstance:()=>db};
const ports={
  getInstance:()=>db,
  get guardSecretEcdsa(){if(!state.signers[state.local])throw Error('Committee unconfigured');return state.signers[state.local];},
  UP_TIME_LENGTH:3600,guardTurn:()=>state.turn,
  getEventFeeConfig:()=>({...state.source.profile.fees}),
  insertTx:async(tx:PaymentTransaction,requiredSign:number)=>{
    await agreementDatabase().insertTransaction(tx,requiredSign);
    state.events.push('insert');trace('agreement-storage',{});
  },
};
export default ports;
export async function setupAgreement(eventId:string,source=terms()){
  await closeAgreementDatabase();
  state.source=source;state.local=0;state.required=3;state.turn=0;state.events=[];
  state.signers=Array.from({length:4},(_,i)=>new ECDSA((i+1).toString(16).padStart(64,'0')));
  state.keys=await Promise.all(state.signers.map(s=>s.getPk()));
  state.database=await AgreementDatabase.open(eventId,state.source);
}
