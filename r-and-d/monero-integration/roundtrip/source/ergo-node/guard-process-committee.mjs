import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {launchProcessRpc} from '../tools/process-rpc.mjs';
import {pinParticipantConfig} from '../tools/participant-config.mjs';
import {committeeConfigDigest,canonicalAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';

const entry=fileURLToPath(new URL('./guard-participant.mjs',import.meta.url));
const custodyHandles=new WeakMap();
export function captureGuardProcessCustody(handle){const custody=custodyHandles.get(handle);
  if(!custody)throw Error('backing:process-committee-unissued');custody.current();return custody;}
/** Local message relay. Original authenticated multisig envelopes remain opaque. */
export async function createGuardProcessCommittee({configFiles,guardKeys,timeoutMs=120000,onEvent=()=>{}}){
  assert(Array.isArray(configFiles)&&configFiles.length===4&&new Set(configFiles).size===4&&configFiles.every(path.isAbsolute));
  assert(Array.isArray(guardKeys)&&guardKeys.length===4&&new Set(guardKeys).size===4);
  configFiles=[...configFiles];guardKeys=[...guardKeys];
  const pins=configFiles.map(pinParticipantConfig),identities=new Array(4);
  const actors=new Array(4),counts={starts:[0,0,0,0],messagesSubmitted:0,messagesDelivered:0,
    guardCommitments:[0,0,0,0],guardPartialSigns:[0,0,0,0],completedGuards:0};
  let closed=false,run,draining=false,auditing=false;const pending=[];
  function fail(error){if(run&&!run.failed){run.failed=true;run.reject(error);}}
  async function drain(){
    if(draining||!run?.started||run.failed)return;draining=true;
    try{while(pending.length&&run&&!run.failed){const packet=pending.shift();
      if(packet.session!==run.session)continue;
      for(const target of packet.targets){
        if(run.drop.has(target))continue;
        if(run.delayMs)await new Promise(resolve=>setTimeout(resolve,run.delayMs));
        await actors[target].request('message',{session:packet.session,sender:packet.index,message:packet.message},{timeoutMs});counts.messagesDelivered++;
        if(run.duplicate){await actors[target].request('message',{session:packet.session,sender:packet.index,message:packet.message},{timeoutMs});counts.messagesDelivered++;}
      }
    }}catch(error){fail(error);}finally{draining=false;if(pending.length&&run&&!run.failed)void drain();}
  }
  function event(index,type,payload){
    assert(payload&&payload.index===index,'Actor identity changed');
    if(type==='contribution'){
      assert(payload.session===run?.session,'Stale contribution');
      counts.guardCommitments[index]=payload.counts.commitments;counts.guardPartialSigns[index]=payload.counts.partialSigns;
    }
    if(type==='queued'){
      assert(payload.session===run?.session&&payload.txId===run.snapshot.txId,'Unbound queued event');run.queued.add(index);
      if(run.queued.size===run.indices.length&&!run.started){run.started=true;
        run.timer=setTimeout(()=>fail(Error('Process committee transport timeout; claims retained')),run.completionTimeoutMs);
        Promise.all(run.indices.map(i=>actors[i].request('turn',{session:run.session},{timeoutMs}))).then(()=>drain(),fail);}
    }
    if(type==='packet'){
      assert(payload.session===run?.session&&typeof payload.message==='string'&&payload.message.length<=2000000);
      assert(Array.isArray(payload.recipients)&&pending.length<1000,'Relay bounds');
      const ids=guardKeys.map((_,i)=>'process-credit-guard-'+i);
      const targets=payload.recipients.length?payload.recipients.map(id=>{const i=ids.indexOf(id);assert(run.indices.includes(i)&&i!==index,'Unknown relay peer');return i;}):run.indices.filter(i=>i!==index);
      counts.messagesSubmitted++;pending.push({...payload,targets});void drain();
    }
    onEvent(type,{...payload,index});
  }
  async function start(index){
    pins[index].verify();
    const actor=await launchProcessRpc({entry,env:{PARTICIPANT_CONFIG:pins[index].file,PARTICIPANT_CONFIG_SHA256:pins[index].sha256},execArgv:['--experimental-vm-modules'],timeoutMs,
      onEvent:(type,payload)=>{try{event(index,type,payload);}catch(error){fail(error);throw error;}}});
    actors[index]=actor;
    try{pins[index].verify();assert.equal(actor.ready.configSha256,pins[index].sha256);assert.equal(actor.ready.index,index);assert.equal(actor.ready.guardKey,guardKeys[index]);assert.equal(actor.ready.pid,actor.pid);
      const {pid,coordinatorIndex,...identity}=actor.ready;
      if(identities[index])assert.deepEqual(identity,identities[index],'Guard retained identity drift');else identities[index]=structuredClone(identity);}
    catch(error){await actor.close();throw error;}
    counts.starts[index]++;return actor;
  }
  try{const started=await Promise.allSettled([0,1,2,3].map(start));const failure=started.find(r=>r.status==='rejected');if(failure)throw failure.reason;
    assert.equal(new Set(actors.map(a=>a.pid)).size,4);}
  catch(error){await Promise.allSettled(actors.filter(Boolean).map(a=>a.close()));throw error;}
  const handle={
    async sign(snapshot,{indices=[0,1,2,3],pausePartials=false,delayMs=0,duplicate=false,drop=[],completionTimeoutMs=60000}={}){
      assert(!closed&&!run&&!auditing,'Committee unavailable');assert(Array.isArray(indices)&&indices.length>=3&&indices.length<=4&&new Set(indices).size===indices.length);
      assert(indices.every(i=>Number.isInteger(i)&&i>=0&&i<4&&!actors[i].closed));
      assert(Number.isSafeInteger(delayMs)&&delayMs>=0&&delayMs<=1000);assert.equal(typeof duplicate,'boolean');
      assert(Array.isArray(drop)&&drop.every(i=>indices.includes(i)));
      assert(Number.isSafeInteger(completionTimeoutMs)&&completionTimeoutMs>=250&&completionTimeoutMs<=60000);
      const session=randomUUID();let reject;const failed=new Promise((_,r)=>{reject=r;});
      run={session,snapshot:structuredClone(snapshot),indices:[...indices],queued:new Set(),started:false,failed:false,reject,
        delayMs,duplicate,drop:new Set(drop),completionTimeoutMs,timer:undefined};
      try{
        const jobs=indices.map(i=>actors[i].request('sign',{session,snapshot:run.snapshot,indices:run.indices,pausePartials},{timeoutMs}));
        const results=await Promise.race([Promise.all(jobs),failed]);
        assert.equal(new Set(results.map(r=>r.signedHex)).size,1,'Signed bytes disagree');assert(results.every(r=>r.txId===snapshot.txId));
        counts.completedGuards=results.length;
        for(let j=0;j<indices.length;j++){const i=indices[j];counts.guardCommitments[i]=results[j].stats.counts.commitments;counts.guardPartialSigns[i]=results[j].stats.counts.partialSigns;}
        return results[0];
      }catch(error){run.failed=true;await Promise.allSettled(actors.filter(Boolean).map(a=>a.close()));throw error;}
      finally{clearTimeout(run?.timer);pending.length=0;run=undefined;}
    },
    configurations:()=>actors.map(a=>structuredClone(a.ready.configuration)),
    async stats(indices=[0,1,2,3]){return Promise.all(indices.map(i=>actors[i].request('stats',null,{timeoutMs})));},
    async observeAssignment(request){return Promise.all(actors.map(a=>a.request('observe',request,{timeoutMs})));},
    async assertAssigned(request){return Promise.all(actors.map(a=>a.request('assertAssigned',request,{timeoutMs})));},
    async verifyFresh(snapshot){return Promise.all(actors.map(a=>a.request('verify',snapshot,{timeoutMs})));},
    async auditBacking(snapshot,assignment){assert(!closed&&!run&&!auditing,'Committee unavailable');auditing=true;
      try{const results=await Promise.allSettled(actors.map(a=>a.request('audit',{snapshot,assignment},{timeoutMs})));
        const failure=results.find(row=>row.status==='rejected');if(failure)throw failure.reason;
        return results.map(row=>row.value);}finally{auditing=false;}},
    async invalidate(obligationId,reason){return Promise.all(actors.map(a=>a.request('invalidate',{obligationId,reason},{timeoutMs})));},
    async resume(index,checkpoint){return actors[index].request('resume',{checkpoint},{timeoutMs});},
    async kill(index){assert(Number.isInteger(index)&&index>=0&&index<4);await actors[index].kill();},
    async restart(index){assert(!run,'Finish the signing attempt before restarting');await actors[index].close();return start(index);},
    async restartAll(){assert(!run,'Finish the signing attempt before restarting');await Promise.allSettled(actors.map(a=>a.close()));
      counts.guardCommitments.fill(0);counts.guardPartialSigns.fill(0);counts.completedGuards=0;
      const results=await Promise.allSettled([0,1,2,3].map(start));const failure=results.find(r=>r.status==='rejected');
      if(failure){await Promise.allSettled(actors.map(a=>a.close()));throw failure.reason;}return results.map(r=>r.value);},
    get pids(){return actors.map(a=>a?.pid);},get counts(){return structuredClone(counts);},
    async close(){closed=true;fail(Error('Process committee closed'));await Promise.allSettled(actors.filter(Boolean).map(a=>a.close()));}
  };
  const current=()=>{assert(!closed&&actors.every(a=>a&&!a.closed),'backing:process-committee-unavailable');};
  const configs=handle.configurations(),committeeDigest=committeeConfigDigest(configs[0]);
  assert(configs.every(c=>c.backingPolicy==='single-deposit-v2'&&committeeConfigDigest(c)===committeeDigest));
  const matching=rows=>{assert.equal(new Set(rows.map(({status,...row})=>canonicalAssignment(row))).size,1,'Guard custody disagreement');return rows[0];};
  let custodyQueue=Promise.resolve();
  const serialized=action=>{const result=custodyQueue.then(action);custodyQueue=result.catch(()=>{});return result;};
  custodyHandles.set(handle,Object.freeze({current,backingPolicy:'single-deposit-v2',committeeDigest,
    async assertAssigned(request){current();const rows=await handle.assertAssigned(request);current();return matching(rows);},
    reserveSettlement(request,anchor,context){return serialized(async()=>{current();assert(!run&&!auditing,'Committee unavailable');auditing=true;
      try{const rows=[];for(const actor of actors)rows.push(await actor.request('reserveWithdrawal',{request,anchor,context},{timeoutMs}));
        current();return matching(rows);}finally{auditing=false;}});},
    assertSettlement(request,anchor,context,{fresh=false}={}){return serialized(async()=>{current();assert(!run&&!auditing,'Committee unavailable');auditing=true;
      try{const rows=await Promise.allSettled(actors.map(actor=>actor.request('assertWithdrawal',{request,anchor,context,fresh},{timeoutMs})));
        const failed=rows.find(row=>row.status==='rejected');if(failed)throw failed.reason;
        current();return matching(rows.map(row=>row.value));}finally{auditing=false;}});}
  }));return Object.freeze(handle);
}
