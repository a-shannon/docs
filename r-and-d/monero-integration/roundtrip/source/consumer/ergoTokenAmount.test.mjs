import assert from 'node:assert/strict';
import {test} from 'node:test';
import wasm from 'ergo-lib-wasm-nodejs';
import {assertErgoTokenAmount,checkedErgoCreditAmounts,ERGO_ASSET_AMOUNT_LIMIT} from './ergoTokenAmount.mjs';

test('admission amount bounds agree with Ergo WASM token construction',()=>{
  for(const amount of [-1n,0n,1n,ERGO_ASSET_AMOUNT_LIMIT,ERGO_ASSET_AMOUNT_LIMIT+1n]){
    const accepted=amount>=1n&&amount<=ERGO_ASSET_AMOUNT_LIMIT;
    const policy=()=>assertErgoTokenAmount(amount,'recipient');
    const construct=()=>wasm.TokenAmount.from_i64(wasm.I64.from_str(String(amount)));
    if(accepted){
      assert.equal(policy(),amount);
      const native=construct();assert.equal(native.as_i64().to_str(),String(amount));native.free();
    }else{
      assert.throws(policy,/Ergo token recipient amount/);
      assert.throws(construct);
    }
  }
});

test('gross may exceed signed output limit when both Ergo credit outputs fit',()=>{
  const limit=ERGO_ASSET_AMOUNT_LIMIT;
  assert.deepEqual(checkedErgoCreditAmounts(limit+120n,100n,20n),{fee:120n,net:limit});
  assert.deepEqual(checkedErgoCreditAmounts(limit+1n,limit,0n),{fee:limit,net:1n});
  assert.throws(()=>checkedErgoCreditAmounts(limit+121n,100n,20n),/Ergo token recipient amount/);
  assert.throws(()=>checkedErgoCreditAmounts(limit+2n,limit+1n,0n),/Ergo token fee amount/);
  assert.throws(()=>checkedErgoCreditAmounts(1000n,0n,0n),/Ergo token fee amount/);
});
