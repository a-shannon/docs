// Invalid transport only. Producer evidence contains no raw wire payload.
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const mode=process.env.W1HB_HOSTILE,runId=process.env.W1HB_RUN_ID,dir=process.env.W1HB_TRACE_DIR,instance=randomUUID();
if(!runId||!dir)throw Error('Missing trace context');
function record(data){appendFileSync(join(dir,`hostile-${instance}.jsonl`),JSON.stringify({kind:'hostile-producer',runId,instance,pid:process.pid,mode,...data})+'\n');}
function output(channel,raw,exit=false){const bytes=Buffer.from(raw);record({stage:'selected',channel,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});process[channel].write(bytes,()=>{record({stage:'flushed',channel,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});if(exit)process.exit(0);});}
let request='';
process.stdin.on('data',raw=>{request+=raw.toString('ascii');if(request.split('\n').length<4)return;process.stdin.removeAllListeners('data');const [,nonce,generation]=request.split('\n');
 const invalid=['W1HA1',nonce,generation,'00','invalid','0','0','0','0','0','0'.repeat(64),'0'.repeat(64),'1'];
 if(mode==='wrong-tag')invalid[0]='WRONG';if(mode==='wrong-nonce')invalid[1]='0'.repeat(64);if(mode==='wrong-generation')invalid[2]='0';
 if(mode==='ascii')output('stdout',Buffer.from([255]));else if(mode==='oversize')output('stdout','X'.repeat(18001));else if(mode==='stderr')output('stderr','X'.repeat(4097));else if(mode==='partial')output('stdout','W1HA1\n',true);else if(mode==='duplicate')output('stdout',invalid.join('\n')+'\n'+invalid.join('\n')+'\n');else if(mode==='timeout')record({stage:'request-received-no-response'});else output('stdout',invalid.join('\n')+'\n');
});
