import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function pinParticipantConfig(file){
  const resolved=fs.realpathSync(file),sha256=digest(fs.readFileSync(resolved));
  const verify=()=>{assert.equal(fs.realpathSync(file),resolved,'Participant configuration path drift');
    assert.equal(digest(fs.readFileSync(resolved)),sha256,'Participant configuration bytes drift');};
  return Object.freeze({file:resolved,sha256,verify});
}
export function readParticipantConfig(){
  const bytes=fs.readFileSync(process.env.PARTICIPANT_CONFIG),sha256=digest(bytes);
  assert.match(process.env.PARTICIPANT_CONFIG_SHA256??'',/^[0-9a-f]{64}$/);
  assert.equal(sha256,process.env.PARTICIPANT_CONFIG_SHA256,'Participant configuration digest mismatch');
  return {selected:JSON.parse(bytes.toString('utf8')),sha256};
}
