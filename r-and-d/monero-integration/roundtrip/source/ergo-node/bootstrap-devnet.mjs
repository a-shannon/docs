import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {assertExternalWork,canonicalPath} from '../tools/launcher-guards.mjs';

export const JAR_SHA256='4802cde3550623e639a5d09f45d257922e01815c5b1fe64bdafd2ebc69ec67c7';
export const DEVNET_SHA256='369db106107fca0bb0d22bbff96c3ef29339844ccc562726d738ff08db4f4eab';
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const amount=100_000_000_000,fee=1_100_000;
const options=['runtime','rosen-root','jar','java','devnet-config'];
const write=(directory,name,value)=>fs.writeFileSync(path.join(directory,name),typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx',mode:0o600});

export function parseArguments(args){
  const parsed={};
  for(let i=0;i<args.length;i+=2){
    const key=args[i]?.slice(2),value=args[i+1];
    assert(args[i]?.startsWith('--')&&options.includes(key)&&!Object.hasOwn(parsed,key)&&typeof value==='string','Bootstrap arguments');
    assert(path.isAbsolute(value)&&!/[\x00-\x1f]/.test(value),'Absolute bootstrap path required');parsed[key]=path.resolve(value);
  }
  assert(options.every(key=>Object.hasOwn(parsed,key)),'Complete bootstrap arguments required');return Object.freeze(parsed);
}
export function validateInputs(input){
  for(const key of options)assert(typeof input[key]==='string'&&path.isAbsolute(input[key]),'Absolute bootstrap path required');
  assertExternalWork(input.runtime,[sourceRoot,input['rosen-root'],input.jar,input.java,input['devnet-config']]);
  assert(!fs.existsSync(input.runtime),'A new absent runtime directory is required');
  assert(fs.statSync(path.dirname(input.runtime)).isDirectory(),'Runtime parent directory required');
  for(const key of ['jar','java','devnet-config'])assert(fs.statSync(input[key]).isFile(),'Bootstrap input file required');
  const jar=fs.readFileSync(input.jar),devnet=fs.readFileSync(input['devnet-config']);
  assert.equal(hash(jar),JAR_SHA256,'Release JAR digest');assert.equal(hash(devnet),DEVNET_SHA256,'Upstream devnet config digest');
  const disk=fs.statfsSync(path.dirname(input.runtime),{bigint:true});
  assert(disk.bavail*disk.bsize>=10n*1024n**3n,'Runtime disk headroom');
  return {devnet,java:fs.realpathSync.native(input.java),jar:fs.realpathSync.native(input.jar),runtime:canonicalPath(input.runtime)};
}
export function renderConfig(runtime,apiHash){
  assert(path.isAbsolute(runtime)&&!/[\x00-\x1f]/.test(runtime),'Absolute runtime path required');assert.match(apiHash,/^[0-9a-f]{64}$/);
  const quoted=name=>JSON.stringify(path.join(runtime,name).replaceAll('\\','/'));
  return `include classpath("application.conf")
include required(file(${quoted('upstream-devnet.conf')}))
ergo.directory = ${quoted('data')}
ergo.networkType = "devnet"
ergo.node.extraIndex = true
ergo.node.internalMinerPollingInterval = 100ms
ergo.node.mining = true
ergo.node.offlineGeneration = true
ergo.node.useExternalMiner = false
scorex.network.bindAddress = "127.0.0.1:19021"
scorex.network.knownPeers = []
scorex.network.localOnly = true
scorex.network.upnpEnabled = false
scorex.restApi.bindAddress = "127.0.0.1:19051"
scorex.restApi.apiKeyHash = "${apiHash}"
`;
}
export function isolatedInfo(info,allowUnmined=false){
  assert(info&&info.network==='devnet'&&info.appVersion==='6.0.3'&&info.peersCount===0,'Isolated Ergo 6.0.3 devnet required');
  assert((allowUnmined&&info.fullHeight===null)||(Number.isSafeInteger(info.fullHeight)&&info.fullHeight>=0),'Ergo height required');return info;
}
export function freshWallet(status){
  assert(status?.isInitialized===false&&status.isUnlocked===false,'Refusing initialized or unlocked wallet');
}
export function walletNeedsUnlock(status){
  assert(status?.isInitialized===true&&typeof status.isUnlocked==='boolean','Initialized wallet state required');
  return !status.isUnlocked;
}
function ownershipFailure(){const error=Error('Owned Java REST listener identity mismatch');error.code='ERGO_BOOTSTRAP_OWNERSHIP';throw error;}
export function assertRpcOwnership(actual,expected,allowAbsent=false){
  const executable=value=>typeof value==='string'?value.replaceAll('\\','/').toLowerCase():undefined;
  if(!Number.isSafeInteger(expected?.pid)||expected.pid<=0||!Number.isFinite(Date.parse(expected.startedUtc))||
    !expected.executable||actual?.pid!==expected.pid||actual.startedUtc!==expected.startedUtc||
    executable(actual.executable)!==executable(expected.executable)||!Array.isArray(actual.listeners))ownershipFailure();
  if(actual.listeners.length===0&&allowAbsent)return false;
  if(actual.listeners.length!==1)ownershipFailure();
  const listener=actual.listeners[0];
  if(listener?.address!=='127.0.0.1'||listener.port!==19051||listener.pid!==expected.pid)ownershipFailure();
  return true;
}
export function rpcRequestOptions(apiKey,body){
  return {signal:AbortSignal.timeout(15000),redirect:'error',method:body===undefined?'GET':'POST',
    headers:{api_key:apiKey,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})};
}
export function createOwnedRpc(apiKey,assertOwner,fetchImpl=fetch){
  return async(route,body,allowAbsent=false)=>{
    await assertOwner(allowAbsent);let response;
    try{response=await fetchImpl('http://127.0.0.1:19051'+route,rpcRequestOptions(apiKey,body));}
    catch(error){
      if(['ECONNREFUSED','ECONNRESET','UND_ERR_SOCKET'].includes(error?.cause?.code??error?.code)){
        const failure=Error('Owned REST connectivity pending');failure.code='ERGO_BOOTSTRAP_CONNECTIVITY';throw failure;
      }
      throw error;
    }
    const raw=await response.text();assert(Buffer.byteLength(raw)<=4_000_000,'Bootstrap RPC response bound');
    // Do not consume an initialization/signing response after listener takeover.
    await assertOwner(false);
    if(!response.ok){const error=Error(`Bootstrap RPC HTTP ${response.status} at ${route}`);error.code='ERGO_BOOTSTRAP_HTTP';error.status=response.status;throw error;}
    return raw.length?JSON.parse(raw):null;
  };
}
function windowsOwnership(pid){
  assert(Number.isSafeInteger(pid)&&pid>0,'Owned Java PID required');
  const command=`$ErrorActionPreference='Stop'; $taskProcess=Get-Process -Id ${pid}; `+
    `$taskListeners=@(Get-NetTCPConnection -State Listen -LocalPort 19051 -ErrorAction SilentlyContinue | ForEach-Object { `+
    `[pscustomobject]@{address=$_.LocalAddress;port=$_.LocalPort;pid=$_.OwningProcess} }); `+
    `[pscustomobject]@{pid=$taskProcess.Id;startedUtc=$taskProcess.StartTime.ToUniversalTime().ToString('o');`+
    `executable=$taskProcess.Path;listeners=$taskListeners} | ConvertTo-Json -Depth 4 -Compress`;
  try{return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],
    {encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:65536}));}
  catch{ownershipFailure();}
}
async function reservePort(port){
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port,exclusive:true},resolve);});
  return ()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
async function stopOwned(child){
  if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return;
  child.kill();const until=Date.now()+10000;
  while(child.exitCode===null&&child.signalCode===null&&Date.now()<until)await delay(100);
  assert(child.exitCode!==null||child.signalCode!==null,'Owned Java cleanup did not complete');
}

/** Creates a fresh, funded isolated devnet; leaves its owned Java process running. */
export async function bootstrap(input,onEvent=()=>{}){
  assert(process.platform==='win32','Windows listener ownership inspection required');
  const verified=validateInputs(input),require=createRequire(path.join(input['rosen-root'],'package.json'));
  const wasm=require('ergo-lib-wasm-nodejs'),{blake2b}=require('@noble/hashes/blake2b');
  let releaseRest,releaseP2p,child,stdout,stderr,spawnError=false;
  const current=()=>assert(child&&!spawnError&&child.exitCode===null&&child.signalCode===null,'Owned Java process exited');
  try{
    // Keep both sockets reserved until all fresh custody/config files are ready.
    releaseRest=await reservePort(19051);releaseP2p=await reservePort(19021);
    fs.mkdirSync(input.runtime,{mode:0o700});
    fs.mkdirSync(path.join(input.runtime,'data'),{mode:0o700});
    const apiKey=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex');
    const apiHash=Buffer.from(blake2b(Buffer.from(apiKey),{dkLen:32})).toString('hex');
    const recipientKey=wasm.SecretKey.random_dlog(),recipient=recipientKey.get_address().to_base58(wasm.NetworkPrefix.Testnet);
    write(input.runtime,'api-private.json',{apiKey});
    write(input.runtime,'recipient-private.json',{key:Buffer.from(recipientKey.to_bytes()).toString('hex')});recipientKey.free();
    fs.writeFileSync(path.join(input.runtime,'upstream-devnet.conf'),verified.devnet,{flag:'wx',mode:0o600});
    const configuration=renderConfig(input.runtime,apiHash);write(input.runtime,'application.conf',configuration);
    stdout=fs.openSync(path.join(input.runtime,'stdout.log'),'wx',0o600);stderr=fs.openSync(path.join(input.runtime,'stderr.log'),'wx',0o600);
    // Recheck immutable inputs immediately before launch, then release sockets.
    assert.equal(hash(fs.readFileSync(verified.jar)),JAR_SHA256,'Release JAR changed');
    assert.equal(hash(fs.readFileSync(input['devnet-config'])),DEVNET_SHA256,'Upstream config changed');
    await releaseRest();releaseRest=undefined;await releaseP2p();releaseP2p=undefined;
    const spawnRequestedUtc=new Date().toISOString();
    child=spawn(verified.java,['-Xmx2g','-jar',verified.jar,'--devnet','-c',path.join(input.runtime,'application.conf')],
      {cwd:input.runtime,windowsHide:true,detached:true,stdio:['ignore',stdout,stderr],shell:false});
    child.once('error',()=>{spawnError=true;});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('Java launch failed')));});
    let startedUtc=spawnRequestedUtc;
    if(process.platform==='win32')startedUtc=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      `(Get-Process -Id ${child.pid}).StartTime.ToUniversalTime().ToString('o')`],{encoding:'utf8',windowsHide:true}).trim();
    assert(Number.isFinite(Date.parse(startedUtc)),'Java process start identity');
    write(input.runtime,'process.json',{pid:child.pid,executable:verified.java,jar:verified.jar,jarSha256:JAR_SHA256,
      startedUtc,spawnRequestedUtc,rest:'http://127.0.0.1:19051',devnetConfigSha256:DEVNET_SHA256,configurationSha256:hash(configuration)});
    const expectedOwner={pid:child.pid,startedUtc,executable:verified.java};
    const assertOwner=allowAbsent=>{
      current();const present=assertRpcOwnership(windowsOwnership(child.pid),expectedOwner,allowAbsent);current();
      if(!present){const error=Error('Owned REST listener not yet present');error.code='ERGO_BOOTSTRAP_LISTENER_PENDING';throw error;}
    };
    const rpc=createOwnedRpc(apiKey,assertOwner);
    const startupUntil=Date.now()+120000;let info;
    while(Date.now()<startupUntil){
      current();let response;try{response=await rpc('/info',undefined,true);}catch(error){
        if(!['ERGO_BOOTSTRAP_LISTENER_PENDING','ERGO_BOOTSTRAP_CONNECTIVITY'].includes(error?.code))throw error;
        await delay(250);continue;
      }
      info=isolatedInfo(response,true);break;
    }
    assert(info,'Owned devnet readiness deadline');
    freshWallet(await rpc('/wallet/status'));isolatedInfo(await rpc('/info'),true);
    const initialized=await rpc('/wallet/init',{pass:password});
    assert(typeof initialized?.mnemonic==='string'&&initialized.mnemonic.trim().split(/\s+/).length>=12,'Fresh wallet initialization failed');
    write(input.runtime,'wallet-private.json',{password,mnemonic:initialized.mnemonic});
    const master=wasm.ExtSecretKey.derive_master(wasm.Mnemonic.to_seed(initialized.mnemonic,''));
    const derived=master.derive(wasm.DerivationPath.new(0,new Uint32Array([0])));
    const fundingKey=wasm.SecretKey.dlog_from_bytes(derived.secret_key_bytes());
    const fundingAddress=fundingKey.get_address().to_base58(wasm.NetworkPrefix.Testnet);
    const fundingTree=fundingKey.get_address().to_ergo_tree().to_base16_bytes();fundingKey.free();derived.free();master.free();
    isolatedInfo(await rpc('/info'),true);
    if(walletNeedsUnlock(await rpc('/wallet/status')))await rpc('/wallet/unlock',{pass:password});
    const wallet=await rpc('/wallet/status');assert(wallet.isInitialized===true&&wallet.isUnlocked===true,'Fresh wallet unlock failed');
    assert.equal(wallet.changeAddress,fundingAddress,'Wallet EIP3 funding identity');
    onEvent({stage:'fresh-wallet-mining',recipient,fundingAddress});
    const fundingUntil=Date.now()+15*60*1000;let balance,nextProgress=0;
    while(Date.now()<fundingUntil){
      info=isolatedInfo(await rpc('/info'),true);balance=await rpc('/wallet/balances');
      assert(Number.isSafeInteger(balance.balance)&&balance.balance>=0,'Confirmed wallet balance required');
      if(info.fullHeight>=730&&balance.balance>=amount+fee)break;
      if(Date.now()>=nextProgress){onEvent({stage:'waiting-for-mature-funding',height:info.fullHeight,confirmedBalanceAtomic:String(balance.balance)});nextProgress=Date.now()+30000;}
      await delay(500);
    }
    assert(info.fullHeight>=730&&balance.balance>=amount+fee,'Fresh wallet funding deadline');
    // Convert mature mining rewards into the plain EIP3 outputs selected by the
    // authority fixture. Retain the exact signed transaction before submission.
    isolatedInfo(await rpc('/info'));
    const transaction=await rpc('/wallet/transaction/generate',{requests:[{address:fundingAddress,value:amount}],fee});
    assert(transaction&&/^[0-9a-f]{64}$/.test(transaction.id)&&Array.isArray(transaction.outputs),'Self-funding transaction profile');
    const selected=transaction.outputs.filter(box=>box.ergoTree===fundingTree&&box.value===amount);
    assert.equal(selected.length,1,'Exact plain EIP3 funding output');
    write(input.runtime,'bootstrap-funding-signed.json',transaction);
    isolatedInfo(await rpc('/info'));assert.equal(await rpc('/transactions',transaction),transaction.id,'Self-funding submission identity');
    const confirmationUntil=Date.now()+120000;let confirmed;
    while(Date.now()<confirmationUntil){
      isolatedInfo(await rpc('/info'));let candidate;
      try{candidate=await rpc('/blockchain/transaction/byId/'+transaction.id);}catch(error){
        if(error?.code!=='ERGO_BOOTSTRAP_HTTP'||error.status!==404)throw error;
        await delay(250);continue;
      }
      if(candidate?.numConfirmations>0){confirmed=candidate;break;}await delay(250);
    }
    assert(confirmed&&confirmed.id===transaction.id,'Self-funding confirmation deadline');
    const box=confirmed.outputs.find(output=>output.boxId===selected[0].boxId);
    assert(box&&box.ergoTree===fundingTree&&box.value===amount,'Confirmed funding output identity');
    const unspent=await rpc('/utxo/byId/'+box.boxId);
    assert.equal(unspent.boxId,box.boxId);assert.equal(unspent.ergoTree,fundingTree);assert.equal(unspent.value,amount);assert.equal(unspent.transactionId,transaction.id);
    info=isolatedInfo(await rpc('/info'));balance=await rpc('/wallet/balances');
    assert(info.fullHeight>=730&&Number.isSafeInteger(balance.balance)&&balance.balance>=amount,'Confirmed funded wallet');
    const ready={status:'ready',network:'devnet',appVersion:'6.0.3',height:info.fullHeight,peersCount:0,recipient,fundingAddress,
      confirmedBalanceAtomic:String(balance.balance),plainFundingAtomic:String(amount),fundingTransactionId:transaction.id,fundingBoxIds:[box.boxId],
      jarSha256:JAR_SHA256,devnetConfigSha256:DEVNET_SHA256};
    assertOwner(false);write(input.runtime,'bootstrap-ready.json',ready);child.unref();return ready;
  }catch(error){await stopOwned(child);throw error;}
  finally{if(releaseRest)await releaseRest();if(releaseP2p)await releaseP2p();if(stdout!==undefined)fs.closeSync(stdout);if(stderr!==undefined)fs.closeSync(stderr);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const ready=await bootstrap(parseArguments(process.argv.slice(2)),event=>console.log(JSON.stringify(event)));console.log(JSON.stringify(ready));}
  catch(error){console.error('Ergo devnet bootstrap failed: '+String(error.message).slice(0,512));process.exitCode=1;}
}
