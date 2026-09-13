import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';

export function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  if(typeof value==='number'&&!Number.isSafeInteger(value))throw Error('Noncanonical number');
  return JSON.stringify(value);
}
const hex32=()=>randomBytes(32).toString('hex');
export class Participant {
  queue=[];pending=null;buffer=Buffer.alloc(0);failure=null;closed=false;stderrBytes=0;frames=0;readySeen=0;
  constructor(id,binary){
    this.id=id;this.child=spawn(binary,[String(id)],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
    this.child.stdin.on('error',()=>{});
    this.child.on('error',()=>this.fail('Participant process failed'));
    this.child.stderr.on('data',chunk=>{this.stderrBytes+=chunk.length;if(this.stderrBytes>4096)this.fail('Participant stderr bound');});
    this.child.stdout.on('data',chunk=>{
      this.buffer=Buffer.concat([this.buffer,chunk]);let newline;
      try{
        while((newline=this.buffer.indexOf(10))!==-1){
          if(newline>65536)throw Error('Participant frame bound');
          const bytes=this.buffer.subarray(0,newline);this.buffer=this.buffer.subarray(newline+1);
          if(bytes.some(c=>c<32||c>126))throw Error('Participant frame encoding');
          const text=bytes.toString('ascii'),value=JSON.parse(text);
          if(canonical(value)!==text)throw Error('Participant canonical frame');
          if(++this.frames>64)throw Error('Participant frame count');
          if(value.type==='ready')this.readySeen++;
          if(this.pending){const {resolve,timer}=this.pending;this.pending=null;clearTimeout(timer);resolve(value);}else this.queue.push(value);
        }
        if(this.buffer.length>65536)throw Error('Participant frame bound');
      }catch{this.fail('Participant output rejected');}
    });
    this.child.once('close',(code,signal)=>{this.closed=true;if(this.pending){const {reject,timer,phase}=this.pending;this.pending=null;clearTimeout(timer);reject(Error(`Participant ${this.id} closed during ${phase}; exit=${code}; signal=${signal}; stderrBytes=${this.stderrBytes}`));}});
  }
  fail(message){this.failure=Error(message);if(this.pending){const {reject,timer}=this.pending;this.pending=null;clearTimeout(timer);reject(this.failure);}this.child.kill();}
  next(timeoutMs=15000,phase='protocol'){
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>180000)return Promise.reject(Error('Participant deadline bound'));
    if(this.failure)return Promise.reject(this.failure);
    if(this.queue.length)return Promise.resolve(this.queue.shift());
    if(this.closed)return Promise.reject(Error('Participant closed'));
    if(this.pending)return Promise.reject(Error('Concurrent participant read'));
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending=null;reject(Error(`Participant ${phase} response deadline`));},timeoutMs);this.pending={resolve,reject,timer,phase};});
  }
  send(value){
    if(this.closed||this.failure)return Promise.reject(Error('Participant unavailable'));
    const text=canonical(value)+'\n';if(Buffer.byteLength(text)>65537)return Promise.reject(Error('Participant request bound'));
    return new Promise((resolve,reject)=>this.child.stdin.write(text,error=>error?reject(Error('Participant pipe closed')):resolve()));
  }
  async close(){
    if(!this.closed){try{await this.send({type:'stop'});this.child.stdin.end();}catch{} }
    const until=Date.now()+2000;while(!this.closed&&Date.now()<until)await delay(10);
    if(!this.closed)this.child.kill();
    const killedUntil=Date.now()+3000;while(!this.closed&&Date.now()<killedUntil)await delay(10);
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(Error('Participant retired'));this.pending=null;}
    this.queue=[];this.buffer=Buffer.alloc(0);
    if(!this.closed)throw Error('Participant cleanup failed');
  }
}

export async function runCeremony({binary,sha256,fault,keepAlive=false}={}){
  if(!binary||!/^[0-9a-f]{64}$/.test(sha256??'')||createHash('sha256').update(readFileSync(binary)).digest('hex')!==sha256)throw Error('Participant binary pin');
  const actors=[1,2,3,4].map(id=>new Participant(id,binary));let success=false;
  try{
    const identities=await Promise.all(actors.map(a=>a.next()));
    identities.forEach((v,i)=>{if(canonical(Object.keys(v).sort())!==canonical(['id','pid','publicKey','type'])||v.type!=='identity'||v.id!==i+1||v.pid!==actors[i].child.pid||!/^0[23][0-9a-f]{64}$/.test(v.publicKey))throw Error('Participant identity');});
    if(new Set(identities.map(i=>i.pid)).size!==4||new Set(identities.map(i=>i.publicKey)).size!==4)throw Error('Participant independence');
    const init={type:'init',ceremony:hex32(),epoch:hex32(),threshold:2,roster:identities.map(({id,publicKey})=>({id,publicKey}))};
    await Promise.all(actors.map((a,i)=>a.send(fault==='ceremony'&&i===3?{...init,ceremony:hex32()}:init)));
    const counters=[];let firstRound;
    for(let round=1;round<=4;round++){
      const batches=await Promise.all(actors.map(async a=>{
        const items=[];for(let n=0;n<3;n++)items.push(await a.next());
        if(new Set(items.map(x=>x.to)).size!==3||items.some(x=>x.type!=='peer'||x.from!==a.id||x.to===a.id||x.to<1||x.to>4||x.round!==round||x.sequence!==round||!/^[0-9a-f]+$/.test(x.payload)||!/^[0-9a-f]{128}$/.test(x.signature)))throw Error('Participant outbound round');
        return items;
      }));
      let deliveries=batches.flat().map(message=>({target:message.to,message}));
      if(round===1)firstRound=deliveries[0];
      if(fault==='interrupt'&&round===2){actors[3].child.kill();await actors[3].close();}
      if(round===1&&fault==='sender'){const d=deliveries[0];let sender=d.message.from%4+1;if(sender===d.target)sender=sender%4+1;d.message={...d.message,from:sender};}
      if(round===1&&fault==='recipient'){const d=deliveries[0];d.target=d.target%4+1;}
      if(round===1&&fault==='round')deliveries[0].message={...deliveries[0].message,round:2};
      if(round===2&&fault==='replay')deliveries=[firstRound,...deliveries];
      if(round===4&&fault==='duplicate-completion')deliveries.splice(1,0,deliveries[0]);
      for(const d of deliveries)await actors[d.target-1].send(d.message);
      counters.push({round,sent:deliveries.length});
    }
    const ready=await Promise.all(actors.map(a=>a.next()));
    const expectedKeys=['ceremony','epoch','groupKey','id','n','pid','rosterDigest','threshold','type','verificationShares'];
    ready.forEach((v,i)=>{if(canonical(Object.keys(v).sort())!==canonical(expectedKeys)||v.type!=='ready'||v.id!==i+1||v.pid!==actors[i].child.pid||v.threshold!==2||v.n!==4||v.ceremony!==init.ceremony||v.epoch!==init.epoch||!/^[0-9a-f]{64}$/.test(v.groupKey)||!/^[0-9a-f]{64}$/.test(v.rosterDigest))throw Error('Participant readiness');});
    if(new Set(ready.map(x=>canonical({groupKey:x.groupKey,verificationShares:x.verificationShares,rosterDigest:x.rosterDigest}))).size!==1)throw Error('Participant roster disagreement');
    const summary={participants:4,threshold:2,distinctProcesses:4,rounds:counters,groupKey:ready[0].groupKey,rosterDigest:ready[0].rosterDigest};
    success=true;return {summary,actors,identities,init,ready,close:async()=>{const results=await Promise.allSettled(actors.map(a=>a.close()));if(results.some(r=>r.status==='rejected'))throw Error('Participant cleanup failed');}};
  }finally{
    if(!success||!keepAlive){const results=await Promise.allSettled(actors.map(a=>a.close()));if(results.some(r=>r.status==='rejected'))throw Error('Participant cleanup failed');}
  }
}
