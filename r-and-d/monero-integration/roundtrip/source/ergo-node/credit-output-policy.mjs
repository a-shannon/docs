import assert from 'node:assert/strict';
import * as wasm from 'ergo-lib-wasm-nodejs';

const value=box=>BigInt(box.value().as_i64().to_str());
const assets=box=>{
  const tokens=box.tokens(),result=[];
  for(let i=0;i<tokens.len();i++){const t=tokens.get(i);result.push([t.id().to_str(),BigInt(t.amount().as_i64().to_str())]);}
  assert.equal(new Set(result.map(([id])=>id)).size,result.length,'Credit duplicate token');
  return result.sort(([a],[b])=>a.localeCompare(b));
};
const registers=box=>Array.from({length:6},(_,i)=>box.register_value(i+4)?.encode_to_base16()??null);
const tree=address=>wasm.Address.from_base58(address).to_ergo_tree().to_base16_bytes();
function totals(boxes){
  let erg=0n;const tokens=new Map();
  for(const box of boxes){erg+=value(box);for(const [id,amount] of assets(box))tokens.set(id,(tokens.get(id)??0n)+amount);}
  return {erg,tokens:[...tokens].sort(([a],[b])=>a.localeCompare(b))};
}

/** Complete local payment policy, including the outputs hidden by order extraction. */
export function verifyCreditOutputs({unsigned,inputs,order,lockTree,feeTree,assetId,fee=1100000n}){
  const candidates=unsigned.output_candidates(),outputs=Array.from({length:candidates.len()},(_,i)=>candidates.get(i));
  // Pinned generator emits the exact order, two Lock changes, then one fee.
  assert.equal(outputs.length,order.length+3,'Credit complete output count');
  for(let i=0;i<order.length;i++){
    const box=outputs[i],payment=order[i];
    assert.equal(box.ergo_tree().to_base16_bytes(),tree(payment.address),'Credit payment script');
    assert.equal(value(box),payment.assets.nativeToken,'Credit payment ERG');
    assert.deepEqual(assets(box),payment.assets.tokens.map(t=>[t.id,t.value]).sort(([a],[b])=>a.localeCompare(b)),'Credit payment tokens');
    const extra=payment.extra===undefined?null:wasm.Constant.from_byte_array(Buffer.from(payment.extra,'hex')).encode_to_base16();
    assert.deepEqual(registers(box),[extra,null,null,null,null,null],'Credit payment registers');
  }
  for(const box of outputs.slice(order.length,-1)){
    assert.equal(box.ergo_tree().to_base16_bytes(),lockTree,'Credit change script');
    assert(value(box)>=1000000n,'Credit change minimum');
    assert(assets(box).every(([id])=>id===assetId),'Credit change assets');
    assert.deepEqual(registers(box),[null,null,null,null,null,null],'Credit change registers');
  }
  const miner=outputs.at(-1);
  assert.equal(miner.ergo_tree().to_base16_bytes(),feeTree,'Credit sole miner script');
  assert.equal(outputs.filter(b=>b.ergo_tree().to_base16_bytes()===feeTree).length,1,'Credit sole miner fee');
  assert.equal(value(miner),fee,'Credit miner amount');assert.deepEqual(assets(miner),[],'Credit miner assets');
  assert.deepEqual(registers(miner),[null,null,null,null,null,null],'Credit miner registers');
  assert.deepEqual(totals(outputs),totals(inputs),'Credit complete ERG/token conservation');
  return true;
}
