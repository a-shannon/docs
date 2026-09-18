import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchProcessRpc} from '../tools/process-rpc.mjs';
import {pinParticipantConfig} from '../tools/participant-config.mjs';

const entry=path.join(path.dirname(fileURLToPath(import.meta.url)),'watcher-participant.mjs');
// Settle sibling jobs before a retry can access the same persistent queue.
async function settledAll(jobs){const rows=await Promise.allSettled(jobs);const failure=rows.find(r=>r.status==='rejected');if(failure)throw failure.reason;return rows.map(r=>r.value);}
export async function createWatcherProcessTransport({configFiles,directory,timeoutMs=120000,onEvent=()=>{}}){
  assert.equal(configFiles.length,2);assert.equal(new Set(configFiles).size,2);assert(configFiles.every(path.isAbsolute));assert(path.isAbsolute(directory));
  configFiles=[...configFiles];const pins=configFiles.map(pinParticipantConfig),identities=new Array(2);
  const actors=new Array(2),commitmentIds=new Set(),revealIds=new Set();let logicalRequests=0;
  async function start(index){pins[index].verify();const actor=await launchProcessRpc({entry,env:{PARTICIPANT_CONFIG:pins[index].file,PARTICIPANT_CONFIG_SHA256:pins[index].sha256},execArgv:['--experimental-vm-modules'],timeoutMs,onEvent:(event,payload)=>{assert.equal(payload?.index,index,'Watcher event identity');onEvent(event,{...payload,index});}});actors[index]=actor;
    try{pins[index].verify();const ready=actor.ready;assert.equal(ready.configSha256,pins[index].sha256);assert.equal(ready.index,index,'Watcher actor ordering mismatch');assert.match(ready.WID,/^[0-9a-f]{64}$/);assert(ready.address,'Watcher actor public identity missing');assert.equal(ready.pid,actor.pid);assert(!actors.some((value,i)=>i!==index&&value?.pid===actor.pid),'Watcher actors must have unique PIDs');
      const {pid,...identity}=ready;if(identities[index])assert.deepEqual(identity,identities[index],'Watcher retained identity drift');else identities[index]=structuredClone(identity);return actor;}
    catch(error){await actor.close();throw error;}}
  try{const started=await Promise.allSettled([start(0),start(1)]);const failure=started.find(r=>r.status==='rejected');if(failure)throw failure.reason;}catch(error){await Promise.allSettled(actors.map(actor=>actor?.close()));throw error;}
  async function publish(candidate){
    logicalRequests++;
    const recovered=await settledAll(actors.map(actor=>actor.request('recover',candidate,{timeoutMs})));
    if(recovered.every(Boolean)){
      assert.deepEqual(recovered[0].receipt,recovered[1].receipt,'Recovered watcher receipts disagree');
      return {...recovered[0].receipt,watcherObservations:recovered.map(r=>r.receipt.observation),commitmentTransactions:recovered.map(r=>r.commitmentTransaction)};
    }
    const observations=await settledAll(actors.map(actor=>actor.request('observe',candidate,{timeoutMs})));assert.deepEqual(observations[0],observations[1],'Independent watcher observations disagree');
    const results=await settledAll(actors.map(actor=>actor.request('commitment',candidate,{timeoutMs})));assert.deepEqual(results.map(value=>value.observation),observations,'Watcher admission changed before commitment');
    const commitments=results.map(result=>result.commitment);assert.equal(new Set(commitments.map(value=>value.WID)).size,2,'Distinct watcher identities required');for(const result of results)commitmentIds.add(result.transaction.id);
    const receipt=await actors[0].request('reveal',{requestId:observations[0].requestId,commitments},{timeoutMs});revealIds.add(receipt.transaction.id);
    await settledAll(actors.map(actor=>actor.request('receipt',{requestId:observations[0].requestId,value:receipt},{timeoutMs})));
    return {...receipt,watcherObservations:observations,commitmentTransactions:results.map(result=>result.transaction)};
  }
  return {publish,observe:candidate=>settledAll(actors.map(actor=>actor.request('observe',candidate,{timeoutMs}))),async close(){await Promise.all(actors.map(actor=>actor?.close()));},async kill(index){assert(index===0||index===1);await actors[index].kill();},async restart(index){assert(index===0||index===1);await actors[index]?.close();return start(index);},resume:(index,checkpoint)=>actors[index].request('resume',{checkpoint}),stats:()=>Promise.all(actors.map(actor=>actor.request('stats',null))),get pids(){return actors.map(actor=>actor?.pid);},get counts(){return {logicalRequests,uniqueCommitmentTransactions:commitmentIds.size,uniqueRevealTransactions:revealIds.size};}};
}
