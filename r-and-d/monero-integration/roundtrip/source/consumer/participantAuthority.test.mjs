import test from 'node:test';
import assert from 'node:assert/strict';
import {guardParticipantIO} from './participantAuthority.mjs';

test('authority invalidation during the first approval prevents the next approval',async()=>{
  let active=true;const sent=[];
  const actors=guardParticipantIO([1,2].map(id=>({async send(){sent.push(id);active=false;},async next(){}})),()=>{if(!active)throw Error('invalidated');});
  await assert.rejects(async()=>{for(const actor of actors)await actor.send({type:'approve'});},/invalidated/);
  assert.deepEqual(sent,[1]);
});
test('invalidation while a share is pending prevents its relay or final delivery',async()=>{
  let active=true,release;const sent=[];
  const actors=guardParticipantIO([1,2].map(id=>({async send(value){sent.push([id,value]);},next(){return new Promise(resolve=>{release=resolve;});}})),()=>{if(!active)throw Error('invalidated');});
  const pending=(async()=>{const share=await actors[0].next();await actors[1].send(share);return 'delivered';})();
  active=false;release({type:'sign-peer',round:8});
  await assert.rejects(pending,/invalidated/);assert.deepEqual(sent,[]);
});
test('valid authority preserves participant responses and checks both sides of I/O',async()=>{
  let checks=0;const child={},original={child,async send(value){return value;},async next(){return 'frame';}};
  const [actor]=guardParticipantIO([original],()=>{checks++;});
  assert.equal(actor.child,child);assert.equal(await actor.send('approval'),'approval');assert.equal(await actor.next(),'frame');assert.equal(checks,4);
});
