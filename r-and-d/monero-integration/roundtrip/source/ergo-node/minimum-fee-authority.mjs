import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import wasmDefault from 'ergo-lib-wasm-nodejs';
import {MinimumFeeBox} from '@rosen-bridge/minimum-fee';

const hex64=/^[0-9a-f]{64}$/,longMax=9223372036854775807n;
const json=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const stable=value=>JSON.stringify(canonical(value));
const hash=value=>createHash('sha256').update(stable(value)).digest('hex');
const integer=(value,label,min=0)=>assert(Number.isSafeInteger(value)&&value>=min&&value<=2147483647,'Minimum fee '+label);
const long=(value,label)=>{
  assert(typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value),'Minimum fee '+label);
  const result=BigInt(value);assert(result<=longMax,'Minimum fee '+label);return result;
};
function policy(input){
  const {nodeUrl,minFeeNFT,ergoTokenId,expectedErgoTree,fromChain,toChain,sourceChainHeight,minConfirmations}=input;
  const url=new URL(nodeUrl);
  assert(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&url.pathname==='/'&&!url.username&&!url.password&&!url.search&&!url.hash,'Minimum fee local endpoint');
  for(const token of [minFeeNFT,ergoTokenId])assert(typeof token==='string'&&hex64.test(token),'Minimum fee token policy');
  assert.notEqual(minFeeNFT,ergoTokenId,'Minimum fee distinct token roles');
  assert(typeof expectedErgoTree==='string'&&/^(?:[0-9a-f]{2}){1,4096}$/.test(expectedErgoTree),'Minimum fee script policy');
  for(const chain of [fromChain,toChain])assert(typeof chain==='string'&&/^[a-z][a-z0-9-]{0,31}$/.test(chain),'Minimum fee chain');
  integer(sourceChainHeight,'source height',1);integer(minConfirmations,'confirmation policy',1);
  return {nodeUrl:url.origin,minFeeNFT,ergoTokenId,expectedErgoTree,fromChain,toChain,sourceChainHeight,minConfirmations};
}
function defaultRpc(nodeUrl){
  return async route=>{
    const response=await fetch(nodeUrl+route,{signal:AbortSignal.timeout(15000),redirect:'error'});
    assert(response.ok,'Minimum fee node HTTP '+response.status);
    const bytes=await response.text();assert(Buffer.byteLength(bytes)<=4_000_000,'Minimum fee node response bound');
    return JSON.parse(bytes);
  };
}
function strictDiscovery(rpc){
  return {getBoxesByTokenId:async tokenId=>{
    const boxes=[],seen=new Set(),pageSize=50,maxBoxes=1000;
    // Ergo 6.0.3 Segment.retrieveUtxos returns a sequence slice, including []
    // beyond its end. Only that successful terminal page establishes completion.
    // MinimumFeeNodeNetwork 4.0.1 instead suppresses HTTP400 and can return a
    // partial list. Keep upstream box selection, but never its error suppression.
    for(let offset=0;offset<=maxBoxes;offset+=pageSize){
      const page=await rpc('/blockchain/box/unspent/byTokenId/'+tokenId+
        '?offset='+offset+'&limit='+pageSize+'&sortDirection=asc&includeUnconfirmed=false&excludeMempoolSpent=false');
      assert(Array.isArray(page)&&page.length<=pageSize,'Minimum fee discovery page shape');
      if(page.length===0)return boxes;
      assert(boxes.length+page.length<=maxBoxes,'Minimum fee discovery total bound');
      for(const box of page){
        assert(box&&hex64.test(box.boxId)&&hex64.test(box.transactionId)&&Array.isArray(box.assets),'Minimum fee discovery box shape');
        assert(!seen.has(box.boxId),'Minimum fee repeated discovery box');seen.add(box.boxId);
        boxes.push({...box,txId:box.transactionId});
      }
    }
    throw Error('Minimum fee discovery terminal page absent');
  }};
}
function isolated(info){
  assert(info?.network==='devnet'&&info.appVersion==='6.0.3'&&info.peersCount===0,'Minimum fee isolated Ergo 6.0.3 devnet');
  integer(info.fullHeight,'node height',1);return info;
}
function serializedBox(raw,wasm){
  // txId is a WASM alias for transactionId; supplying both is a duplicate field.
  const native=Object.fromEntries(['boxId','value','ergoTree','assets','additionalRegisters','creationHeight','transactionId','index'].map(key=>[key,raw[key]]));
  const parsed=wasm.ErgoBox.from_json(json(native));
  try{
    assert.equal(parsed.box_id().to_str(),raw.boxId,'Minimum fee box ID');
    return Buffer.from(parsed.sigma_serialize_bytes()).toString('hex');
  }finally{parsed.free();}
}
function decodeRegisters(raw,wasm){
  const registers=raw.additionalRegisters;
  assert(registers&&Object.keys(registers).filter(k=>registers[k]!==undefined&&registers[k]!=='').sort().join(',')==='R4,R5,R6,R7,R8,R9','Minimum fee complete registers');
  const decoded={};
  for(const name of ['R4','R5','R6','R7','R8','R9']){
    assert(typeof registers[name]==='string'&&/^(?:[0-9a-f]{2}){1,8192}$/.test(registers[name]),'Minimum fee register bytes');
    const value=wasm.Constant.decode_from_base16(registers[name]);
    try{decoded[name]=value.to_js();assert.equal(value.encode_to_base16(),registers[name],'Minimum fee canonical register');}finally{value.free();}
  }
  assert(registers.R4.startsWith('1a')&&registers.R5.startsWith('1c')&&registers.R6.startsWith('1d')&&registers.R7.startsWith('1d')&&registers.R8.startsWith('0c1d')&&registers.R9.startsWith('1d'),'Minimum fee register types');
  const chains=decoded.R4.map(bytes=>Buffer.from(bytes).toString('utf8'));
  assert(chains.length>0&&chains.length<=32&&new Set(chains).size===chains.length&&chains.every(name=>/^[a-z][a-z0-9-]{0,31}$/.test(name)),'Minimum fee chain register');
  const rows=decoded.R5.length;assert(rows>0&&rows<=64,'Minimum fee history bound');
  for(const name of ['R5','R6','R7','R8','R9']){
    assert(Array.isArray(decoded[name])&&decoded[name].length===rows,'Minimum fee history dimensions');
    assert(decoded[name].every(row=>Array.isArray(row)&&row.length===chains.length),'Minimum fee chain dimensions');
  }
  for(let col=0;col<chains.length;col++){
    let previous=-1;
    for(let row=0;row<rows;row++){
      const height=decoded.R5[row][col];
      assert(height===-1||(Number.isInteger(height)&&height>=0&&height<=2147483647),'Minimum fee activation height');
      if(height!==-1){assert(height>=previous,'Minimum fee ordered history');previous=height;}
      const bridge=decoded.R6[row][col],network=decoded.R7[row][col],ratio=decoded.R9[row][col],rsn=decoded.R8[row][col];
      assert(Array.isArray(rsn)&&rsn.length===2,'Minimum fee rsn dimensions');
      // Upstream uses -1 for a route absent in a historical row. Do not interpret
      // a malformed half-present row as a route with an ordinary fee.
      if(height===-1||bridge==='-1'){
        assert(bridge==='-1'&&network==='-1'&&ratio==='-1'&&rsn.every(v=>v==='-1'),'Minimum fee absent route');continue;
      }
      long(bridge,'bridge fee');long(network,'network fee');
      assert(long(ratio,'fee ratio')<=10000n,'Minimum fee fee ratio');
      const numerator=long(rsn[0],'rsn numerator'),denominator=long(rsn[1],'rsn denominator');
      assert(denominator>0n&&numerator<=denominator,'Minimum fee rsn fraction');
    }
  }
}

/**
 * Fresh local-devnet authority capture. Config is trusted operator policy;
 * ports are trusted composition/test transports, never receipt-supplied values.
 * Snapshot fields and feeConfig are JSON-safe; feeConfig values are decimals.
 * The real Rosen MinimumFeeBox owns eligibility and historical fee selection.
 */
export async function captureMinimumFeeAuthority(input,ports={}){
  assert(Object.keys(ports).every(key=>key==='rpc'||key==='wasm'),'Minimum fee unsupported transport port');
  const p=policy(input),rpc=ports.rpc??defaultRpc(p.nodeUrl),wasm=ports.wasm??wasmDefault;
  const network=strictDiscovery(rpc);
  const decode=value=>{const c=wasm.Constant.decode_from_base16(value);try{return c.to_js();}finally{c.free();}};
  async function discover(){
    // A new reader prevents cached data from surviving any failed fetch.
    const reader=new MinimumFeeBox(p.ergoTokenId,p.minFeeNFT,network,decode);
    assert.equal(await reader.fetchBox(),true,'Minimum fee fresh fetch failed');
    const box=reader.getBox();assert(box,'Minimum fee source absent');
    assert.equal(box.ergoTree,p.expectedErgoTree,'Minimum fee configured script');
    assert.equal(box.assets.length,2,'Minimum fee token roles');
    for(const token of [p.minFeeNFT,p.ergoTokenId]){
      const matches=box.assets.filter(asset=>asset.tokenId===token);assert.equal(matches.length,1,'Minimum fee token identity');
      assert.equal(String(matches[0].amount),'1','Minimum fee token amount');
    }
    assert(!box.spentTransactionId,'Minimum fee spent source');
    assert(hex64.test(box.boxId)&&hex64.test(box.txId),'Minimum fee source identifiers');
    decodeRegisters(box,wasm);
    const fee=reader.getFee(p.fromChain,p.sourceChainHeight,p.toChain);
    const feeConfig=Object.fromEntries(['bridgeFee','networkFee','rsnRatio','rsnRatioDivisor','feeRatio','feeRatioDivisor'].map(key=>[key,fee[key].toString()]));
    return {box,boxBytes:serializedBox({...box,transactionId:box.txId},wasm),feeConfig};
  }
  async function primary(found){
    const tx=await rpc('/blockchain/transaction/byId/'+found.box.txId);
    assert.equal(tx.id,found.box.txId,'Minimum fee transaction identity');
    integer(tx.numConfirmations,'confirmations');assert(tx.numConfirmations>=p.minConfirmations,'Minimum fee confirmations');
    integer(tx.inclusionHeight,'inclusion height',1);assert(hex64.test(tx.blockId),'Minimum fee inclusion block');
    const outputs=tx.outputs.filter(box=>box.boxId===found.box.boxId);assert.equal(outputs.length,1,'Minimum fee transaction output');
    assert.equal(serializedBox(outputs[0],wasm),found.boxBytes,'Minimum fee transaction box bytes');
    // This isolated profile fails closed even when a competing header is stored
    // at the same height; it never treats mere header existence as canonicality.
    assert.deepEqual(await rpc('/blocks/at/'+tx.inclusionHeight),[tx.blockId],'Minimum fee canonical block');
    const unspent=await rpc('/utxo/byId/'+found.box.boxId);
    assert.equal(serializedBox(unspent,wasm),found.boxBytes,'Minimum fee current unspent box');
    return {transactionId:tx.id,blockId:tx.blockId,inclusionHeight:tx.inclusionHeight};
  }
  isolated(await rpc('/info'));
  const first=await discover(),inclusion=await primary(first);
  const closing=await discover();assert.equal(closing.boxBytes,first.boxBytes,'Minimum fee policy changed during capture');
  assert.deepEqual(closing.feeConfig,first.feeConfig,'Minimum fee terms changed during capture');
  assert.deepEqual(await primary(closing),inclusion,'Minimum fee inclusion changed during capture');
  const end=isolated(await rpc('/info'));
  assert(end.fullHeight-inclusion.inclusionHeight+1>=p.minConfirmations,'Minimum fee closing confirmation depth');
  const {nodeUrl,...bound}=p;
  const authority={version:1,network:'devnet',nodeVersion:'6.0.3',...bound,boxId:first.box.boxId,boxBytes:first.boxBytes,...inclusion};
  const snapshot={authority,feeConfig:first.feeConfig};return {...snapshot,digest:hash(snapshot)};
}

/** Re-fetches authority; a matching digest alone is never an authorization. */
export async function verifyMinimumFeeAuthority(config,expected,ports={}){
  const claimed=structuredClone(expected),fresh=await captureMinimumFeeAuthority(config,ports);
  assert.equal(stable(claimed),stable(fresh),'Minimum fee authority changed');return fresh;
}
