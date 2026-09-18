import test from 'node:test';
import assert from 'node:assert/strict';
import wasm from 'ergo-lib-wasm-nodejs';
import {bindProcessSourceFees,openProcessSource} from './process-source.mjs';

const id=n=>String(n).repeat(64),tree='0008cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
function setup(){
  const configuration={destinationAsset:id(2),bridgeFee:'100',networkFee:'20'},
    feeAuthority={nodeUrl:'http://127.0.0.1:19051',minFeeNFT:id(1),ergoTokenId:id(2),expectedErgoTree:tree,minConfirmations:2},
    state={bridge:'100',network:'20',ratio:'0',outage:false,rpcCalls:0,admissionCalls:0,retainedCalls:0};
  const candidate={sourceHeight:50};
  function box(){
    const values={R4:[Buffer.from('ergo'),Buffer.from('monero')],R5:[[0,0]],R6:[[state.bridge,'200']],R7:[[state.network,'30']],R8:[[['1','100'],['1','100']]],R9:[[state.ratio,'0']]};
    const additionalRegisters=Object.fromEntries(Object.entries(values).map(([k,v])=>[k,(k==='R4'?wasm.Constant.from_coll_coll_byte(v):wasm.Constant.from_js(v)).encode_to_base16()]));
    const raw={value:'1000000',ergoTree:tree,assets:[{tokenId:id(1),amount:'1'},{tokenId:id(2),amount:'1'}],additionalRegisters,creationHeight:490,transactionId:id(3),index:0};
    const parsed=wasm.ErgoBox.from_json(JSON.stringify(raw));const result={...raw,boxId:parsed.box_id().to_str()};parsed.free();return result;
  }
  const rpc=async route=>{
    state.rpcCalls++;if(state.outage)throw Error('fee authority unavailable');
    if(route==='/info')return {network:'devnet',appVersion:'6.0.3',peersCount:0,fullHeight:504};
    if(route.startsWith('/blockchain/box/unspent/byTokenId/')){
      const u=new URL(route,feeAuthority.nodeUrl);return u.pathname.endsWith(id(1))&&u.searchParams.get('offset')==='0'?[box()]:[];
    }
    if(route.startsWith('/blocks/at/'))return [id(4)];
    if(route.startsWith('/utxo/byId/'))return box();
    if(route.startsWith('/blockchain/transaction/byId/'))return {id:id(3),numConfirmations:5,blockId:id(4),inclusionHeight:500,outputs:[box()]};
    throw Error('Unexpected route '+route);
  };
  const admission={scope:'fixed-proof-scope',async inspect(){
    state.admissionCalls++;await state.duringAdmission?.();
    const amount=10000n,net=amount-BigInt(configuration.bridgeFee)-BigInt(configuration.networkFee);
    const result={status:'accepted',observation:{amount:amount.toString(),bridgeFee:configuration.bridgeFee,networkFee:configuration.networkFee},
      decision:{amount,destinationAmount:net},backing:{creditedAtomic:net.toString()}};
    state.mutateResult?.(result);return result;
  },async readRetainedBacking(_candidate,expected,signal){signal.throwIfAborted();state.retainedCalls++;return {backing:structuredClone(expected)};}};
  return {state,configuration,feeAuthority,candidate,open:()=>bindProcessSourceFees({admission,configuration,feeAuthority},{rpc,wasm}),signal:()=>new AbortController().signal};
}
test('sufficient proof-bound fees admit without changing credited amount',async()=>{
  const f=setup(),source=f.open(),result=await source.inspect(f.candidate,f.signal());
  assert.equal(result.status,'accepted');assert.equal(result.backing.creditedAtomic,'9880');assert.equal(result.decision.destinationAmount,9880n);
  assert.equal(source.scope,'fixed-proof-scope');assert.equal(f.state.admissionCalls,1);
  assert.equal((await source.verify(f.candidate,f.signal())).status,'accepted');
});
for(const [name,mutate] of [
  ['bridge minimum',f=>f.state.bridge='101'],
  ['network minimum',f=>f.state.network='21'],
  ['proportional bridge minimum',f=>f.state.ratio='101'],
  ['wrong NFT',f=>f.feeAuthority.minFeeNFT=id(9)],
  ['wrong script',f=>f.feeAuthority.expectedErgoTree='0008d3'],
  ['unavailable authority',f=>f.state.outage=true],
])test('new admission refuses '+name,async()=>{
  const f=setup();mutate(f);const source=f.open();await assert.rejects(source.inspect(f.candidate,f.signal()));
  assert.deepEqual(await source.verify(f.candidate,f.signal()),{status:'pending'});
});
test('a policy update during native admission invalidates the original capture',async()=>{
  const f=setup();f.state.duringAdmission=()=>{f.state.bridge='99';};
  await assert.rejects(f.open().inspect(f.candidate,f.signal()),/authority changed/);
});
test('fees above minimum and exactly meeting proportional charge are accepted',async()=>{
  const f=setup();f.configuration.bridgeFee='250';f.configuration.networkFee='50';f.state.ratio='250';
  assert.equal((await f.open().inspect(f.candidate,f.signal())).backing.creditedAtomic,'9700');
});
for(const field of ['amount','destinationAmount','creditedAtomic'])test('fee check never rewrites proof-bound '+field,async()=>{
  const f=setup();f.state.mutateResult=result=>{if(field==='creditedAtomic')result.backing[field]='9999';else result.decision[field]++;};
  await assert.rejects(f.open().inspect(f.candidate,f.signal()),/proof-bound/);
});
test('retained liability reads neither reprice nor require available fee authority',async()=>{
  const f=setup(),source=f.open(),accepted=await source.inspect(f.candidate,f.signal()),before=f.state.rpcCalls;
  f.state.outage=true;f.state.bridge='999999';f.state.ratio='10000';
  assert.deepEqual(await source.readRetainedBacking(f.candidate,accepted.backing,f.signal()),{backing:accepted.backing});
  assert.equal(f.state.rpcCalls,before);assert.equal(f.state.retainedCalls,1);
});
test('every process descriptor requires explicit fee policy before runtime access',async()=>{
  await assert.rejects(openProcessSource({certificateDirectory:'x',configuration:{},deliveryDirectory:'x',endpoints:[],genesis:id(1),nativeOptions:{}}),/descriptor/);
  const f=setup();assert.throws(()=>bindProcessSourceFees({admission:{},configuration:f.configuration}),/policy/);
  f.feeAuthority.ergoTokenId=id(9);assert.throws(f.open,/asset/);
});
test('cancellation after asynchronous admission prevents accepted return',async()=>{
  const f=setup(),abort=new AbortController();f.state.duringAdmission=()=>abort.abort();
  await assert.rejects(f.open().inspect(f.candidate,abort.signal));
});
