import fs from 'node:fs';
import assert from 'node:assert/strict';
import {serveProcessRpc,emitProcessEvent} from '../tools/process-rpc.mjs';
import {readParticipantConfig} from '../tools/participant-config.mjs';

const configFile=process.env.PARTICIPANT_CONFIG;
assert(configFile,'PARTICIPANT_CONFIG is required');
const {selected:config,sha256:configSha256}=readParticipantConfig();
assert.equal(config.version,1);assert(Number.isInteger(config.index));assert(config.roundtripConfig);assert(config.watcher?.secretKey);assert(config.databasePath);
const returnMode=Object.hasOwn(config,'returnTerms');
assert(returnMode?!Object.hasOwn(config,'source')&&!Object.hasOwn(config,'creditEntries')
  :!!config.source&&Array.isArray(config.creditEntries),'Watcher participant source mode');
process.env.ROUNDTRIP_CONFIG=config.roundtripConfig;
await import('./deposit-register.mjs');
const [{createWatcherParticipant},{openProcessSource},{rpc,confirmed},{stateContext}]=await Promise.all([
  import('./watcher-runtime.mjs'),import('./process-source.mjs'),import('./rosen-node.mjs'),import('./authority-fixture.mjs')
]);
const source=returnMode?undefined:await openProcessSource(config.source),gates=new Map();let sourceReads=0,sourcePort;
if(returnMode){const {observeRedemption,validateReturnTerms}=await import('./authority-return.mjs');validateReturnTerms(config.returnTerms);
  sourcePort={observeReturn:async raw=>{sourceReads++;return observeRedemption({receipt:raw,deployment:config.deployment,terms:config.returnTerms});}};
}else sourcePort={inspect:(candidate,signal)=>{sourceReads++;return source.inspect(candidate,signal);},creditEntries:config.creditEntries};
async function pause(checkpoint){
  emitProcessEvent('checkpoint',{index:config.index,checkpoint});
  if(config.fault?.pauseAt===checkpoint)await new Promise(resolve=>gates.set(checkpoint,resolve));
}
const actor=await createWatcherParticipant({databasePath:config.databasePath,deployment:config.deployment,watcher:config.watcher,nodePort:{rpc,confirmed,getStateContext:stateContext},dependencyRoot:config.dependencyRoot,...sourcePort,pause});
await serveProcessRpc({
  handlers:{
    recover(candidate){return actor.recover(candidate);},
    async observe(candidate){const observation=await actor.observe(candidate);emitProcessEvent('observation',{index:config.index,requestId:observation.requestId});return observation;},
    async commitment(candidate){const result=await actor.commitment(candidate);emitProcessEvent('commitment',{index:config.index,requestId:result.observation.requestId,boxId:result.commitment.boxId});return result;},
    async reveal({requestId,commitments}){const receipt=await actor.reveal(requestId,commitments);emitProcessEvent('reveal',{index:config.index,requestId,txId:receipt.transaction.id});return receipt;},
    receipt({requestId,value}){return actor.receipt(requestId,value);},
    resume({checkpoint}){const gate=gates.get(checkpoint);assert(gate,'No paused checkpoint '+checkpoint);gates.delete(checkpoint);gate();return {resumed:checkpoint};},
    stats(){return {index:config.index,proofCalls:source?.proofCalls??0,sourceReads};}
  },
  ready:{index:config.index,pid:process.pid,WID:config.watcher.WID,address:config.watcher.address,configSha256,databasePath:fs.realpathSync(config.databasePath)},
  async close(){actor.close();source?.close();for(const gate of gates.values())gate();gates.clear();}
});
