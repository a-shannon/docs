import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodeIntent} from '../packages/monero-deposit/lib/intentCodec.ts';
import {encodeDepositMemo,decodeDepositMemo,verifyMemoIntent,verifyDeliveryMode,decodeDepositData,encodeDepositEnvelope,decodeDepositEnvelope,loadDepositEnvelope} from './depositDelivery.mjs';

const memo={genesis:'11'.repeat(32),vaultSpend:'22'.repeat(32),sourceNetwork:'mainnet',destinationNetwork:'ergo-testnet',vaultEpoch:'1',
  destinationAsset:'33'.repeat(32),amount:'500000240',bridgeFee:'100',networkFee:'20',expiryHeight:'1000',recipient:'3WwfGbtNEMusQ91apEz1k7EQFQuK1e1FZVD3ouZj9xdt1byEQ8st'};
const intent={version:2,domain:'rosen-monero-deposit',source_network:memo.sourceNetwork,vault_epoch:memo.vaultEpoch,vault_address:'fixture-vault',
  destination_network:memo.destinationNetwork,destination_asset:memo.destinationAsset,bridge_fee:memo.bridgeFee,network_fee:memo.networkFee,
  txid:'44'.repeat(32),to_address:memo.recipient,amount:memo.amount,expiry_height:1000n,outputs:[{output_index:1n,output_public_key:'55'.repeat(32),amount:memo.amount}]};
// Shape-only proof; cryptographic proof validation is exercised by the node test.
const request={intentBytes:encodeIntent(intent),proof:'OutProofV2'+'1'.repeat(132)};

test('single memo has deterministic bytes and fits the wallet data limit',()=>{
  const bytes=encodeDepositMemo(memo);assert.equal(bytes.length,143+memo.recipient.length);
  assert.deepEqual(decodeDepositMemo(bytes),memo);assert.equal(bytes.subarray(0,6).toString('hex'),'524d44310001');
  assert.equal(bytes.subarray(102,110).toString('hex'),'0000000000000001');
  assert.equal(encodeDepositMemo({...memo,recipient:'a'.repeat(110)}).length,253);
  assert.throws(()=>encodeDepositMemo({...memo,recipient:'a'.repeat(111)}),/recipient/);
});
test('bridge data is unambiguous and the guard requires memo and delivery together',()=>{
  const hex=encodeDepositMemo(memo).toString('hex');
  assert.equal(decodeDepositData(['abcd']),undefined);assert.equal(decodeDepositData([]),undefined);
  assert.deepEqual(decodeDepositData([hex]),memo);
  assert.throws(()=>decodeDepositData([hex,hex]),/ambiguous memo/);
  assert.throws(()=>decodeDepositData([hex,'abcd']),/ambiguous memo/);
  assert.throws(()=>decodeDepositData(['524d4432'+hex.slice(8)]),/Memo version/);
  verifyDeliveryMode(undefined,undefined);verifyDeliveryMode(hex,()=>{});
  assert.throws(()=>verifyDeliveryMode(hex,undefined),/memo\/delivery mode/);
  assert.throws(()=>verifyDeliveryMode(undefined,()=>{}),/memo\/delivery mode/);
});
test('memo rejects unknown versions, networks, truncation, trailing bytes and non-ASCII recipients',()=>{
  const bytes=encodeDepositMemo(memo);
  for(const [index,value]of [[0,0],[4,3],[5,0],[143,255]]){const altered=Buffer.from(bytes);altered[index]=value;assert.throws(()=>decodeDepositMemo(altered));}
  assert.throws(()=>decodeDepositMemo(bytes.subarray(0,-1)),/trailing\/truncated/);
  assert.throws(()=>decodeDepositMemo(Buffer.concat([bytes,Buffer.from([0])])),/trailing\/truncated/);
  assert.throws(()=>encodeDepositMemo({...memo,amount:'18446744073709551616'}),/uint64/);
  assert.throws(()=>encodeDepositMemo({...memo,bridgeFee:memo.amount}),/positive net/);
  assert.throws(()=>encodeDepositMemo({...memo,amount:'0500000240'}),/uint64/);
  assert.throws(()=>encodeDepositMemo({...memo,unused:1}),/schema/);
});
test('every overlapping pre-transaction field must match the final output intent',()=>{
  verifyMemoIntent(memo,intent,memo);
  const mutations={source_network:'testnet',destination_network:'ergo',vault_epoch:'2',destination_asset:'66'.repeat(32),amount:'500000241',
    bridge_fee:'101',network_fee:'21',expiry_height:1001n,to_address:'changed'};
  for(const [field,value]of Object.entries(mutations))assert.throws(()=>verifyMemoIntent(memo,{...intent,[field]:value},memo),new RegExp('Memo intent '+field));
  assert.throws(()=>verifyMemoIntent(memo,intent,{...memo,genesis:'77'.repeat(32)}),/Memo genesis/);
  assert.throws(()=>verifyMemoIntent(memo,intent,{...memo,vaultSpend:'77'.repeat(32)}),/Memo vault spend/);
  assert.throws(()=>verifyMemoIntent(memo,{...intent,outputs:[...intent.outputs,...intent.outputs]},memo),/single output/);
});
test('delivery binds canonical intent/proof bytes to the discovered transaction and memo',async()=>{
  const bytes=encodeDepositEnvelope(request),decoded=await decodeDepositEnvelope(bytes,intent.txid,memo,memo);
  assert.deepEqual(decoded.intentBytes,request.intentBytes);assert.equal(decoded.proof,request.proof);
  await assert.rejects(decodeDepositEnvelope(bytes,'66'.repeat(32),memo,memo),/Delivery transaction/);
  await assert.rejects(decodeDepositEnvelope(bytes,intent.txid,{...memo,recipient:'changed'},memo),/Memo intent to_address/);
  await assert.rejects(decodeDepositEnvelope(Buffer.concat([bytes,Buffer.from(' ')]),intent.txid,memo,memo),/canonical envelope/);
  await assert.rejects(decodeDepositEnvelope(Buffer.from(JSON.stringify([Buffer.from(request.intentBytes).toString('hex'),''])),intent.txid,memo,memo),/proof encoding/);
  await assert.rejects(decodeDepositEnvelope(Buffer.alloc(74001),intent.txid,memo,memo),/envelope size/);
});
test('a fresh reader recovers exact delivery bytes; absent or corrupt evidence cannot yield a request',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'monero-delivery-test-'));
  await assert.rejects(loadDepositEnvelope(directory,intent.txid,memo,memo),/ENOENT/);
  writeFileSync(join(directory,intent.txid+'.proof'),encodeDepositEnvelope(request),{flag:'wx'});
  const first=await loadDepositEnvelope(directory,intent.txid,memo,memo),second=await loadDepositEnvelope(directory,intent.txid,memo,memo);
  assert.deepEqual(first,second);assert.notEqual(first.intentBytes,second.intentBytes);
  await assert.rejects(loadDepositEnvelope(directory,'../escape',memo,memo),/Delivery hash/);
});
