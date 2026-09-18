import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {verifyRewardPayment} from './reward-payment-authority.mjs';
const h=n=>n.toString(16).padStart(64,'0'),sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
  const expectation=Buffer.from('sealed verification fixture'),canonicalRequest=JSON.stringify({netAtomicAmount:'900'}),digest=sha(canonicalRequest);
  const value={anchor:{reservation:{reservationId:h(1),requestJson:JSON.stringify({canonicalRequest,requestDigest:digest})},expectationDigest:sha(expectation),bindingDigest:h(2),requestDigest:digest},
    evidence:{expectationHex:expectation.toString('hex'),terminalHex:'abcd'},source:{genesis:h(3),endpoints:['http://127.0.0.1:18001','http://127.0.0.1:18002']},
    directory:fs.mkdtempSync(path.join(os.tmpdir(),'reward-payment-check-')),binary:'test-only',sha256:h(4),paymentTxId:h(5)};
  const final={expectationDigest:value.anchor.expectationDigest,binding:h(2),txId:h(5),bytesHex:'1234',byteDigest:sha(Buffer.from('1234','hex'))};
  const observed={type:'observed',txId:h(5),blockHeight:10,blockHash:h(6),recipientAtomic:'900',inputAtomic:'1200',feeAtomic:'20',changeAtomic:'280',
    recipientOutputKey:h(7),changeOutputKey:h(8),recipientOutputIndex:0,changeOutputIndex:1};
  const info={status:'OK',nettype:'fakechain',offline:true,untrusted:false,mainnet:false,testnet:false,stagenet:false,incoming_connections_count:0,outgoing_connections_count:0,height:12};
  const row={tx_hash:h(5),as_hex:'1234',in_pool:false,block_height:10},state={calls:0,observePatch:()=>{},rpcPatch:()=>{}};
  const ports={recover:async()=>structuredClone(final),observe:async(...args)=>{const result=structuredClone(observed);state.observePatch(result,args);return result;},
    rpc:async(endpoint,method,params)=>{state.calls++;let result=method==='get_info'?structuredClone(info):method==='get_transactions'?{txs:[structuredClone(row)]}:
      {block_header:{hash:params.height===0?h(3):h(6)}};state.rpcPatch(result,{endpoint,method,params});return result;}};
  return {value,final,observed,info,row,state,ports,run:()=>verifyRewardPayment(value,ports)};
}
test('two independent reads bind sealed payout bytes and confirmed actual amount; retained transcripts reopen',async()=>{
  const f=fixture(),first=await f.run(),second=await f.run();assert.deepEqual(first,second);assert.equal(first.paymentTxId,h(5));assert.equal(first.recipientAtomic,'900');
});
for(const [name,mutate,reason] of [
  ['expectation digest',f=>f.value.evidence.expectationHex='abcd',/Reward expectation anchor/],
  ['terminal replacement on restart',async f=>{await f.run();f.value.evidence.terminalHex='dead';},/Reward retained transcript conflict/],
  ['canonical request',f=>f.value.anchor.reservation.requestJson=JSON.stringify({canonicalRequest:'{}'}),/Reward retained request/],
  ['recovered binding',f=>f.final.binding=h(99),/Reward recovered binding/],
  ['recovered expectation',f=>f.final.expectationDigest=h(99),/Reward recovered expectation/],
  ['recovered transaction',f=>f.final.txId=h(99),/Reward recovered payment/],
  ['recovered bytes',f=>f.final.bytesHex='5678',/Reward final bytes/],
  ['paid amount',f=>f.observed.recipientAtomic='901',/Reward paid amount/],
  ['observed transaction',f=>f.observed.txId=h(99),/Reward observed payment/],
  ['daemon bytes',f=>f.row.as_hex='5678',/Reward daemon bytes/],
  ['daemon transaction',f=>f.row.tx_hash=h(99),/Reward daemon payment/],
  ['mempool payout',f=>f.row.in_pool=true,/Reward payment unconfirmed/],
  ['confirmation count',f=>f.info.height=11,/Reward payment confirmations/],
  ['inclusion height',f=>f.row.block_height=9,/Reward payment inclusion/],
  ['live network',f=>f.info.nettype='mainnet',/Reward daemon isolation/],
  ['genesis',f=>f.value.source.genesis=h(99),/Reward daemon genesis/],
  ['native block',f=>f.observed.blockHash=h(99),/Reward canonical payment/],
  ['endpoint disagreement',f=>f.state.observePatch=(o,args)=>{if(args.at(-1)==='18002')o.changeAtomic='279';},/Reward endpoint disagreement/],
  ['same endpoint twice',f=>f.value.source.endpoints[1]=f.value.source.endpoints[0],/Reward endpoints/],
  ['remote endpoint',f=>f.value.source.endpoints[1]='https://example.test:443',/Reward local endpoint/],
])test('refuses '+name,async()=>{const f=fixture();await mutate(f);await assert.rejects(f.run(),reason);});
