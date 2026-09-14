import test from 'node:test';
import assert from 'node:assert/strict';
import {fundPreparedDeposit} from './participantDepositFunding.mjs';
const hex=n=>String(n).repeat(64);
const projection=()=>({type:'deposit-prepared',id:1,genesis:hex(1),vaultAddress:'fixture-address',deposit:{txId:hex(2),txBytes:'abcd',outputKey:hex(3),outputIndex:0,amountAtomic:'500000240',feeAtomic:'100'}});
function fixture(changePrepared=()=>{},changeFunded=()=>{}){
  const prepared=projection(),funded={type:'funded',id:1,genesis:prepared.genesis,vaultAddress:prepared.vaultAddress,source:{kind:'deposit',deposit:{...prepared.deposit,blockHeight:100,blockHash:hex(4),chainIndex:123}}};
  changePrepared(prepared);changeFunded(funded);const sent=[],frames=[prepared,funded];
  return {sent,actor:{async send(v){sent.push(v);},async next(){return frames.shift();}},funded};
}
test('copy callback completes before the exact retained deposit is submitted',async()=>{
  const f=fixture();let release;const wait=new Promise(resolve=>{release=resolve;});
  const run=fundPreparedDeposit(f.actor,'fixture-directory',hex(5),async({vault,deposit})=>{
    assert.equal(vault.groupKey,hex(5));assert.equal(deposit.txId,hex(2));
    assert.deepEqual(Object.keys(deposit).sort(),['amountAtomic','feeAtomic','outputIndex','outputKey','txBytes','txId']);
    assert(Object.isFrozen(deposit));assert(Object.isFrozen(vault));await wait;
  });
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.sent,[{type:'prepare-deposit',runtimeDirectory:'fixture-directory'}]);
  release();assert.equal(await run,f.funded);assert.deepEqual(f.sent[1],{type:'submit-deposit',txId:hex(2)});
});
test('failed copy setup never requests honest submission',async()=>{
  const f=fixture();await assert.rejects(fundPreparedDeposit(f.actor,'fixture-directory',hex(5),async()=>{throw Error('copy failed');}),/copy failed/);
  assert.equal(f.sent.length,1);
});
test('private or invented inclusion fields in preparation refuse before the callback',async()=>{
  for(const field of ['donorKey','blockHeight','chainIndex']){
    const f=fixture(p=>{p.deposit[field]=0;});let calls=0;
    await assert.rejects(fundPreparedDeposit(f.actor,'fixture-directory',hex(5),async()=>{calls++;}),/Prepared deposit schema/);
    assert.equal(calls,0);assert.equal(f.sent.length,1);
  }
});
test('each prepared identity field is retained through actual inclusion',async()=>{
  const changes={txId:hex(6),txBytes:'abce',outputKey:hex(6),outputIndex:1,amountAtomic:'500000241',feeAtomic:'101'};
  for(const [field,value]of Object.entries(changes)){
    const f=fixture(()=>{},v=>{v.source.deposit[field]=value;});
    await assert.rejects(fundPreparedDeposit(f.actor,'fixture-directory',hex(5),async()=>{}),/Prepared deposit changed/);
    assert.equal(f.sent.length,2);
  }
});
test('genesis or vault substitution in the funded frame refuses',async()=>{
  for(const field of ['genesis','vaultAddress']){
    const f=fixture(()=>{},v=>{v[field]='different';});
    await assert.rejects(fundPreparedDeposit(f.actor,'fixture-directory',hex(5),async()=>{}),/Prepared deposit changed/);
  }
});
test('preparation rejects malformed amount, output index and transaction bytes',async()=>{
  for(const [field,value]of [['amountAtomic','0'],['outputIndex',2],['txBytes','ABCD']]){
    const f=fixture(p=>{p.deposit[field]=value;});let calls=0;
    await assert.rejects(fundPreparedDeposit(f.actor,'fixture-directory',hex(5),async()=>{calls++;}),/Prepared deposit profile/);
    assert.equal(calls,0);assert.equal(f.sent.length,1);
  }
});
