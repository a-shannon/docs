import {join} from 'node:path';
import {mkdtempSync} from 'node:fs';
import {launchAuthorizedNative} from './adapter';
import {fixture} from './projectionFixture';
import {nativePin} from './nativePin';
import {verify,getTxDataHash} from './integration';
import {setupAgreement,state,closeAgreementDatabase,agreementDatabase} from './agreementPorts';
import {FixtureAgreement,votes} from './agreementFixture';
import {setFixtureChain} from './resolver';
import {trace} from './trace';
let close:undefined|(()=>Promise<void>);
afterEach(async()=>{await close?.();close=undefined;await closeAgreementDatabase();setFixtureChain(undefined);vi.restoreAllMocks();});
async function started(){const data=await fixture();await setupAgreement(data.request.eventId);
 const authority={epoch:'1',publicKeys:state.keys,requiredSign:3,nativeParticipants:[1,2,3,4],nativeThreshold:2,nativeSelected:[1,2]};
 const owner=await launchAuthorizedNative(data.request,{database:join(mkdtempSync(join(nativePin.runtime,'authorized-agreement-')),'reservation.sqlite'),clock:()=>1000n,leaseDuration:1000000n,authority});close=owner.close;
 return {...data,authority,owner,tx:owner.transaction};}
async function certified(tx:any){const agreement=new FixtureAgreement();await agreement.prepare();const timestamp=Math.floor(Date.now()/1000);
 await agreement.approve(tx,await votes(tx,timestamp),timestamp);const receipt=agreement.takeVerifiedAgreement(getTxDataHash(tx));expect(receipt).toBeDefined();return {agreement,receipt};}
it('actual request, SQLite reservation and atomic agreement issue authority for the same retained native owner',async()=>{
 const {owner,tx,request}=await started();expect(await verify(tx)).toBe(true);
 const {receipt}=await certified(tx);const approval=await owner.approve(receipt);
 expect(approval).toMatchObject({status:'approved-retained-native',requestDigest:request.requestDigest,txDataHash:getTxDataHash(tx)});
 expect(approval.descriptorDigest).toMatch(/^[0-9a-f]{64}$/);expect(approval.bindingDigest).toMatch(/^[0-9a-f]{64}$/);
 trace('native-authority-issued',{status:approval.status});
 await expect(owner.approve(receipt)).rejects.toThrow();expect(()=>tx.toJson()).toThrow();
});
it.each(['mapping','committee','epoch','generation'])('native authority refuses %s drift after genuine agreement',async(fault)=>{
 const {owner,tx,authority}=await started();const {receipt,agreement}=await certified(tx);
 if(fault==='mapping')authority.nativeParticipants.reverse();
 if(fault==='committee')state.required=4;
 if(fault==='epoch')authority.epoch='2';
 if(fault==='generation')agreement.clearTransactions();
 trace('fault-observed',{fault});await expect(owner.approve(receipt)).rejects.toThrow();expect(()=>tx.toJson()).toThrow();
});
it('a genuine certificate for changed source facts cannot authorize the original request',async()=>{
 const {owner,tx}=await started();
 // Event ID and payout remain identical; only a separately bound source fact changes.
 await agreementDatabase().updateEventData({sourceBlockId:'9'.repeat(64)});
 const {receipt}=await certified(tx);
 await expect(owner.approve(receipt)).rejects.toThrow('authority:provenance');
 expect(()=>tx.toJson()).toThrow();
});
