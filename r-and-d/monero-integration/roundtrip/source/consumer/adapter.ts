import { spawn } from 'node:child_process';
import { readFileSync,mkdtempSync } from 'node:fs';
import {join} from 'node:path';
import { createHash,randomBytes } from 'node:crypto';
import { AbstractChain,AbstractChainNetwork,PaymentTransaction,SigningStatus,TransactionType } from '@rosen-chains/abstract-chain';
import type { ChainConfigs,PaymentOrder,TransactionAssetBalance } from '@rosen-chains/abstract-chain';
import { TokenMap } from '@rosen-bridge/tokens';
import { nativePin } from './nativePin';
import { boundJson,canonical,decimal,frame,hex,ResponseFramer,U64 } from './codec';
import { openRetainedWithdrawal, prepareAuthorizedWithdrawal, recoverRetainedWithdrawal, type RetainedWithdrawalSetup, type AuthorizedWithdrawalSetup } from './retainedIssuer';
import type { ApprovedNativeSummary } from './approvalAuthority';
import type { CompletedWithdrawal } from './withdrawalJournal';
import {openDistributedWithdrawal} from './distributedIssuer';
export type { RetainedWithdrawalSetup, AuthorizedWithdrawalSetup } from './retainedIssuer';
export type { WithdrawalAuthorityProfile, ApprovedNativeSummary } from './approvalAuthority';
export type { CompletedWithdrawal, JournalFaultPoint } from './withdrawalJournal';

const unsupported=():never=>{throw Error('Unsupported offline operation');};
const reject=async():Promise<never>=>unsupported();
export class OfflineNetwork extends AbstractChainNetwork<unknown> {
  getHeight=reject; getTxConfirmation=reject; getAddressAssets=reject;
  getBlockTransactionIds=reject; getBlockInfo=reject; getTransaction=reject;
  submitTransaction=reject; getMempoolTransactions=reject; getTokenDetail=reject; getActualTxId=reject;
}
type Snapshot={ bytes:Buffer; eventId:string; id:string; json:string; recipient:string; payment:bigint; input:bigint; change:bigint; fee:bigint; ceiling:bigint; spend:string; view:string; count:number; live:()=>void };
const brands=new WeakMap<PaymentTransaction,Snapshot>();
const admitted=new Map<string,Snapshot>();
function live(s:Snapshot) { s.live(); if(admitted.get(s.json)!==s) throw Error('Unadmitted candidate'); }
function snapshot(tx:PaymentTransaction):Snapshot {
  const s=brands.get(tx); if(!s) throw Error('Unbranded candidate'); live(s);
  const parsed=frame(s.bytes.toString('hex'));
  if(parsed.eventId!==s.eventId||parsed.id!==s.id||canonical(s.eventId,s.bytes.toString('hex'),s.id)!==s.json)throw Error('Inconsistent native snapshot');
  if(tx.network!=='monero'||tx.eventId!==s.eventId||tx.txId!==s.id||tx.txType!==TransactionType.payment||!Buffer.from(tx.txBytes).equals(s.bytes)||tx.toJson()!==s.json) throw Error('Inconsistent candidate');
  return s;
}
class NativePayment extends PaymentTransaction {
  constructor(s:Snapshot) {
    live(s); super('monero',s.id,s.eventId,Buffer.from(s.bytes),TransactionType.payment);
    brands.set(this,s);
    Object.defineProperty(this,'txBytes',{get:()=>{live(s);return Buffer.from(s.bytes);},enumerable:true,configurable:false});
    Object.defineProperty(this,'toJson',{value:()=>{live(s);return s.json;},writable:false,configurable:false,enumerable:true});
    Object.freeze(this);
  }
}
Object.freeze(NativePayment.prototype);
let generation=0n;
let retireCurrent:undefined|(()=>Promise<void>);
export async function launchNative(signal?:AbortSignal):Promise<{transaction:PaymentTransaction; close:()=>Promise<void>}> {
  if(signal?.aborted) throw Error('Cancelled');
  const myGeneration=++generation;
  if(myGeneration>U64) throw Error('Generation exhausted');
  const previous=retireCurrent; if(previous) await previous();
  if(myGeneration!==generation || signal?.aborted) throw Error('Generation retired');
  const bin=readFileSync(nativePin.path);
  if(createHash('sha256').update(bin).digest('hex')!==nativePin.sha256) throw Error('Native pin mismatch');
  const runtime=mkdtempSync(join(nativePin.runtime,'consumer-'));
  const child=spawn(nativePin.path,[runtime],{windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});
  let revoked=false,exited=false,sent=false,settled=false,stderr=0,s:Snapshot|undefined;
  let resolve!:(v:PaymentTransaction)=>void,rejectReady!:(e:Error)=>void;
  const ready=new Promise<PaymentTransaction>((a,b)=>{resolve=a;rejectReady=b;});
  let exitResolve!:()=>void; const exitPromise=new Promise<void>(a=>{exitResolve=a;});
  const invalidate=()=>{revoked=true;if(s && admitted.get(s.json)===s) admitted.delete(s.json);if(!settled){settled=true;rejectReady(Error('Native admission revoked'));}};
  const close=async()=>{invalidate(); if(!exited){child.stdin.end('STOP\n');const timer=setTimeout(()=>{if(!exited)child.kill();},2000);await exitPromise;clearTimeout(timer);} };
  retireCurrent=close;
  const fail=()=>{invalidate();if(!exited)child.kill();};
  const abort=()=>{void close();}; signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(fail,180000);
  const challenge=randomBytes(32).toString('hex'); const framer=new ResponseFramer();
  child.once('error',()=>{fail();});
  child.once('close',()=>{exited=true;invalidate();clearTimeout(timer);signal?.removeEventListener('abort',abort);exitResolve();});
  child.once('exit',()=>{invalidate();});
  child.stdin.on('error',fail);
  child.stderr.on('data',(raw:Buffer)=>{stderr+=raw.length;if(stderr>4096)fail();});
  child.stdout.on('data',(raw:Buffer)=>{
    try {
      if(!sent||revoked||myGeneration!==generation) throw Error('Invalid lifecycle');
      const rows=framer.push(raw);if(!rows)return;
      if(rows[0]!=='W1HA1'||rows[1]!==challenge||rows[2]!==myGeneration.toString())throw Error('Invalid response correlation');
      const f=frame(rows[3]);if(!/^[\x21-\x7e]{1,256}$/.test(rows[4]))throw Error('Invalid recipient');
      const [payment,input,change,fee,ceiling]=rows.slice(5,10).map(decimal);
      hex(rows[10],32,32);hex(rows[11],32,32);const count=decimal(rows[12]);if(count<1n||count>16n)throw Error('Invalid input count');
      s={...f,json:canonical(f.eventId,rows[3],f.id),recipient:rows[4],payment,input,change,fee,ceiling,spend:rows[10],view:rows[11],count:Number(count),live:()=>{if(revoked||myGeneration!==generation||child.exitCode!==null||child.signalCode!==null)throw Error('Revoked native owner');}};
      s.live();if(admitted.has(s.json))throw Error('Duplicate admission');admitted.set(s.json,s);
      const tx=new NativePayment(s);settled=true;clearTimeout(timer);resolve(tx);
    } catch {fail();}
  });
  child.once('spawn',()=>{if(revoked)return;sent=true;child.stdin.write(`W1HQ1\n${challenge}\n${myGeneration}\n`);});
  try {const transaction=await ready;snapshot(transaction);return Object.freeze({transaction,close});}catch(e){await close();throw e;}
}
const rows=[{ergo:{tokenId:'a'.repeat(64),name:'wrapped XMR',decimals:12,type:'EIP-004',residency:'wrapped',extra:{}},monero:{tokenId:'XMR',name:'XMR',decimals:12,type:'native',residency:'native',extra:{}}}];
/** Admission is private and occurs only after this issuer's successful commit. */
export async function launchReservedNative(requestValue: unknown, setup: RetainedWithdrawalSetup, signal?: AbortSignal): Promise<{transaction:PaymentTransaction;close:()=>Promise<void>}> {
  if(signal?.aborted)throw Error('Cancelled');
  const myGeneration=++generation;
  if(myGeneration>U64)throw Error('Generation exhausted');
  const previous=retireCurrent;if(previous)await previous();
  const current=()=>{if(myGeneration!==generation||signal?.aborted)throw Error('Generation retired');};
  current();
  let s:Snapshot|undefined;
  const revoke=()=>{if(s&&admitted.get(s.json)===s)admitted.delete(s.json);};
  let stop:undefined|(()=>Promise<void>);
  const own=(close:()=>Promise<void>)=>{stop=close;retireCurrent=close;};
  try {
    const held=await openRetainedWithdrawal(requestValue,setup,myGeneration,current,own,revoke,signal);
    current();held.snapshot.live();
    s=held.snapshot;
    if(admitted.has(s.json))throw Error('Duplicate admission');
    admitted.set(s.json,s);
    const transaction=new NativePayment(s);
    snapshot(transaction);
    const close=async()=>{revoke();await held.close();};
    retireCurrent=close;
    return Object.freeze({transaction,close});
  } catch(error) {revoke();if(stop)await stop();throw error;}
}
/** Genuine committed D-mode owner; approval only consumes an actual common receipt. */
export async function launchAuthorizedNative(requestValue: unknown, setup: AuthorizedWithdrawalSetup, signal?: AbortSignal): Promise<Readonly<{ transaction: PaymentTransaction; close: () => Promise<void>; approve: (receipt: unknown) => Promise<Readonly<ApprovedNativeSummary>>; sign: () => Promise<Readonly<CompletedWithdrawal>> }>> {
  const open = prepareAuthorizedWithdrawal(setup);
  if (signal?.aborted) throw Error('Cancelled');
  const myGeneration = ++generation;
  if (myGeneration > U64) throw Error('Generation exhausted');
  const previous = retireCurrent; if (previous) await previous();
  const current = () => { if (myGeneration !== generation || signal?.aborted) throw Error('Generation retired'); };
  current();
  let s: Snapshot | undefined, stop: (() => Promise<void>) | undefined;
  const revoke = () => { if (s && admitted.get(s.json) === s) admitted.delete(s.json); };
  const own = (close: () => Promise<void>) => { stop = close; retireCurrent = close; };
  try {
    const held = await open(requestValue, myGeneration, current, own, revoke, signal);
    current(); held.snapshot.live();
    if (!held.approve || !held.sign) throw Error('authority:no-owned-approval');
    s = held.snapshot;
    if (admitted.has(s.json)) throw Error('Duplicate admission');
    admitted.set(s.json, s);
    const transaction = new NativePayment(s);
    snapshot(transaction);
    const close = async () => { revoke(); await held.close(); };
    const approve = async (receipt: unknown) => {
      try {
        snapshot(transaction);
        const summary = await held.approve!(receipt);
        current(); snapshot(transaction);
        return summary;
      } catch (error) { await close(); throw error; }
    };
    const sign = async () => {
      try {
        snapshot(transaction);
        const completed = await held.sign!();
        current();
        return completed;
      } catch (error) { await close(); throw error; }
    };
    retireCurrent = close;
    return Object.freeze({ transaction, close, approve, sign });
  } catch (error) { revoke(); if (stop) await stop(); throw error; }
}
/** Only journal-anchored committed bytes can be recovered; no signing is retried. */
export function recoverAuthorizedNative(database: string, reservationId: string, signal?: AbortSignal): Promise<Readonly<CompletedWithdrawal>> {
  return recoverRetainedWithdrawal(database, reservationId, signal);
}
/** Separate native processes; admission still belongs to this private registry. */
export async function launchDistributedNative(vault:unknown,request:unknown,setup:AuthorizedWithdrawalSetup,timestamp:number){
  const mine=++generation;if(mine>U64)throw Error('Generation exhausted');
  if(retireCurrent)await retireCurrent();
  const held=await openDistributedWithdrawal(vault,request,setup,timestamp);
  let s:Snapshot|undefined;
  const close=async()=>{if(s&&admitted.get(s.json)===s)admitted.delete(s.json);await held.close();};
  try{
    const current=()=>{if(generation!==mine)throw Error('Generation retired');held.snapshot.live();};current();
    s={...held.snapshot,live:current};if(admitted.has(s.json))throw Error('Duplicate admission');
    admitted.set(s.json,s);retireCurrent=close;
    const transaction=new NativePayment(s);snapshot(transaction);
    return Object.freeze({transaction,close,approve:held.approve,sign:held.sign,
      reservationId:held.reservationId,anchor:held.anchor,disposition:held.disposition,backingClaim:held.backingClaim,directories:held.directories,counts:held.counts});
  }catch(error){await close();throw error;}
}
function freezeRow(row:Record<string,{extra:object}>){for(const token of Object.values(row)){Object.freeze(token.extra);Object.freeze(token);}Object.freeze(row);}
freezeRow(rows[0]);Object.freeze(rows);
const config:ChainConfigs=Object.freeze({fee:0n,confirmations:Object.freeze({observation:0,payment:0,cold:0,manual:0,arbitrary:0}),addresses:Object.freeze({lock:'synthetic',cold:'synthetic',permit:'synthetic',fraud:'synthetic'}),rwtId:'synthetic'});
export class MoneroChain extends AbstractChain<unknown> {
  readonly CHAIN='monero';readonly NATIVE_TOKEN_ID='XMR';protected extractor=undefined;
  readonly calls:string[]=[];
  static async create(tokenRows=rows) {const map=new TokenMap();await map.updateConfigByJson(structuredClone(tokenRows));const a=map.search('monero',{tokenId:'XMR'}),b=map.search('ergo',{tokenId:tokenRows[0]?.ergo.tokenId});const u=map.unwrapAmount('XMR',17n,'monero');if(tokenRows.length!==1||a.length!==1||b.length!==1||a[0]!==b[0]||map.getSignificantDecimals('XMR')!==12||u.amount!==17n||u.decimals!==12)throw Error('Invalid TokenMap profile');freezeRow(a[0]);return new MoneroChain(new OfflineNetwork(),config,map);}
  verifyPaymentTransaction=async(tx:PaymentTransaction)=>{this.calls.push('consistency');snapshot(tx);await Promise.resolve();snapshot(tx);return true;};
  verifyTransactionFee=async(tx:PaymentTransaction)=>{this.calls.push('fee');snapshot(tx);await Promise.resolve();const s=snapshot(tx);return s.fee>0n&&s.fee<=s.ceiling;};
  verifyNoTokenBurned=async(tx:PaymentTransaction)=>{this.calls.push('no-burn');snapshot(tx);await Promise.resolve();const s=snapshot(tx);const outputs=s.payment+s.change+s.fee;return outputs<=U64&&s.input===outputs;};
  verifyTransactionExtraConditions=(tx:PaymentTransaction,status:SigningStatus)=>{this.calls.push('extra');const s=snapshot(tx);return status===SigningStatus.UnSigned&&s.bytes.subarray(0,7).equals(Buffer.from([87,49,72,67,1,1,1]))&&s.payment>0n&&s.change>=0n&&s.count>=1&&s.count<=16&&s.spend!=='0'.repeat(64)&&s.view!=='0'.repeat(64);};
  getTransactionAssets=async(tx:PaymentTransaction):Promise<TransactionAssetBalance>=>{snapshot(tx);await Promise.resolve();const s=snapshot(tx);return {inputAssets:{nativeToken:s.input,tokens:[]},outputAssets:{nativeToken:s.payment+s.change,tokens:[]}};};
  extractTransactionOrder=(tx:PaymentTransaction):PaymentOrder=>{const s=snapshot(tx);return [{address:s.recipient,assets:{nativeToken:s.payment,tokens:[]}}];};
  PaymentTransactionFromJson=(text:string)=>{const parsed=boundJson(text);const s=admitted.get(parsed.json);if(!s)throw Error('Unadmitted candidate');live(s);return new NativePayment(s);};
  getMinimumNativeToken=()=>0n;
  generateMultipleTransactions=reject;isTxValid=reject;signTransaction=reject;isTransactionInSign=reject;submitTransaction=reject;isTxInMempool=reject;rawTxToPaymentTransaction=reject;protected serializeTx=unsupported;
}
