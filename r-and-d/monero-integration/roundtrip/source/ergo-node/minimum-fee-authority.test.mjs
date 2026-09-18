import test from 'node:test';
import assert from 'node:assert/strict';
import wasm from 'ergo-lib-wasm-nodejs';
import {createHash} from 'node:crypto';
import {MinimumFeeBox,MinimumFeeNodeNetwork} from '@rosen-bridge/minimum-fee';
import {captureMinimumFeeAuthority,verifyMinimumFeeAuthority} from './minimum-fee-authority.mjs';

const id=n=>n.toString(16).padStart(2,'0').repeat(32);
const tree='0008cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
function setup(){
  const values={R4:[Buffer.from('ergo'),Buffer.from('monero')],R5:[[0,0],[100,100]],
    R6:[['100','200'],['300','400']],R7:[['20','30'],['40','50']],
    R8:[[['1','100'],['1','100']],[['2','100'],['2','100']]],R9:[['10','20'],['30','40']]};
  const config={nodeUrl:'http://127.0.0.1:19051',minFeeNFT:id(1),ergoTokenId:id(2),expectedErgoTree:tree,
    fromChain:'monero',toChain:'ergo',sourceChainHeight:100,minConfirmations:2};
  const state={values,duplicate:false,networkError:false,spent:false,networkReads:0,txReads:0,
    confirmations:5,blockId:id(4),height:500,canonical:id(4),info:{network:'devnet',appVersion:'6.0.3',peersCount:0,fullHeight:504}};
  function box(){
    const additionalRegisters=Object.fromEntries(Object.entries(state.values).map(([key,value])=>[key,
      (key==='R4'?wasm.Constant.from_coll_coll_byte(value):wasm.Constant.from_js(value)).encode_to_base16()]));
    const raw={value:'1000000',ergoTree:tree,assets:[{tokenId:id(1),amount:'1'},{tokenId:id(2),amount:'1'}],
      additionalRegisters,creationHeight:490,transactionId:id(3),index:0};
    state.mutateBox?.(raw);
    const parsed=wasm.ErgoBox.from_json(JSON.stringify(raw));
    const result={...raw,boxId:parsed.box_id().to_str()};parsed.free();return result;
  }
  const network={getBoxesByTokenId:async token=>{
    assert.equal(token,config.minFeeNFT);state.networkReads++;
    if(state.networkError)throw Error('network unavailable');state.onNetworkRead?.();
    const raw=box(),wrapped={...raw,txId:raw.transactionId};return state.duplicate?[wrapped,structuredClone(wrapped)]:[wrapped];
  }};
  const rpc=async route=>{
    if(route.startsWith('/blockchain/box/unspent/byTokenId/')){
      const url=new URL(route,config.nodeUrl),offset=Number(url.searchParams.get('offset'));
      assert.equal(url.pathname,'/blockchain/box/unspent/byTokenId/'+config.minFeeNFT);
      assert.equal(url.searchParams.get('limit'),'50');assert.equal(url.searchParams.get('sortDirection'),'asc');
      assert.equal(url.searchParams.get('includeUnconfirmed'),'false');assert.equal(url.searchParams.get('excludeMempoolSpent'),'false');
      if(offset===0){state.networkReads++;state.onNetworkRead?.();}
      if(state.networkError)throw Error('network unavailable');
      if(state.page)return state.page(offset);
      return offset===0?(state.duplicate?[box(),box()]:[box()]):[];
    }
    if(route==='/info')return structuredClone(state.info);
    if(route.startsWith('/blocks/at/'))return [state.canonical];
    if(route.startsWith('/utxo/byId/')){if(state.spent)throw Error('404 spent');return box();}
    if(route==='/blockchain/transaction/byId/'+id(3)){
      state.txReads++;state.onTxRead?.();return {id:id(3),numConfirmations:state.confirmations,blockId:state.blockId,inclusionHeight:state.height,outputs:[box()]};
    }
    throw Error('Unexpected route '+route);
  };
  return {config,state,ports:{rpc,wasm},network,box};
}
test('actual package decodes current registers and strict source-height history boundary',async()=>{
  const f=setup(),first=await captureMinimumFeeAuthority(f.config,f.ports);
  assert.deepEqual(first.feeConfig,{bridgeFee:'100',networkFee:'20',rsnRatio:'1',rsnRatioDivisor:'100',feeRatio:'10',feeRatioDivisor:'10000'});
  assert.equal(first.authority.inclusionHeight,500);assert.equal(first.authority.sourceChainHeight,100);
  f.config.sourceChainHeight=101;const next=await captureMinimumFeeAuthority(f.config,f.ports);
  assert.equal(next.feeConfig.bridgeFee,'300');assert.equal(next.feeConfig.networkFee,'40');assert.notEqual(first.digest,next.digest);
});
test('unchanged authority revalidates across additional confirmations',async()=>{
  const f=setup(),first=await captureMinimumFeeAuthority(f.config,f.ports);
  f.state.confirmations++;f.state.info.fullHeight++;
  assert.deepEqual(await verifyMinimumFeeAuthority(f.config,first,f.ports),first);
});
test('strict discovery maps indexed transaction IDs and requires terminal pages',async()=>{
  const f=setup();let pages=0;f.state.page=offset=>{pages++;return offset===0?[f.box()]:[];};
  const captured=await captureMinimumFeeAuthority(f.config,f.ports);
  assert.equal(captured.authority.transactionId,id(3));assert.equal(pages,4);
});
test('upstream HTTP400 baseline returns incomplete discovery but cannot be injected into authority',async()=>{
  const f=setup(),network=new MinimumFeeNodeNetwork(f.config.nodeUrl);
  network.nodeClient={getBoxesByTokenIdUnspent:async(_token,{offset})=>{
    if(offset===0)return [f.box()];
    throw {response:{status:400,data:{reason:'simulated incomplete indexed discovery'}}};
  }};
  assert.equal((await network.getBoxesByTokenId(f.config.minFeeNFT)).length,1);
  await assert.rejects(captureMinimumFeeAuthority(f.config,{...f.ports,network}),/unsupported transport/);
});
for(const [name,error] of [['HTTP400',{response:{status:400,data:{reason:'incomplete indexed discovery'}}}],['HTTP500',{response:{status:500}}],['network error',Error('connection reset')]])
  test('review regression: late-page '+name+' cannot establish unique fee authority',async()=>{
    const f=setup();let pages=0;f.state.page=offset=>{pages++;if(offset===0)return [f.box()];throw error;};
    await assert.rejects(captureMinimumFeeAuthority(f.config,f.ports),/fetch failed/);assert.equal(pages,2);
  });
test('a second eligible box on a later page rejects uniqueness',async()=>{
  const f=setup();let pages=0;const other=f.box();other.index=1;
  const parsed=wasm.ErgoBox.from_json(JSON.stringify({...other,boxId:undefined}));other.boxId=parsed.box_id().to_str();parsed.free();
  f.state.page=offset=>{pages++;return offset===0?[f.box()]:offset===50?[other]:[];};
  await assert.rejects(captureMinimumFeeAuthority(f.config,f.ports),/fetch failed/);assert.equal(pages,3);
});
test('a repeated box across pages rejects incomplete or unstable pagination',async()=>{
  const f=setup();let pages=0;f.state.page=()=>{pages++;return [f.box()];};
  await assert.rejects(captureMinimumFeeAuthority(f.config,f.ports),/fetch failed/);assert.equal(pages,2);
});
test('discovery has a finite total bound even for unique ineligible boxes',async()=>{
  const f=setup();let pages=0;f.state.page=offset=>{pages++;return Array.from({length:50},(_,i)=>({boxId:String(offset+i+1000).padStart(64,'0'),transactionId:id(3),assets:[]}));};
  await assert.rejects(captureMinimumFeeAuthority(f.config,f.ports),/fetch failed/);assert.equal(pages,21);
});
test('an oversized discovery page is rejected before box selection',async()=>{
  const f=setup();f.state.page=()=>Array.from({length:51},()=>f.box());
  await assert.rejects(captureMinimumFeeAuthority(f.config,f.ports),/fetch failed/);
});
test('terminal-page failure during closing discovery rejects a previous complete observation',async()=>{
  const f=setup();f.state.page=offset=>{if(offset===0)return [f.box()];if(f.state.networkReads===2)throw Error('closing page failure');return [];};
  await assert.rejects(captureMinimumFeeAuthority(f.config,f.ports),/fetch failed/);
});
test('equal activation heights retain upstream newest-row precedence',async()=>{
  const f=setup();f.state.values.R5=[[0,0],[0,0]];
  assert.equal((await captureMinimumFeeAuthority(f.config,f.ports)).feeConfig.bridgeFee,'300');
});
test('no applicable historical row rejects at earliest activation height',async()=>{
  const f=setup();f.state.values.R5=[[100,100],[200,200]];
  await assert.rejects(captureMinimumFeeAuthority(f.config,f.ports),/does not support height/);
});
for(const [name,change] of [
  ['wrong NFT',f=>f.state.mutateBox=b=>b.assets[0].tokenId=id(9)],
  ['wrong asset',f=>f.state.mutateBox=b=>b.assets[1].tokenId=id(9)],
  ['fee-token quantity',f=>f.state.mutateBox=b=>b.assets[0].amount='2'],
  ['asset marker quantity',f=>f.state.mutateBox=b=>b.assets[1].amount='2'],
  ['wrong tree',f=>f.config.expectedErgoTree='0008d3'],
  ['duplicate source',f=>f.state.duplicate=true],
  ['unconfirmed source',f=>f.state.confirmations=0],
  ['insufficient confirmations',f=>f.state.confirmations=1],
  ['noncanonical block',f=>f.state.canonical=id(9)],
  ['spent box',f=>f.state.spent=true],
  ['zero denominator',f=>f.state.values.R8[0][0][1]='0'],
  ['negative bridge fee',f=>f.state.values.R6[0][0]='-2'],
  ['negative network fee',f=>f.state.values.R7[0][0]='-2'],
  ['invalid ratio',f=>f.state.values.R9[0][0]='10001'],
  ['negative rsn ratio',f=>f.state.values.R8[0][0][0]='-2'],
  ['rsn ratio exceeds divisor',f=>f.state.values.R8[0][0][0]='101'],
  ['missing chain',f=>f.config.fromChain='bitcoin'],
  ['missing history',f=>f.config.sourceChainHeight=0],
  ['register dimensions',f=>f.state.values.R7[0].pop()],
  ['register type',f=>f.state.values.R5=[['0','0'],['100','100']]],
  ['unordered history',f=>f.state.values.R5=[[100,100],[0,0]]],
  ['duplicate chains',f=>f.state.values.R4=[Buffer.from('ergo'),Buffer.from('ergo')]],
  ['wrong network',f=>f.state.info.network='mainnet'],
  ['connected node',f=>f.state.info.peersCount=1],
  ['wrong node version',f=>f.state.info.appVersion='5.0.0'],
  ['remote endpoint',f=>f.config.nodeUrl='https://example.com'],
])test('rejects '+name,async()=>{const f=setup();change(f);await assert.rejects(captureMinimumFeeAuthority(f.config,f.ports));});
test('a policy edit during capture is rejected',async()=>{
  const f=setup();f.state.onNetworkRead=()=>{if(f.state.networkReads===2)f.state.values.R6[0][0]='101';};
  await assert.rejects(captureMinimumFeeAuthority(f.config,f.ports),/changed/);
});
test('a reorg during capture is rejected',async()=>{
  const f=setup();f.state.onTxRead=()=>{if(f.state.txReads===2){f.state.blockId=id(9);f.state.canonical=id(9);}};
  await assert.rejects(captureMinimumFeeAuthority(f.config,f.ports),/changed/);
});
test('a new duplicate at closing discovery is rejected',async()=>{
  const f=setup();f.state.onNetworkRead=()=>{if(f.state.networkReads===2)f.state.duplicate=true;};
  await assert.rejects(captureMinimumFeeAuthority(f.config,f.ports));
});
test('fresh capture fails closed after successful capture and later network failure',async()=>{
  const f=setup(),first=await captureMinimumFeeAuthority(f.config,f.ports);f.state.networkError=true;
  await assert.rejects(verifyMinimumFeeAuthority(f.config,first,f.ports),/fetch/);
});
test('upstream cached-reader baseline exposes why fetch false must be fatal',async()=>{
  const f=setup(),reader=new MinimumFeeBox(f.config.ergoTokenId,f.config.minFeeNFT,f.network,r=>wasm.Constant.decode_from_base16(r).to_js());
  assert.equal(await reader.fetchBox(),true);f.state.networkError=true;
  assert.equal(await reader.fetchBox(),false);assert.equal(reader.getFee('monero',100,'ergo').bridgeFee,100n);
});
test('all stable policy fields and fee fields are checked against fresh authority',async()=>{
  const f=setup(),first=await captureMinimumFeeAuthority(f.config,f.ports);
  for(const field of Object.keys(first.authority)){
    const changed=structuredClone(first);changed.authority[field]=typeof changed.authority[field]==='number'?changed.authority[field]+1:'edited';
    await assert.rejects(verifyMinimumFeeAuthority(f.config,changed,f.ports));
  }
  for(const field of Object.keys(first.feeConfig)){
    const changed=structuredClone(first);changed.feeConfig[field]='999';await assert.rejects(verifyMinimumFeeAuthority(f.config,changed,f.ports));
  }
  const changed=structuredClone(first);changed.digest=id(9);await assert.rejects(verifyMinimumFeeAuthority(f.config,changed,f.ports));
});
test('coordinated fee edit and recomputed snapshot digest still require live authority',async()=>{
  const f=setup(),first=await captureMinimumFeeAuthority(f.config,f.ports);
  const changed=structuredClone(first);changed.feeConfig.bridgeFee='999';
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  changed.digest=createHash('sha256').update(JSON.stringify(canonical({authority:changed.authority,feeConfig:changed.feeConfig}))).digest('hex');
  await assert.rejects(verifyMinimumFeeAuthority(f.config,changed,f.ports),/authority changed/);
});
