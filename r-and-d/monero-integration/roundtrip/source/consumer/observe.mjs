import {registerHooks} from 'node:module';
import {readFileSync,appendFileSync,mkdirSync,existsSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const dir=process.env.W1HB_TRACE_DIR,runId=process.env.W1HB_RUN_ID,instance=randomUUID();
if(!dir||!runId)throw Error('Run-owned trace context required');
const sink=join(dir,`node-${instance}.jsonl`);
const blobs=join(dir,'blobs');mkdirSync(blobs,{recursive:true});
function capture(raw){const sha256=createHash('sha256').update(raw).digest('hex');const target=join(blobs,sha256);if(!existsSync(target)){const tmp=join(blobs,randomUUID()+'.tmp');writeFileSync(tmp,raw);try{renameSync(tmp,target);}catch(e){if(!existsSync(target))throw e;unlinkSync(tmp);}}return sha256;}
function record(data){appendFileSync(sink,JSON.stringify({runId,instance,pid:process.pid,...data})+'\n');}
record({kind:'process-start',parentPid:process.ppid});
registerHooks({load(url,context,nextLoad){const result=nextLoad(url,context);if(url.startsWith('file:')){const path=fileURLToPath(url);const raw=readFileSync(path);record({kind:'node-load',path:path.replaceAll('\\','/'),bytes:raw.length,sha256:capture(raw),format:result.format});}return result;}});
