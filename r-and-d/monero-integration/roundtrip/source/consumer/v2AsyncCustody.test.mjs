import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';

const root=resolve(import.meta.dirname,'..');
const deferred=()=>{let resolve,reject;const promise=new Promise((ok,bad)=>{resolve=ok;reject=bad;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

async function sourceModule(relative,ports,transform=source=>source){
  const file=resolve(root,relative),identifier=pathToFileURL(file).href;
  const context=vm.createContext({AbortController,AbortSignal,Buffer,URL,clearTimeout,console,process,setTimeout,structuredClone});
  const module=new vm.SourceTextModule(transform(await readFile(file,'utf8')),{context,identifier,initializeImportMeta(meta){meta.url=identifier;}});
  const linked=new Map();
  await module.link(async specifier=>{
    if(linked.has(specifier))return linked.get(specifier);
    let values=ports[specifier];
    if(values===undefined&&specifier.startsWith('node:'))values=await import(specifier);
    if(values===undefined)throw Error('Unexpected test import: '+specifier);
    const names=Object.keys(values),dependency=new vm.SyntheticModule(names,function(){for(const name of names)this.setExport(name,values[name]);},{context,identifier:'test-port:'+specifier});
    linked.set(specifier,dependency);return dependency;
  });
  await module.evaluate();return module.namespace;
}

function participantPorts(gate){
  const entered=deferred();let revalidations=0,configures=0,closed=0;
  const actors=Array.from({length:4},(_,index)=>({child:{},async send(value){if(value?.type==='configure')configures++;},
    async next(){if(index===0)return {type:'funded',id:1,genesis:'11'.repeat(32),vaultAddress:'test-vault',source:{kind:'coinbase'}};throw Error('Unexpected actor read');}}));
  return {entered,counts:()=>({revalidations,configures,closed}),ports:{
    './participantHarness.mjs':{canonical:JSON.stringify,runCeremony:async()=>({actors,ready:[{groupKey:'22'.repeat(32)}],summary:{rosterDigest:'33'.repeat(32)},
      close:async()=>{closed++;}})},
    './backingClaim.mjs':{captureBackingClaim:()=>{throw Error('Unexpected backing capture');},revalidateBackingClaim:async()=>{revalidations++;entered.resolve();return gate.promise;}},
    './participantAuthority.mjs':{guardParticipantIO:()=>{throw Error('Native configure entered');}},
    './participantDepositFunding.mjs':{fundPreparedDeposit:async()=>{throw Error('Unexpected prepared deposit');}},
  }};
}

async function participantClaimRace(transform){
  const gate=deferred();void gate.promise.catch(()=>{});
  const fixture=participantPorts(gate),source=await sourceModule('consumer/participantSigning.mjs',fixture.ports,transform);
  const vault=await source.openParticipantVault({binary:'unused',sha256:'00'.repeat(32),runtime:tmpdir(),mode:'coinbase'}),claim=Object.freeze({});
  const input={request:'test-request',rosenKeys:[],timestamp:1,backingClaim:claim};
  const first=source.prepareParticipantSigning(vault,input);void first.catch(()=>{});await fixture.entered.promise;
  const second=source.prepareParticipantSigning(vault,input);void second.catch(()=>{});await tick();
  let failure;
  if(fixture.counts().revalidations!==1)failure=Error('race:second-revalidation');
  if(fixture.counts().configures!==0)failure=Error('race:native-configure');
  gate.reject(Error('test-revalidation-refused'));
  const [a,b]=await Promise.allSettled([first,second]);
  try{
    if(failure)throw failure;
    assert.equal(a.status,'rejected');assert.match(String(a.reason),/test-revalidation-refused/);
    assert.equal(b.status,'rejected');assert.match(String(b.reason),/Participant vault unavailable/);
    await assert.rejects(()=>source.prepareParticipantSigning(vault,input),/Participant vault unavailable/);
    assert.deepEqual(fixture.counts(),{revalidations:1,configures:0,closed:0});
  }finally{await vault.close();}
}

function delayedStateClaim(source){
  const pattern=/  state\.used=true;\r?\n  if\(backingClaim!==undefined\)await revalidateBackingClaim\(backingClaim\);/g;
  assert.equal([...source.matchAll(pattern)].length,1,'Participant claim mutant target');
  return source.replace(pattern,'  if(backingClaim!==undefined)await revalidateBackingClaim(backingClaim);\n  state.used=true;');
}

test('participant vault is claimed before asynchronous backing revalidation and stays consumed after refusal',async()=>{
  await participantClaimRace(source=>source);
  await assert.rejects(()=>participantClaimRace(delayedStateClaim),/race:second-revalidation/);
});

const stable=value=>JSON.stringify(value,Object.keys(value).sort());
function committeePorts(state){
  const keys=Array.from({length:4},(_,i)=>`guard-${i}`),configuration=index=>({backingPolicy:'single-deposit-v2',guardKey:keys[index],committeeKeys:keys,
    custodyDomain:'test',quorum:3,maxFaults:1,activationId:'test',policyEpoch:'1',policyDigest:'44'.repeat(32)});
  const actors=keys.map((guardKey,index)=>({closed:false,pid:100+index,ready:{configSha256:`pin-${index}`,index,guardKey,pid:100+index,coordinatorIndex:0,
    configuration:configuration(index)},async request(method){
      if(method!=='assertWithdrawal')throw Error('Unexpected actor request: '+method);
      const call=state.calls[index]++;state.entries++;
      if(index===1&&call===0){state.rejected.resolve();throw Error('guard-1-refused');}
      if(index===2&&call===0){state.blocked.resolve();await state.release.promise;}
      return {status:'assigned',requestDigest:'55'.repeat(32)};
    },async close(){this.closed=true;}}));
  let launch=0;
  return {keys,ports:{
    '../tools/process-rpc.mjs':{launchProcessRpc:async()=>actors[launch++]},
    '../tools/participant-config.mjs':{pinParticipantConfig:file=>{const index=Number(file.at(-1));return {file,sha256:`pin-${index}`,verify(){}};}},
    '../guard-service/src/db/moneroCreditAssignment.mjs':{committeeConfigDigest:config=>stable({...config,guardKey:undefined}),canonicalAssignment:stable},
  }};
}

async function settlementQueueRace(transform){
  const state={calls:[0,0,0,0],entries:0,rejected:deferred(),blocked:deferred(),release:deferred()};
  const fixture=committeePorts(state),source=await sourceModule('ergo-node/guard-process-committee.mjs',fixture.ports,transform);
  const files=[0,1,2,3].map(i=>resolve(root,`test-participant-${i}`));
  const committee=await source.createGuardProcessCommittee({configFiles:files,guardKeys:fixture.keys}),custody=source.captureGuardProcessCustody(committee);
  const first=custody.assertSettlement({test:'request'},{test:'anchor'},{test:'context'});void first.catch(()=>{});
  await Promise.all([state.rejected.promise,state.blocked.promise]);
  const second=custody.assertSettlement({test:'request'},{test:'anchor'},{test:'context'});void second.catch(()=>{});await tick();
  let failure;if(state.entries!==4)failure=Error('queue:released-before-siblings');
  state.release.resolve();
  const a=await Promise.allSettled([first]);
  let secondResult;try{secondResult=await second;}catch(error){if(!failure)failure=error;}
  try{
    if(failure)throw failure;
    assert.equal(a[0].status,'rejected');assert.match(String(a[0].reason),/guard-1-refused/);
    assert.equal(secondResult.requestDigest,'55'.repeat(32));
    assert.equal(state.entries,8);assert.deepEqual(state.calls,[2,2,2,2]);
  }finally{await committee.close();}
}

function failFastSettlement(source){
  const needle="const rows=await Promise.allSettled(actors.map(actor=>actor.request('assertWithdrawal',{request,anchor,context,fresh},{timeoutMs})))";
  assert.equal(source.split(needle).length,2,'Settlement queue mutant target');
  return source.replace(needle,"const rows=await Promise.all(actors.map(actor=>actor.request('assertWithdrawal',{request,anchor,context,fresh},{timeoutMs})))");
}

test('failed settlement waits for every sibling before the serialized custody retry enters',async()=>{
  await settlementQueueRace(source=>source);
  await assert.rejects(()=>settlementQueueRace(failFastSettlement),/queue:released-before-siblings/);
});
