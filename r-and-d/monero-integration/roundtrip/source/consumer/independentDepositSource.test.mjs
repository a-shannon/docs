import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical} from './participantHarness.mjs';
import {observerRequest,observerRequestDigest,validateObserverResult,independentlyVerifyDeposit} from './independentDepositSource.mjs';
const h='11'.repeat(32),scan={groupPublicKey:h,genesis:h,keyImage:h,snapshot:{height:100,hash:h},source:{kind:'deposit',startHeight:0,blockHashes:Array(18).fill(h),ringIndices:Array.from({length:16},(_,i)=>i),outputIds:Array.from({length:2},()=>({transaction:h,index:0,chainIndex:1})),deposit:{txId:h,txBytes:'0102',blockHash:h,blockHeight:20,outputKey:h,outputIndex:0,chainIndex:1,amountAtomic:'500000240',feeAtomic:'20'}}};
const request=observerRequest(scan,'22'.repeat(32));
const result=()=>({type:'public-source-observation',observerNonce:request.observerNonce,observerKind:'local-fixture-fixed-view-v1',genesis:h,snapshot:scan.snapshot,vaultAddress:'4'+'1'.repeat(94),sourceRequestDigest:observerRequestDigest(request),suppliedKeyImage:h,suppliedKeyImageSpentStatus:0,imageAssociationVerified:false,outputs:[{txId:h,blockHash:h,blockHeight:20,publicKey:h,outputIndex:0,chainIndex:1,amountAtomic:'500000240',feeAtomic:'20',owned:true,maturity:'unlocked',historyOccurrences:1}]});
const frame=value=>Buffer.from(canonical(value)+'\n');
test('explicit authenticated observation preserves multiplicity and binds profile',()=>{
  const opted=observerRequest({...scan,sourcePolicy:'authenticated-backing-v1'},request.observerNonce);
  const observed={...result(),sourcePolicy:'authenticated-backing-v1',sourceRequestDigest:observerRequestDigest(opted)};
  observed.outputs[0].historyOccurrences=2;
  assert.equal(validateObserverResult(frame(observed),opted).outputs[0].historyOccurrences,2);
  assert.notEqual(observerRequestDigest(opted),observerRequestDigest(request));
  for(const count of [0,-1,1.5,0x100000000,Number.MAX_SAFE_INTEGER+1]){
    const bad=structuredClone(observed);bad.outputs[0].historyOccurrences=count;assert.throws(()=>validateObserverResult(frame(bad),opted));
  }
  for(const policy of [undefined,'unknown',null]){
    const bad=structuredClone(observed);if(policy===undefined)delete bad.sourcePolicy;else bad.sourcePolicy=policy;
    assert.throws(()=>validateObserverResult(frame(bad),opted));
  }
  assert.throws(()=>observerRequest({...scan,sourcePolicy:'unknown'},request.observerNonce));
  assert.throws(()=>validateObserverResult(frame(observed),request));
  const association=structuredClone(observed);association.imageAssociationVerified=true;assert.throws(()=>validateObserverResult(frame(association),opted));
});
test('public scan schema rejects private fields, noncanonical amounts and changed bounds',()=>{assert.deepEqual(observerRequest(scan,request.observerNonce),request);for(const change of [v=>{v.privatePath='forbidden';},v=>{v.source.deposit.privateView='forbidden';},v=>{v.source.deposit.amountAtomic='0500000240';},v=>{v.snapshot.height=4097;},v=>{v.keyImage='00'.repeat(32);}]){const candidate=structuredClone(scan);change(candidate);assert.throws(()=>observerRequest(candidate,request.observerNonce));}});
test('result binds nonce and exact whole source request, and refuses false image association claims',()=>{assert.deepEqual(validateObserverResult(frame(result()),request),result());for(const change of [v=>{v.observerNonce=h;},v=>{v.sourceRequestDigest=h;},v=>{v.imageAssociationVerified=true;},v=>{v.suppliedKeyImageSpentStatus=1;},v=>{v.outputs[0].historyOccurrences=2;},v=>{v.outputs[0].publicKey='33'.repeat(32);},v=>{v.outputs[0].amountAtomic='500000241';},v=>{v.signingKeys=[];},v=>{v.snapshot={...v.snapshot,height:101};}]){const candidate=result();change(candidate);assert.throws(()=>validateObserverResult(frame(candidate),request));}const changed=structuredClone(request);changed.source.deposit.txBytes='0103';assert.throws(()=>validateObserverResult(frame(result()),changed),/exact source request binding/);});
test('frame rejects duplicate keys, whitespace, nonASCII and absent terminal newline',()=>{const valid=frame(result());assert.throws(()=>validateObserverResult(valid.subarray(0,-1),request));assert.throws(()=>validateObserverResult(Buffer.from(' '+valid.toString()),request));assert.throws(()=>validateObserverResult(Buffer.from(valid.toString().replace('"genesis":','"genesis":"'+h+'","genesis":')),request));assert.throws(()=>validateObserverResult(Buffer.from(valid.toString().replace('public-source-observation','public-source-observationé')),request));});
test('binary pin failure occurs before any child process can execute',async()=>{const directory=mkdtempSync(join(tmpdir(),'public-observer-pin-')),binary=join(directory,'unexecuted.exe');writeFileSync(binary,'not an executable');try{await assert.rejects(()=>independentlyVerifyDeposit({binary,sha256:'00'.repeat(32),publicScan:scan,runtimeDirectory:directory,observerId:'watcher-0'}),/Observer binary pin/);}finally{rmSync(directory,{recursive:true});}});
