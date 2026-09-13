import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runCeremony} from './participantHarness.mjs';
const pin={binary:process.env.PARTICIPANT_BIN,sha256:process.env.PARTICIPANT_SHA256};

test('four processes generate and retain matching threshold shares through authenticated DKG',async()=>{
  const ceremony=await runCeremony({...pin,keepAlive:true});
  try{
    assert.equal(ceremony.summary.distinctProcesses,4);assert.equal(ceremony.summary.threshold,2);
    assert.deepEqual(ceremony.summary.rounds,[1,2,3,4].map(round=>({round,sent:12})));
    assert.equal(ceremony.actors.filter(a=>!a.closed).length,4);
    assert.equal(ceremony.ready.every(v=>v.verificationShares.length===4),true);
    assert.equal(ceremony.actors.every(a=>a.readySeen===1),true);
    console.log(JSON.stringify({test:'process-dkg',...ceremony.summary}));
  }finally{await ceremony.close();}
});
for(const fault of ['sender','recipient','ceremony','round','replay','duplicate-completion','interrupt']){
  test(`refuses ${fault} without completing the four-participant ceremony`,async()=>{
    await assert.rejects(runCeremony({...pin,fault}));
    console.log(JSON.stringify({test:'process-dkg-refusal',fault,accepted:false}));
  });
}
