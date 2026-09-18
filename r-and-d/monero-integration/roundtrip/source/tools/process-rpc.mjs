import {fork} from 'node:child_process';

const DEFAULT_TIMEOUT_MS=30_000;
const MAX_TIMEOUT_MS=180_000;
const DEFAULT_MAX_BYTES=8*1024*1024;
const MAX_MAX_BYTES=DEFAULT_MAX_BYTES;
const MAX_IN_FLIGHT=64;
const MAX_METHOD_BYTES=128;
const MAX_ERROR_BYTES=256;
const DIAGNOSTIC_TAIL_BYTES=8*1024;
const PARENT_DISCONNECT_SHUTDOWN_MS=1_000;

function errorMessage(error,fallback='RPC failed'){
  const value=typeof error?.message==='string'?error.message:fallback;
  const normalized=value.replace(/[\r\n\t]/g,' ');
  if(Buffer.byteLength(normalized,'utf8')<=MAX_ERROR_BYTES)return normalized||fallback;
  let result='',bytes=0;
  for(const character of normalized){
    const characterBytes=Buffer.byteLength(character,'utf8');
    if(bytes+characterBytes>MAX_ERROR_BYTES)break;
    result+=character;bytes+=characterBytes;
  }
  return result||fallback;
}

function appendTail(existing,chunk,limit){
  const bytes=Buffer.from(chunk);
  if(bytes.length>=limit)return Buffer.from(bytes.subarray(bytes.length-limit));
  const combined=Buffer.concat([existing,bytes]);
  return combined.length>limit?combined.subarray(combined.length-limit):combined;
}

function isPlainObject(value){
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function isJsonValue(value,depth=0){
  if(depth>64)return false;
  if(value===null||typeof value==='string'||typeof value==='boolean')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(Array.isArray(value))return value.every(item=>isJsonValue(item,depth+1));
  if(!isPlainObject(value))return false;
  return Object.keys(value).every(key=>isJsonValue(value[key],depth+1));
}

function jsonBytes(value){
  if(!isJsonValue(value))throw Error('RPC JSON value required');
  return Buffer.byteLength(JSON.stringify(value));
}

function exactKeys(value,keys){
  if(!isPlainObject(value))return false;
  const actual=Object.keys(value).sort(),expected=[...keys].sort();
  return actual.length===expected.length&&actual.every((key,index)=>key===expected[index]);
}

function validId(value){return Number.isSafeInteger(value)&&value>0;}
function validTimeout(value,name='RPC timeout'){
  if(!Number.isSafeInteger(value)||value<1||value>MAX_TIMEOUT_MS)throw Error(`${name} bound`);
  return value;
}
function validMaxBytes(value){
  if(!Number.isSafeInteger(value)||value<1_024||value>MAX_MAX_BYTES)throw Error('RPC byte limit bound');
  return value;
}
function validMethod(value){return typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=MAX_METHOD_BYTES;}
function validEvent(value){return validMethod(value);}
function validReady(value){return isPlainObject(value)&&isJsonValue(value);}
function awaitExit(child,timeoutMs){
  return new Promise((resolve,reject)=>{
    if(child.exitCode!==null||child.signalCode!==null){resolve();return;}
    const timer=setTimeout(()=>{cleanup();reject(Error('RPC child cleanup deadline'));},timeoutMs);
    const done=()=>{cleanup();resolve();};
    const cleanup=()=>{clearTimeout(timer);child.removeListener('exit',done);};
    child.once('exit',done);
  });
}

export async function launchProcessRpc({entry,env={},execArgv=[],cwd,timeoutMs=DEFAULT_TIMEOUT_MS,maxBytes=DEFAULT_MAX_BYTES,onEvent}={}){
  if(typeof entry!=='string'||!entry||!entry.match(/^(?:[A-Za-z]:[\\/]|\/)/))throw Error('Absolute RPC entry required');
  if(cwd!==undefined&&(typeof cwd!=='string'||!cwd.match(/^(?:[A-Za-z]:[\\/]|\/)/)))throw Error('Absolute RPC cwd required');
  if(!isPlainObject(env)||Object.values(env).some(value=>typeof value!=='string'))throw Error('RPC environment must contain strings');
  if(!Array.isArray(execArgv)||execArgv.some(value=>typeof value!=='string'))throw Error('RPC execArgv must contain strings');
  if(onEvent!==undefined&&typeof onEvent!=='function')throw Error('RPC event handler required');
  const launchTimeout=validTimeout(timeoutMs),frameLimit=validMaxBytes(maxBytes);
  const child=fork(entry,[],{cwd,env:{...process.env,...env,PROCESS_RPC_MAX_BYTES:String(frameLimit)},execArgv,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe','ipc']});
  let closed=false,exited=false,readySeen=false,terminalError,readyTimer,closePromise,killPromise;
  const pending=new Map();
  let stdoutBytes=0,stderrBytes=0,nextId=1;
  let stdoutTail=Buffer.alloc(0),stderrTail=Buffer.alloc(0);
  const diagnosticLimit=Math.min(DIAGNOSTIC_TAIL_BYTES,frameLimit);
  const diagnostics=()=>({stdout:stdoutTail.toString('utf8'),stderr:stderrTail.toString('utf8')});
  const attachDiagnostics=reason=>{
    const error=reason instanceof Error?reason:Error(String(reason));
    if(error.diagnostic===undefined)Object.defineProperty(error,'diagnostic',{value:diagnostics(),enumerable:true});
    return error;
  };
  let resolveReady,rejectReady;
  const readyPromise=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});

  const rejectPending=reason=>{
    for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(reason);}
    pending.clear();
  };
  const terminate=(reason,shouldKill=true)=>{
    if(terminalError)return;
    terminalError=attachDiagnostics(reason);
    closed=true;
    clearTimeout(readyTimer);
    if(!readySeen)rejectReady(terminalError);
    rejectPending(terminalError);
    if(shouldKill&&!exited)child.kill();
  };
  const send=(message)=>new Promise((resolve,reject)=>{
    try{child.send(message,error=>error?reject(Error('RPC IPC unavailable')):resolve());}catch{reject(Error('RPC IPC unavailable'));}
  });
  const protocolFailure=message=>terminate(Error(`RPC protocol error: ${message}`));
  const checkSize=(message,source)=>{
    try{if(jsonBytes(message)>frameLimit)throw Error();}catch{protocolFailure(`${source} frame limit`);return false;}
    return true;
  };
  const client={
    pid:child.pid,
    get ready(){return readyValue;},
    get closed(){return closed;},
    get diagnostics(){return diagnostics();},
    request(method,params,{timeoutMs:requestTimeout=launchTimeout}={}){
      if(closed)return Promise.reject(Error('RPC client closed'));
      if(!validMethod(method))return Promise.reject(Error('RPC method bound'));
      let deadline;
      try{deadline=validTimeout(requestTimeout,'RPC request timeout');}catch(error){return Promise.reject(error);}
      if(!isJsonValue(params))return Promise.reject(Error('RPC JSON value required'));
      if(pending.size>=MAX_IN_FLIGHT)return Promise.reject(Error('RPC in-flight limit'));
      if(nextId>Number.MAX_SAFE_INTEGER){terminate(Error('RPC identifier exhausted'));return Promise.reject(Error('RPC identifier exhausted'));}
      const id=nextId++,message={type:'request',id,method,params};
      try{if(jsonBytes(message)>frameLimit)return Promise.reject(Error('RPC request byte limit'));}catch(error){return Promise.reject(error);}
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>terminate(Error('RPC request deadline exceeded')),deadline);
        pending.set(id,{resolve,reject,timer});
        send(message).catch(error=>terminate(error));
      });
    },
    async close(){
      if(closePromise)return closePromise;
      closePromise=(async()=>{
        if(exited)return;
        closed=true;
        rejectPending(Error('RPC client closed'));
        try{await send({type:'close'});}catch{}
        try{await awaitExit(child,Math.min(launchTimeout,2_000));return;}catch{}
        if(!exited)child.kill();
        try{await awaitExit(child,2_000);}catch(error){throw attachDiagnostics(error);}
      })();
      return closePromise;
    },
    async kill(){
      if(killPromise)return killPromise;
      killPromise=(async()=>{
        closed=true;
        rejectPending(Error('RPC client killed'));
        if(!exited)child.kill();
        try{await awaitExit(child,2_000);}catch(error){throw attachDiagnostics(error);}
      })();
      return killPromise;
    },
  };
  let readyValue;
  readyTimer=setTimeout(()=>terminate(Error('RPC ready deadline exceeded')),launchTimeout);
  child.stdout.on('data',chunk=>{stdoutTail=appendTail(stdoutTail,chunk,diagnosticLimit);stdoutBytes+=chunk.length;if(stdoutBytes>frameLimit)terminate(Error('RPC child output limit'));});
  child.stderr.on('data',chunk=>{stderrTail=appendTail(stderrTail,chunk,diagnosticLimit);stderrBytes+=chunk.length;if(stderrBytes>frameLimit)terminate(Error('RPC child output limit'));});
  child.on('error',()=>terminate(Error('RPC child unavailable')));
  child.on('exit',(code,signal)=>{
    exited=true;
    if(!terminalError&&!closed)terminate(Error(`RPC child exited; exit=${code}; signal=${signal}`),false);
    else if(!readySeen&&terminalError)rejectReady(terminalError);
  });
  child.on('message',message=>{
    if(exited||terminalError)return;
    if(!checkSize(message,'child'))return;
    if(exactKeys(message,['type','ready'])&&message.type==='ready'){
      if(readySeen||!validReady(message.ready)){protocolFailure('ready envelope');return;}
      readySeen=true;readyValue=message.ready;clearTimeout(readyTimer);resolveReady(client);return;
    }
    if(exactKeys(message,['type','id','ok','result'])&&message.type==='response'&&message.ok===true&&validId(message.id)&&isJsonValue(message.result)){
      const item=pending.get(message.id);if(!item){protocolFailure('unknown response id');return;}
      pending.delete(message.id);clearTimeout(item.timer);item.resolve(message.result);return;
    }
    if(exactKeys(message,['type','id','ok','error'])&&message.type==='response'&&message.ok===false&&validId(message.id)&&isPlainObject(message.error)&&exactKeys(message.error,['message'])&&typeof message.error.message==='string'&&Buffer.byteLength(message.error.message)<=MAX_ERROR_BYTES){
      const item=pending.get(message.id);if(!item){protocolFailure('unknown response id');return;}
      pending.delete(message.id);clearTimeout(item.timer);item.reject(Error(message.error.message));return;
    }
    if(exactKeys(message,['type','event','payload'])&&message.type==='event'&&validEvent(message.event)&&isJsonValue(message.payload)){
      try{
        const delivered=onEvent?.(message.event,message.payload);
        if(delivered&&typeof delivered.then==='function')void Promise.resolve(delivered).catch(()=>protocolFailure('event handler'));
      }catch{protocolFailure('event handler');}
      return;
    }
    protocolFailure('child envelope');
  });
  return readyPromise;
}

let activeServer;

export function emitProcessEvent(event,payload){
  if(!activeServer)throw Error('RPC server unavailable');
  activeServer.emit(event,payload);
}

export function serveProcessRpc({handlers,ready,close}={}){
  if(activeServer)throw Error('RPC server already active');
  if(!isPlainObject(handlers)||Object.values(handlers).some(handler=>typeof handler!=='function'))throw Error('RPC handlers required');
  if(!validReady(ready))throw Error('RPC ready object required');
  if(close!==undefined&&typeof close!=='function')throw Error('RPC close handler required');
  const configured=Number(process.env.PROCESS_RPC_MAX_BYTES??DEFAULT_MAX_BYTES);
  const frameLimit=Number.isSafeInteger(configured)&&configured>=1_024&&configured<=MAX_MAX_BYTES?configured:DEFAULT_MAX_BYTES;
  let closing=false,lastId=0;
  const active=new Set();
  const fatal=()=>{
    if(closing)return;
    closing=true;process.exitCode=1;
    try{process.disconnect?.();}catch{}
    const timer=setTimeout(()=>process.exit(1),20);timer.unref();
  };
  const send=message=>{
    try{if(jsonBytes(message)>frameLimit){fatal();return false;}process.send?.(message);return true;}catch{fatal();return false;}
  };
  const respondError=(id,error)=>send({type:'response',id,ok:false,error:{message:errorMessage(error)}});
  const server={emit(event,payload){
    if(closing||!validEvent(event)||!isJsonValue(payload)||!send({type:'event',event,payload}))throw Error('RPC event rejected');
  }};
  const drainAndClose=async()=>{
    await Promise.allSettled([...active]);
    try{await close?.();}catch{}
    activeServer=undefined;
  };
  activeServer=server;
  if(!send({type:'ready',ready})){activeServer=undefined;return;}
  process.once('disconnect',()=>{
    if(closing)return;
    closing=true;process.exitCode=1;
    // Deliberately referenced: a hung close hook must not keep an orphaned child alive.
    const forcedExit=setTimeout(()=>process.exit(1),PARENT_DISCONNECT_SHUTDOWN_MS);
    void (async()=>{
      await drainAndClose();
      clearTimeout(forcedExit);
      process.exit(1);
    })();
  });
  process.on('message',message=>{
    let size;
    try{size=jsonBytes(message);}catch{fatal();return;}
    if(size>frameLimit){fatal();return;}
    if(exactKeys(message,['type'])&&message.type==='close'){
      if(closing)return;
      closing=true;
      void (async()=>{
        await drainAndClose();
        try{process.disconnect?.();}catch{}
      })();
      return;
    }
    if(!exactKeys(message,['type','id','method','params'])||message.type!=='request'||!validId(message.id)||!validMethod(message.method)||!isJsonValue(message.params)){fatal();return;}
    if(closing){respondError(message.id,Error('RPC server closed'));return;}
    if(message.id<=lastId){respondError(message.id,Error('Duplicate RPC identifier'));return;}
    lastId=message.id;
    if(active.size>=MAX_IN_FLIGHT){respondError(message.id,Error('RPC in-flight limit'));return;}
    const handler=handlers[message.method];
    if(typeof handler!=='function'){respondError(message.id,Error('Unknown RPC method'));return;}
    const task=(async()=>{
      try{
        const result=await handler(message.params);
        if(!isJsonValue(result)||jsonBytes({type:'response',id:message.id,ok:true,result})>frameLimit){fatal();return;}
        if(!closing)send({type:'response',id:message.id,ok:true,result});
      }catch(error){if(!closing)respondError(message.id,error);}
    })();
    active.add(task);task.finally(()=>active.delete(task));
  });
}
