import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {launchProcessRpc} from './process-rpc.mjs';

const worker=fileURLToPath(new URL('./fixtures/processRpcWorker.mjs',import.meta.url));
const live=new Set();

async function launch(t,options={}){
  const client=await launchProcessRpc({entry:worker,timeoutMs:1_500,...options});
  live.add(client);
  t.after(async()=>{live.delete(client);await client.close().catch(()=>{});});
  return client;
}

async function rawWorker(t,env={}){
  const child=fork(worker,[],{env:{...process.env,PROCESS_RPC_MAX_BYTES:'1024',...env},windowsHide:true,shell:false,stdio:['ignore','pipe','pipe','ipc']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});
  const [ready]=await once(child,'message');
  assert.deepEqual(Object.keys(ready).sort(),['ready','type']);
  return child;
}

function nextMessage(child,send){
  const received=once(child,'message');
  child.send(send);
  return received.then(([message])=>message);
}

test('uses a real child PID, preserves readiness, and cleans up gracefully',async t=>{
  const client=await launch(t,{env:{PROCESS_RPC_WORKER_MODE:'normal'}});
  assert.equal(Number.isSafeInteger(client.pid),true);
  assert.equal(client.ready.pid,client.pid);
  assert.deepEqual(await client.request('echo',{value:'ok'}),{value:'ok'});
  await client.close();
  assert.equal(client.closed,true);
  await assert.rejects(client.request('echo',{}),/closed/);
});

test('permits interleaved concurrent requests and child events',async t=>{
  const events=[],client=await launch(t,{onEvent:(event,payload)=>events.push({event,payload})});
  const signing=client.request('sign',{message:'payload'});
  const released=client.request('release',{});
  assert.deepEqual(await released,{released:true});
  assert.deepEqual(await signing,{signature:'signed:payload'});
  const pair=await Promise.all([client.request('delay',{value:'slow',ms:40}),client.request('delay',{value:'fast',ms:1})]);
  assert.deepEqual(pair,[{value:'slow'},{value:'fast'}]);
  await client.request('event',{kind:'progress'});
  assert.deepEqual(events,[{event:'sign-waiting',payload:{message:'payload'}},{event:'worker-event',payload:{kind:'progress'}}]);
});

test('rejects unknown methods without exposing child error details',async t=>{
  const client=await launch(t);
  await assert.rejects(client.request('missing',{secret:'must-not-leak'}),error=>{
    assert.match(error.message,/Unknown RPC method/);
    assert.doesNotMatch(error.message,/secret|stack|must-not-leak/i);
    return true;
  });
});

test('sanitizes handler failures without returning input or stack data',async t=>{
  const client=await launch(t);
  await assert.rejects(client.request('fail',{secret:'must-not-leak'}),error=>{
    assert.equal(error.message,'handler failed');
    assert.doesNotMatch(error.message,/must-not-leak/);
    return true;
  });
});

test('truncates sanitized multibyte handler errors by UTF-8 byte length',async t=>{
  const client=await launch(t);
  await assert.rejects(client.request('multibyte',{}),error=>{
    assert.equal(error.message,'x'+'€'.repeat(85));
    assert.equal(Buffer.byteLength(error.message,'utf8'),256);
    assert.doesNotMatch(error.message,/�/);
    return true;
  });
});

test('unexpected child exit rejects outstanding work and closes the client',async t=>{
  const client=await launch(t);
  const pending=client.request('exit',{});
  await assert.rejects(pending,/exited|closed|unavailable/i);
  assert.equal(client.closed,true);
  await assert.rejects(client.request('echo',{}),/closed/);
});

test('a request deadline is terminal and no late calls remain alive',async t=>{
  const client=await launch(t);
  const pending=client.request('delay',{value:'late',ms:500},{timeoutMs:25});
  await assert.rejects(pending,/deadline/i);
  assert.equal(client.closed,true);
  await assert.rejects(client.request('echo',{}),/closed/);
});

test('rejects invalid child frames during readiness and owns cleanup',async t=>{
  await assert.rejects(launchProcessRpc({entry:worker,env:{PROCESS_RPC_WORKER_MODE:'invalid-ready'},timeoutMs:500}),/protocol/i);
});

test('keeps bounded startup stderr diagnostics private on the launch error',async()=>{
  await assert.rejects(launchProcessRpc({entry:worker,env:{PROCESS_RPC_WORKER_MODE:'startup-stderr-exit'},timeoutMs:500}),error=>{
    assert.match(error.message,/exited|unavailable/i);
    assert.equal(typeof error.diagnostic?.stdout,'string');
    assert.match(error.diagnostic.stderr,/process-rpc fixture startup failure/);
    assert.equal(Buffer.byteLength(error.diagnostic.stderr,'utf8')<=8*1024,true);
    return true;
  });
});

test('enforces inbound result and outbound request resource bounds',async t=>{
  const large=await launch(t,{env:{PROCESS_RPC_WORKER_MODE:'normal'},maxBytes:1_024});
  await assert.rejects(large.request('large',{bytes:2_048}),/exited|closed|limit/i);
  assert.equal(large.closed,true);
  const bounded=await launch(t,{maxBytes:1_024});
  await assert.rejects(bounded.request('echo',{value:'x'.repeat(2_048)}),/limit/i);
  assert.equal(bounded.closed,false);
});

test('enforces the 64 request in-flight bound',async t=>{
  const client=await launch(t);
  const pending=Array.from({length:64},(_,index)=>client.request('delay',{value:index,ms:100}));
  await assert.rejects(client.request('echo',{}),/in-flight limit/);
  await Promise.all(pending);
});

test('server rejects duplicate identifiers and malformed request envelopes',async t=>{
  const duplicate=await rawWorker(t);
  const first=await nextMessage(duplicate,{type:'request',id:1,method:'echo',params:{value:'first'}});
  assert.deepEqual(first,{type:'response',id:1,ok:true,result:{value:'first'}});
  const duplicateReply=await nextMessage(duplicate,{type:'request',id:1,method:'echo',params:{value:'second'}});
  assert.deepEqual(duplicateReply,{type:'response',id:1,ok:false,error:{message:'Duplicate RPC identifier'}});
  duplicate.send({type:'close'});
  await once(duplicate,'exit');

  const malformed=await rawWorker(t);
  malformed.send({type:'request',id:2,method:'echo',params:{},extra:true});
  const [code]=await once(malformed,'exit');
  assert.equal(code,1);
});

test('server exits boundedly when its launcher disconnects unexpectedly',async t=>{
  const child=await rawWorker(t,{PROCESS_RPC_WORKER_MODE:'disconnect-hanging-close'});
  const exit=once(child,'exit');
  child.disconnect();
  const [code,signal]=await Promise.race([
    exit,
    new Promise((_,reject)=>setTimeout(()=>reject(Error('disconnect shutdown deadline')),2_000)),
  ]);
  assert.equal(code,1);
  assert.equal(signal,null);
});

test.after(async()=>{
  await Promise.allSettled([...live].map(client=>client.close()));
});
