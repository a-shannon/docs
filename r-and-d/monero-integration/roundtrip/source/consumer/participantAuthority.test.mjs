import test from 'node:test';
import assert from 'node:assert/strict';
import {guardParticipantIO} from './participantAuthority.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((ok,bad)=>{resolve=ok;reject=bad;});return {promise,resolve,reject};};
const checkedPromise=make=>{const promise=Promise.resolve().then(make);void promise.catch(()=>{});return promise;};

test('a delayed pre-send refusal prevents native delivery',async()=>{
  const gate=deferred(),entered=deferred();let sends=0;
  void gate.promise.catch(()=>{});
  const [actor]=guardParticipantIO([{child:{},async send(){sends++;}}],()=>{entered.resolve();return gate.promise;});
  const pending=actor.send({type:'approve'});await entered.promise;
  assert.equal(sends,0);gate.reject(Error('invalidated'));
  await assert.rejects(pending,/invalidated/);assert.equal(sends,0);
});
test('an asynchronous post-response refusal prevents response delivery',async()=>{
  const after=deferred(),afterEntered=deferred();let checks=0,nextCalls=0;
  void after.promise.catch(()=>{});
  const [actor]=guardParticipantIO([{child:{},async next(){nextCalls++;return 'frame';}}],()=>{
    checks++;if(checks===1)return Promise.resolve();afterEntered.resolve();return after.promise;
  });
  const pending=actor.next();await afterEntered.promise;after.reject(Error('invalidated'));
  await assert.rejects(pending,/invalidated/);assert.equal(nextCalls,1);
});
test('authority invalidation during the first approval prevents the next approval',async()=>{
  let active=true;const sent=[];
  const actors=guardParticipantIO([1,2].map(id=>({async send(){sent.push(id);active=false;},async next(){}})),
    ()=>checkedPromise(()=>{if(!active)throw Error('invalidated');}));
  await assert.rejects(async()=>{for(const actor of actors)await actor.send({type:'approve'});},/invalidated/);
  assert.deepEqual(sent,[1]);
});
test('invalidation while a share is pending prevents its relay or final delivery',async()=>{
  let active=true,release;const entered=deferred(),sent=[];
  const actors=guardParticipantIO([1,2].map(id=>({async send(value){sent.push([id,value]);},next(){entered.resolve();return new Promise(resolve=>{release=resolve;});}})),
    ()=>checkedPromise(()=>{if(!active)throw Error('invalidated');}));
  const pending=(async()=>{const share=await actors[0].next();await actors[1].send(share);return 'delivered';})();
  await entered.promise;active=false;release({type:'sign-peer',round:8});
  await assert.rejects(pending,/invalidated/);assert.deepEqual(sent,[]);
});
test('valid authority preserves participant responses and checks both sides of I/O',async()=>{
  let checks=0;const child={},original={child,async send(value){return value;},async next(){return 'frame';}};
  const [actor]=guardParticipantIO([original],async()=>{await Promise.resolve();checks++;});
  assert.equal(actor.child,child);assert.equal(await actor.send('approval'),'approval');assert.equal(await actor.next(),'frame');assert.equal(checks,4);
});
