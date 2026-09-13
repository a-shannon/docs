import {join} from 'node:path';
import {mkdtempSync} from 'node:fs';
import {launchAuthorizedNative} from './adapter';
import {fixture} from './projectionFixture';
import {nativePin} from './nativePin';
import {verify} from './integration';
import {setupAgreement,state,closeAgreementDatabase} from './agreementPorts';
import {setFixtureChain} from './resolver';
let close:undefined|(()=>Promise<void>);
afterEach(async()=>{await close?.();close=undefined;await closeAgreementDatabase();setFixtureChain(undefined);});
it('actual D-mode owner binds its descriptor and refuses a structural approval',async()=>{
 const {request}=await fixture();await setupAgreement(request.eventId);
 const owner=await launchAuthorizedNative(request,{database:join(mkdtempSync(join(nativePin.runtime,'authorized-pending-')),'reservation.sqlite'),clock:()=>1000n,leaseDuration:1000000n,
  authority:{epoch:'1',publicKeys:state.keys,requiredSign:3,nativeParticipants:[1,2,3,4],nativeThreshold:2,nativeSelected:[1,2]}});
 close=owner.close;expect(await verify(owner.transaction)).toBe(true);
 await expect(owner.approve({})).rejects.toThrow();expect(()=>owner.transaction.toJson()).toThrow();
 await expect(owner.approve({})).rejects.toThrow();
});
