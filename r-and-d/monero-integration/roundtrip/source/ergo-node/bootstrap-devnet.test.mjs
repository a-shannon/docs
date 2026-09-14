import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {parseArguments,renderConfig,isolatedInfo,freshWallet,walletNeedsUnlock,validateInputs,assertRpcOwnership,createOwnedRpc,rpcRequestOptions,JAR_SHA256,DEVNET_SHA256} from './bootstrap-devnet.mjs';

test('newly initialized wallets may already be unlocked',()=>{
  assert.equal(walletNeedsUnlock({isInitialized:true,isUnlocked:true}),false);
  assert.equal(walletNeedsUnlock({isInitialized:true,isUnlocked:false}),true);
  for(const state of [{isInitialized:false,isUnlocked:false},{isInitialized:true},{isInitialized:true,isUnlocked:1}])assert.throws(()=>walletNeedsUnlock(state));
});

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ergo-bootstrap-guards-'));
const value=name=>path.join(directory,name);
const goodArgs=['--runtime',value('runtime'),'--rosen-root',value('rosen'),'--jar',value('node.jar'),'--java',process.execPath,'--devnet-config',value('devnet.conf')];

test('closed bootstrap arguments require all absolute paths exactly once',()=>{
  const good=parseArguments(goodArgs);assert.equal(good.runtime,value('runtime'));assert(Object.isFrozen(good));
  for(const args of [goodArgs.slice(0,-2),[...goodArgs,'--runtime',value('other')],[...goodArgs,'--network','mainnet'],[...goodArgs,'--java'],['--runtime','relative',...goodArgs.slice(2)]])assert.throws(()=>parseArguments(args));
});
test('configuration forces the local devnet profile after the required upstream include',()=>{
  const rendered=renderConfig(value('runtime'),'11'.repeat(32));
  const include=rendered.indexOf('include required(file(');assert(include>0);
  for(const setting of ['ergo.networkType = "devnet"','ergo.node.extraIndex = true','ergo.node.internalMinerPollingInterval = 100ms',
    'ergo.node.mining = true','ergo.node.offlineGeneration = true','ergo.node.useExternalMiner = false',
    'scorex.network.bindAddress = "127.0.0.1:19021"','scorex.network.knownPeers = []','scorex.network.localOnly = true',
    'scorex.network.upnpEnabled = false','scorex.restApi.bindAddress = "127.0.0.1:19051"']){
    assert.equal(rendered.split(setting).length,2);assert(rendered.indexOf(setting)>include);
  }
  assert.throws(()=>renderConfig('relative','11'.repeat(32)));
  assert.throws(()=>renderConfig(value('runtime'),'11'.repeat(31)));
  assert.throws(()=>renderConfig(value('runtime'),'AA'.repeat(32)));
  assert.equal(JAR_SHA256,'4802cde3550623e639a5d09f45d257922e01815c5b1fe64bdafd2ebc69ec67c7');
  assert.equal(DEVNET_SHA256,'369db106107fca0bb0d22bbff96c3ef29339844ccc562726d738ff08db4f4eab');
});
test('each isolation field independently fails before a wallet mutation',()=>{
  const good={network:'devnet',appVersion:'6.0.3',peersCount:0,fullHeight:730};assert.equal(isolatedInfo(good),good);
  const unmined={...good,fullHeight:null};assert.equal(isolatedInfo(unmined,true),unmined);assert.throws(()=>isolatedInfo(unmined));
  for(const [field,bad]of [['network','mainnet'],['appVersion','6.0.4'],['peersCount',1],['fullHeight',undefined],['fullHeight',-1]])assert.throws(()=>isolatedInfo({...unmined,[field]:bad},true));
  for(const [field,bad]of [['network','mainnet'],['appVersion','6.0.4'],['peersCount',1],['fullHeight',-1],['fullHeight',0.5]])assert.throws(()=>isolatedInfo({...good,[field]:bad}));
  for(const field of Object.keys(good)){const missing={...good};delete missing[field];assert.throws(()=>isolatedInfo(missing));}
});
test('wallet initialization refuses existing custody and missing state independently',()=>{
  freshWallet({isInitialized:false,isUnlocked:false});
  for(const status of [{isInitialized:true,isUnlocked:false},{isInitialized:false,isUnlocked:true},{isInitialized:false},{isUnlocked:false}])assert.throws(()=>freshWallet(status));
});
test('runtime overlap, reuse and bad release bytes fail without creating runtime state',()=>{
  const input=parseArguments(goodArgs);
  fs.mkdirSync(value('rosen'));fs.writeFileSync(value('node.jar'),'wrong jar',{flag:'wx'});fs.writeFileSync(value('devnet.conf'),'wrong config',{flag:'wx'});
  assert.throws(()=>validateInputs({...input,runtime:value('rosen/runtime')}),/Runtime overlaps/);
  assert(!fs.existsSync(value('rosen/runtime')));
  fs.mkdirSync(value('existing'));assert.throws(()=>validateInputs({...input,runtime:value('existing')}),/new absent runtime/);
  assert.throws(()=>validateInputs(input),/Release JAR digest/);assert(!fs.existsSync(input.runtime));
});
test('listener PID, loopback, port, cardinality and OS process start are independent identity checks',()=>{
  const expected={pid:12345,startedUtc:'2026-09-14T12:00:00.0000000Z',executable:process.execPath};
  const good={...expected,listeners:[{address:'127.0.0.1',port:19051,pid:12345}]};
  assert.equal(assertRpcOwnership(good,expected),true);
  for(const change of [{pid:12346},{address:'0.0.0.0'},{address:'::1'},{port:19052}])
    assert.throws(()=>assertRpcOwnership({...good,listeners:[{...good.listeners[0],...change}]},expected),{code:'ERGO_BOOTSTRAP_OWNERSHIP'});
  for(const change of [{pid:12346},{startedUtc:'2026-09-14T12:00:00.0000001Z'},{executable:process.execPath+'.other'}])
    assert.throws(()=>assertRpcOwnership({...good,...change},expected),{code:'ERGO_BOOTSTRAP_OWNERSHIP'});
  assert.throws(()=>assertRpcOwnership({...good,listeners:[...good.listeners,{...good.listeners[0],pid:23456}]},expected,true),{code:'ERGO_BOOTSTRAP_OWNERSHIP'});
  assert.equal(assertRpcOwnership({...good,listeners:[]},expected,true),false);
  assert.throws(()=>assertRpcOwnership({...good,listeners:[]},expected),{code:'ERGO_BOOTSTRAP_OWNERSHIP'});
});
test('pre-request takeover prevents HTTP and post-response takeover prevents result delivery',async()=>{
  for(const failingCheck of [1,2,0]){
    let checks=0,requests=0;
    const rpc=createOwnedRpc('test-only',()=>{if(++checks===failingCheck){const error=Error('ownership');error.code='ERGO_BOOTSTRAP_OWNERSHIP';throw error;}},
      async(_url,options)=>{requests++;assert.equal(options.redirect,'error');return {ok:true,text:async()=>'{"accepted":true}'};});
    if(failingCheck)await assert.rejects(rpc('/wallet/init',{pass:'test-only'}),{code:'ERGO_BOOTSTRAP_OWNERSHIP'});
    else assert.deepEqual(await rpc('/wallet/init',{pass:'test-only'}),{accepted:true});
    assert.equal(requests,failingCheck===1?0:1);assert.equal(checks,failingCheck===1?1:2);
  }
});
test('RPC transport refuses a real HTTP redirect without reaching its destination',async()=>{
  let arrivals=0;
  const destination=createServer((_request,response)=>{arrivals++;response.end('{}');});
  const redirect=createServer((_request,response)=>{response.writeHead(302,{Location:`http://127.0.0.1:${destination.address().port}/capture`});response.end();});
  try{
    await new Promise(resolve=>destination.listen(0,'127.0.0.1',resolve));
    await new Promise(resolve=>redirect.listen(0,'127.0.0.1',resolve));
    await assert.rejects(fetch(`http://127.0.0.1:${redirect.address().port}/wallet/init`,rpcRequestOptions('test-only',{pass:'test-only'})));
    assert.equal(arrivals,0);
  }finally{
    for(const server of [redirect,destination]){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  }
});
