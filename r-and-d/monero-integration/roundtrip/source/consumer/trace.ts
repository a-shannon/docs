import {appendFileSync,readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const dir=process.env.W1HB_TRACE_DIR;
const runId=process.env.W1HB_RUN_ID;
const instance=randomUUID();
if(!dir||!runId)throw Error('Run-owned trace context required');
export function trace(kind:string,data:Record<string,unknown>,raw?:Uint8Array|string){if(raw===undefined&&['vite-raw','cjs-load'].includes(kind))raw=readFileSync(String(data.path));if(raw!==undefined){const bytes=typeof raw==='string'?Buffer.from(raw):Buffer.from(raw);const sha256=createHash('sha256').update(bytes).digest('hex');if(data.sha256!==sha256||data.bytes!==bytes.length)throw Error('Observation byte mismatch');const blobs=join(dir!,'blobs');mkdirSync(blobs,{recursive:true});const target=join(blobs,sha256);if(!existsSync(target)){const tmp=join(blobs,randomUUID()+'.tmp');writeFileSync(tmp,bytes);try{renameSync(tmp,target);}catch(e){if(!existsSync(target))throw e;unlinkSync(tmp);}}}appendFileSync(join(dir!,`consumer-${instance}.jsonl`),JSON.stringify({runId,instance,pid:process.pid,kind,...data})+'\n');}
