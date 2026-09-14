import test from 'node:test';
import assert from 'node:assert/strict';
import {assertTransactionAbsent} from './collisionFixture.mjs';
test('native missing-transaction response may omit an empty txs array',()=>{
  const id='11'.repeat(32),base={status:'OK',missed_tx:[id]};
  assert.doesNotThrow(()=>assertTransactionAbsent(base,id));
  assert.doesNotThrow(()=>assertTransactionAbsent({...base,txs:[]},id));
  for(const bad of [{...base,txs:[{in_pool:true}]},{...base,txs:null},{...base,missed_tx:[]},{...base,missed_tx:['22'.repeat(32)]},{...base,status:'BUSY'}]){
    assert.throws(()=>assertTransactionAbsent(bad,id));
  }
});
