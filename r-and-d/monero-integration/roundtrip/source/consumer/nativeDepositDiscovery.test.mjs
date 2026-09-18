import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeDepositMemo} from './depositDelivery.mjs';
import {discoveredCandidate,createNativeDepositDecoder} from './nativeDepositDiscovery.mjs';
const h=n=>n.toString(16).padStart(64,'0');
const policy={genesis:h(1),vaultSpend:h(2),vaultEpoch:'1',destinationAsset:h(3)};
const memo={...policy,sourceNetwork:'mainnet',destinationNetwork:'ergo-testnet',amount:'1000',bridgeFee:'100',networkFee:'20',expiryHeight:'9000',recipient:'recipient'};
const transaction={txId:h(4),transactionHex:'aabb'};
const response=value=>({txId:transaction.txId,data:[encodeDepositMemo(value).toString('hex')]});
test('canonical native metadata selects only the configured deposit profile',()=>{
  assert.deepEqual(discoveredCandidate(transaction,response(memo),policy),transaction);
  assert.equal(discoveredCandidate(transaction,{txId:transaction.txId,data:[]},policy),undefined);
  assert.equal(discoveredCandidate(transaction,{txId:transaction.txId,data:['abcd']},policy),undefined);
});
for(const [key,value]of Object.entries({genesis:h(9),vaultSpend:h(9),vaultEpoch:'2',destinationAsset:h(9),sourceNetwork:'testnet'}))
  test('other deposit profile does not consume candidate capacity: '+key,()=>{
    assert.equal(discoveredCandidate(transaction,response({...memo,[key]:value}),policy),undefined);
  });
test('malformed recognized or ambiguous on-chain memo does not stall unrelated deposits',()=>{
  const valid=response(memo);valid.data.push('abcd');
  assert.equal(discoveredCandidate(transaction,valid,policy),undefined);
  for(const data of ['524d44','524d4432','524d4431ff'])
    assert.equal(discoveredCandidate(transaction,{txId:transaction.txId,data:[data]},policy),undefined);
});
test('unbound or malformed parser response is an error, not an empty candidate batch',()=>{
  assert.throws(()=>discoveredCandidate(transaction,{...response(memo),txId:h(9)},policy),/binding/);
  assert.throws(()=>discoveredCandidate(transaction,{...response(memo),extra:1},policy),/response/);
  for(const data of [null,['zz'],[''],['aa'.repeat(255)]])
    assert.throws(()=>discoveredCandidate(transaction,{txId:transaction.txId,data},policy),/shape/);
});
test('configured parser requires explicit pins, bounded timeout and complete policy',()=>{
  assert.throws(()=>createNativeDepositDecoder({binary:'relative',sha256:h(9),policy}));
  assert.throws(()=>createNativeDepositDecoder({binary:process.execPath,sha256:h(9),policy,timeoutMs:30001}));
  assert.throws(()=>createNativeDepositDecoder({binary:process.execPath,sha256:h(9),policy:{...policy,extra:1}}));
});
