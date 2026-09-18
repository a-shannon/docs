import {emitProcessEvent,serveProcessRpc} from '../process-rpc.mjs';

if(process.env.PROCESS_RPC_WORKER_MODE==='invalid-ready'){
  process.send?.({type:'ready',ready:{pid:process.pid},extra:true});
}else if(process.env.PROCESS_RPC_WORKER_MODE==='startup-stderr-exit'){
  process.stderr.write('process-rpc fixture startup failure\n');
  setTimeout(()=>process.exit(9),20);
}else{
  let releaseSigning;
  serveProcessRpc({
    ready:{pid:process.pid,fixture:true},
    close:process.env.PROCESS_RPC_WORKER_MODE==='disconnect-hanging-close'?async()=>new Promise(()=>{}):undefined,
    handlers:{
      echo:async params=>params,
      delay:async ({value,ms})=>{
        await new Promise(resolve=>setTimeout(resolve,ms));
        return {value};
      },
      sign:async ({message})=>{
        emitProcessEvent('sign-waiting',{message});
        await new Promise(resolve=>{releaseSigning=resolve;});
        return {signature:`signed:${message}`};
      },
      release:async ()=>{releaseSigning?.();return {released:true};},
      event:async ({kind})=>{emitProcessEvent('worker-event',{kind});return {emitted:true};},
      fail:async ()=>{throw Error('handler failed');},
      multibyte:async ()=>{throw Error('x'+'€'.repeat(100));},
      exit:async ()=>{process.exit(12);},
      large:async ({bytes})=>'x'.repeat(bytes),
    },
  });
}
