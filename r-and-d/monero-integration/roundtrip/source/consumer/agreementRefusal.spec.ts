import {join} from 'node:path';
import {mkdtempSync} from 'node:fs';
import {Communicator} from '@rosen-bridge/communication';
import type {PaymentTransaction} from '@rosen-chains/abstract-chain';
import {launchReservedNative} from './adapter';
import {fixture} from './projectionFixture';
import {nativePin} from './nativePin';
import {getTxDataHash} from './integration';
import {FixtureAgreement,votes} from './agreementFixture';
import {setupAgreement,state,agreementDatabase,closeAgreementDatabase} from './agreementPorts';
import {consumeVerifiedAgreement} from '../guard-service/src/agreement/txAgreement';
import RequestVerifier from '../guard-service/src/verification/requestVerifier';
import {setFixtureChain} from './resolver';
import {trace} from './trace';
import * as commitModule from '../guard-service/src/db/moneroAgreementCommit';
import {TransactionEntity} from '../guard-service/src/db/entities/transactionEntity';
import {ConfirmedEventEntity} from '../guard-service/src/db/entities/confirmedEventEntity';

// One unchanged native owner is shared across these isolated agreement failures.
// Each case gets fresh committee facts, database facts and an agreement instance.
let tx:PaymentTransaction,close:()=>Promise<void>;
beforeAll(async()=>{const {request}=await fixture();const owner=await launchReservedNative(request,{
 database:join(mkdtempSync(join(nativePin.runtime,'receipt-refusals-')),'reservation.sqlite'),clock:()=>1000n,leaseDuration:1000000n});
 tx=owner.transaction;close=owner.close;});
beforeEach(async()=>{await setupAgreement(tx.eventId);});
afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{await close?.();await closeAgreementDatabase();setFixtureChain(undefined);});
const stored=()=>agreementDatabase().getTransactions();

describe('actual certificate and provenance refusal boundaries',()=>{
 it.each(['forged','insufficient','duplicate-vote','invalid-extra-vote','foreign-hash','future','expired','duplicate-committee'])('%s refuses before approval storage',async(fault)=>{
   const agreement=new FixtureAgreement();await agreement.prepare();let timestamp=Math.floor(Date.now()/1000);
   if(fault==='future')timestamp+=100;if(fault==='expired')timestamp-=3601;
   let signatures=await votes(tx,timestamp);signatures[3]='';
   if(fault==='forged')signatures[0]='00';
   if(fault==='insufficient')signatures[2]='';
   if(fault==='duplicate-vote')signatures[1]=signatures[0];
   if(fault==='invalid-extra-vote')signatures[3]='00';
   if(fault==='foreign-hash')signatures=await Promise.all(state.signers.map((signer,i)=>signer.sign(Communicator.generatePayloadToSign({txDataHash:'0'.repeat(64)},timestamp,state.keys[i],'1.0.0'))));
   if(fault==='duplicate-committee')state.keys[1]=state.keys[0];
   trace('fault-observed',{fault});await agreement.approve(tx,signatures,timestamp);
   expect(agreement.takeVerifiedAgreement(getTxDataHash(tx))).toBeUndefined();expect(await stored()).toHaveLength(0);
 });
 it('a selected candidate without checked request provenance cannot receive a receipt',async()=>{
   const agreement=new FixtureAgreement();await agreement.prepare();const timestamp=Math.floor(Date.now()/1000);
   agreement.select(tx,timestamp);const signatures=await votes(tx,timestamp);
   await agreement.approve(tx,signatures,timestamp);
   expect(agreement.takeVerifiedAgreement(getTxDataHash(tx))).toBeUndefined();expect(await stored()).toHaveLength(0);
 });
 it('changed event payment facts with the same event ID fail the actual EventOrder comparison',async()=>{
   const checked=vi.spyOn(RequestVerifier,'captureVerifiedMoneroEventRequest');
   await agreementDatabase().updateEventData({amount:'1000000220'});const agreement=new FixtureAgreement();await agreement.prepare();
   const timestamp=Math.floor(Date.now()/1000);await agreement.approve(tx,await votes(tx,timestamp),timestamp);
   expect(checked).toHaveBeenCalledTimes(1);expect(agreement.takeVerifiedAgreement(getTxDataHash(tx))).toBeUndefined();
   expect(await stored()).toHaveLength(0);
 });
 it.each(['approval-insert-aborts','event-status-update-ignored','committee-drift-before-commit'])('%s prevents issuance after actual acceptance',async(fault)=>{
   const agreement=new FixtureAgreement();await agreement.prepare();const timestamp=Math.floor(Date.now()/1000);
   const database=agreementDatabase();let reached=false;
   if(fault==='approval-insert-aborts'){
     const table=database.dataSource.getMetadata(TransactionEntity).tableName;
     await database.dataSource.query(`CREATE TRIGGER fixture_insert_abort BEFORE INSERT ON "${table}" BEGIN SELECT RAISE(ABORT, 'fixture-insert-failure'); END`);
   }
   if(fault==='event-status-update-ignored'){
     const table=database.dataSource.getMetadata(ConfirmedEventEntity).tableName;
     await database.dataSource.query(`CREATE TRIGGER fixture_status_ignore BEFORE UPDATE OF status ON "${table}" BEGIN SELECT RAISE(IGNORE); END`);
   }
   const actual=commitModule.commitMoneroAgreement;
   vi.spyOn(commitModule,'commitMoneroAgreement').mockImplementation((source,value,provenance,required,current,originalFault)=>actual(source,value,provenance,required,current,async phase=>{
     reached=true;await originalFault?.(phase);if(fault==='committee-drift-before-commit'&&phase==='before-commit')state.required=4;
   }));
   trace('fault-observed',{fault});await agreement.approve(tx,await votes(tx,timestamp),timestamp);
   expect(reached).toBe(true);
   expect(agreement.takeVerifiedAgreement(getTxDataHash(tx))).toBeUndefined();
   expect(await stored()).toHaveLength(0);expect((await database.getEventById(tx.eventId))?.status).toBe('pending-payment');
 });
 it('committee drift after real signature verification invalidates the continuation',async()=>{
   const agreement=new FixtureAgreement();await agreement.prepare();const timestamp=Math.floor(Date.now()/1000);
   const signatures=await votes(tx,timestamp);const original=state.signers[0].verify.bind(state.signers[0]);let reached=false;
   vi.spyOn(state.signers[0],'verify').mockImplementation(async(...args)=>{const result=await original(...args);reached=true;state.required=4;return result;});
   await agreement.approve(tx,signatures,timestamp);expect(reached).toBe(true);
   expect(agreement.takeVerifiedAgreement(getTxDataHash(tx))).toBeUndefined();expect(await stored()).toHaveLength(0);
 });
 it.each(['committee','generation','expiry'])('already issued receipt rejects %s drift on consumption',async(fault)=>{
   const agreement=new FixtureAgreement();await agreement.prepare();const timestamp=Math.floor(Date.now()/1000);
   await agreement.approve(tx,await votes(tx,timestamp),timestamp);
   const receipt=agreement.takeVerifiedAgreement(getTxDataHash(tx));expect(receipt).toBeDefined();
   if(fault==='committee')state.required=4;
   if(fault==='generation')agreement.clearTransactions();
   if(fault==='expiry')vi.spyOn(Date,'now').mockReturnValue((timestamp+3601)*1000);
   expect(()=>consumeVerifiedAgreement(receipt)).toThrow();expect(()=>consumeVerifiedAgreement(receipt)).toThrow();
 });
 it('foreign active transaction cannot hide behind an own transaction in the first row',async()=>{
   await agreementDatabase().insertTransaction(tx,state.required);
   await agreementDatabase().insertTransaction(tx,state.required,'foreign');
   expect(await RequestVerifier.captureVerifiedMoneroEventRequest(tx)).toBeUndefined();
 });
 it.each(['event-invalidated','foreign-active-added'])('%s after request verification cannot be overwritten by approval',async(fault)=>{
   const agreement=new FixtureAgreement();await agreement.prepare();const timestamp=Math.floor(Date.now()/1000);
   let reached=false;const actual=commitModule.commitMoneroAgreement;
   vi.spyOn(commitModule,'commitMoneroAgreement').mockImplementation(async(...args)=>{
     reached=true;
     if(fault==='event-invalidated')await agreementDatabase().setEventStatus(tx.eventId,'rejected');
     else await agreementDatabase().insertTransaction(tx,state.required,'foreign');
     return actual(...args);
   });
   await agreement.approve(tx,await votes(tx,timestamp),timestamp);expect(reached).toBe(true);
   expect(agreement.takeVerifiedAgreement(getTxDataHash(tx))).toBeUndefined();
   if(fault==='event-invalidated'){
     expect((await agreementDatabase().getEventById(tx.eventId))?.status).toBe('rejected');expect(await stored()).toHaveLength(0);
   }else{
     expect((await stored()).map(value=>value.txId)).toEqual(['foreign']);
     expect((await agreementDatabase().getEventById(tx.eventId))?.status).toBe('pending-payment');
   }
 });
});
