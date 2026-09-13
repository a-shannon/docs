import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import {spawn, type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

export const daemonPin=Object.freeze({
  path:config.moneroDaemon,
  sha256:config.moneroDaemonSha256,
});
const root=config.runtimeDirectory;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function unusedPort():Promise<number>{
  const server=createServer();
  return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{
    const address=server.address();if(!address||typeof address==='string'){server.close();reject(Error('Local port allocation'));return;}
    server.close(error=>error?reject(error):resolve(address.port));
  });});
}
export class LocalMonero {
  private constructor(readonly port:number,readonly child:ChildProcess){}
  static async start(runtimeRoot=root){
    if(hash(readFileSync(daemonPin.path))!==daemonPin.sha256)throw Error('Daemon executable pin');
    const dir=mkdtempSync(join(runtimeRoot,'node-'));
    const rpcPort=await unusedPort();let p2pPort=await unusedPort();while(p2pPort===rpcPort)p2pPort=await unusedPort();
    const child=spawn(daemonPin.path,['--regtest','--offline','--fixed-difficulty','10','--data-dir',dir,
      '--rpc-bind-ip','127.0.0.1','--rpc-bind-port',String(rpcPort),'--p2p-bind-ip','127.0.0.1','--p2p-bind-port',String(p2pPort),
      '--no-zmq','--no-igd','--disable-dns-checkpoints','--check-updates','disabled','--rpc-ssl','disabled',
      '--non-interactive','--log-level','0','--log-file',join(dir,'node.log')],{windowsHide:true,stdio:'ignore',shell:false});
    let spawnFailed=false;child.once('error',()=>{spawnFailed=true;});
    const node=new LocalMonero(rpcPort,child);
    try {
      const until=Date.now()+45000;
      while(Date.now()<until){
        if(spawnFailed||child.exitCode!==null||child.signalCode!==null)throw Error('Owned daemon startup failed');
        try {await node.isolated();const fork=await node.rpc('hard_fork_info');if(fork.version!==16)throw Error('Local protocol version');return node;}
        catch {await delay(200);}
      }
      throw Error('Owned daemon readiness deadline');
    }catch(error){await node.stop();throw error;}
  }
  async call(path:string,body:Record<string,unknown>):Promise<any>{
    const response=await fetch(`http://127.0.0.1:${this.port}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error('Local daemon HTTP failure');
    const reader=response.body!.getReader();const chunks:Uint8Array[]=[];let length=0;
    while(true){const result=await reader.read();if(result.done)break;length+=result.value.length;if(length>4_000_000){await reader.cancel();throw Error('Local daemon response bound');}chunks.push(result.value);}
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(value.error)throw Error('Local daemon RPC failure');return path==='/json_rpc'?value.result:value;
  }
  rpc(method:string,params:Record<string,unknown>={}){return this.call('/json_rpc',{jsonrpc:'2.0',id:'local-fixture',method,params});}
  async isolated(){
    const info=await this.rpc('get_info');
    if(info.status!=='OK'||info.nettype!=='fakechain'||info.offline!==true||info.mainnet!==false||info.testnet!==false||info.stagenet!==false||
      info.incoming_connections_count!==0||info.outgoing_connections_count!==0||info.untrusted!==false)throw Error('Local isolation predicate');
    return info;
  }
  async submit(bytes:Uint8Array){await this.isolated();return this.call('/send_raw_transaction',{tx_as_hex:Buffer.from(bytes).toString('hex'),do_not_relay:false});}
  async transaction(txId:string){if(!/^[0-9a-f]{64}$/.test(txId))throw Error('Transaction identifier');await this.isolated();return this.call('/get_transactions',{txs_hashes:[txId],decode_as_json:false,prune:false});}
  async mine(count:number,address:string){
    if(!Number.isSafeInteger(count)||count<1||count>100)throw Error('Local mining bound');
    const before=await this.isolated();const result=await this.rpc('generateblocks',{amount_of_blocks:count,wallet_address:address,prev_block:'',starting_nonce:0});
    if(result.status!=='OK'||(await this.isolated()).height!==before.height+count)throw Error('Local mining result');return result;
  }
  async stop(){
    if(this.child.exitCode!==null||this.child.signalCode!==null)return;
    try {await this.call('/stop_daemon',{});}catch{}
    const until=Date.now()+3000;while(this.child.exitCode===null&&this.child.signalCode===null&&Date.now()<until)await delay(50);
    if(this.child.exitCode===null&&this.child.signalCode===null)this.child.kill();
    const killUntil=Date.now()+3000;while(this.child.exitCode===null&&this.child.signalCode===null&&Date.now()<killUntil)await delay(50);
    if(this.child.exitCode===null&&this.child.signalCode===null)throw Error('Owned daemon did not stop');
  }
}
