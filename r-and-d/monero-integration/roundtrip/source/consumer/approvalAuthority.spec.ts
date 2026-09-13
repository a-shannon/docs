import {join} from 'node:path';
import {mkdtempSync} from 'node:fs';
import {launchReservedNative} from './adapter';
import {fixture} from './projectionFixture';
import {nativePin} from './nativePin';
import {getTxDataHash} from './integration';
import {FixtureAgreement,votes} from './agreementFixture';
import {setupAgreement,state,closeAgreementDatabase} from './agreementPorts';
import {consumeVerifiedAgreement} from '../guard-service/src/agreement/txAgreement';
import RequestVerifier from '../guard-service/src/verification/requestVerifier';
import EventOrder from '../guard-service/src/event/eventOrder';
import {setFixtureChain} from './resolver';
let close:undefined|(()=>Promise<void>);
afterEach(async()=>{await close?.();close=undefined;await closeAgreementDatabase();setFixtureChain(undefined);vi.restoreAllMocks();});
async function held(){const data=await fixture();await setupAgreement(data.request.eventId);
 const owner=await launchReservedNative(data.request,{database:join(mkdtempSync(join(nativePin.runtime,'agreement-')),'reservation.sqlite'),clock:()=>1000n,leaseDuration:1000000n});close=owner.close;
 return {...data,owner,tx:owner.transaction};}

describe('actual Rosen agreement verified receipts',()=>{
 it.each(['creator','selected-receiver','absent-receiver'])('%s traverses actual request and canonical ECDSA certificate checks',async(route)=>{
   const requestCheck=vi.spyOn(RequestVerifier,'captureVerifiedMoneroEventRequest');
   const orderCheck=vi.spyOn(EventOrder,'createEventPaymentOrder');
   const {tx,request,data}=await held();const agreement=new FixtureAgreement();await agreement.prepare();
   let timestamp=Math.floor(Date.now()/1000);
   if(route==='creator'){agreement.addTransactionToQueue(tx);await agreement.processAgreementQueue();timestamp=agreement.candidateTime(tx)!;expect(timestamp).toBeTypeOf('number');}
   if(route==='selected-receiver'){expect(await agreement.request(tx)).toBe(true);agreement.select(tx,timestamp);}
   const signatures=await votes(tx,timestamp);
   if(route==='creator'){
     await agreement.respond(tx,1,signatures[1],timestamp);expect(agreement.takeVerifiedAgreement(getTxDataHash(tx))).toBeUndefined();
     await agreement.respond(tx,2,signatures[2],timestamp);
   }else await agreement.approve(tx,[...signatures.slice(0,3),''],timestamp);
   const receipt=agreement.takeVerifiedAgreement(getTxDataHash(tx));expect(receipt).toBeDefined();
   const verified=consumeVerifiedAgreement(receipt);
   expect(verified.certificate.txJson).toBe(tx.toJson());expect(verified.certificate.requiredSign).toBe(3);
   expect(verified.provenance.eventId).toBe(request.eventId);expect(verified.provenance.event).toEqual(data.source.event);
   expect(verified.provenance.triggerTransactionId).toBe(data.source.triggerTransactionId);
   expect(verified.provenance.triggerBoxId).toBe(data.source.triggerBoxId);expect(verified.provenance.wids).toEqual(data.source.wids);
   expect(requestCheck).toHaveBeenCalledTimes(1);expect(orderCheck.mock.calls.length).toBeGreaterThanOrEqual(4);
   expect(()=>consumeVerifiedAgreement(receipt)).toThrow();expect(()=>consumeVerifiedAgreement(verified.certificate)).toThrow();
   expect(agreement.takeVerifiedAgreement(getTxDataHash(tx))).toBeUndefined();
 });
});
