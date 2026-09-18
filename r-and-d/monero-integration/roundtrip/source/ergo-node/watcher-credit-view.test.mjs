import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createECDH} from 'node:crypto';
import {MoneroCreditAssignment as Ledger,committeeConfigDigest} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {openWatcherStore} from './watcher-runtime.mjs';
import {openWatcherCreditView} from './watcher-credit-view.mjs';
const h=n=>n.toString(16).padStart(2,'0').repeat(32);
const keys=[1,2,3,4].map(n=>{const k=createECDH('secp256k1');k.setPrivateKey(Buffer.from(n.toString(16).padStart(64,'0'),'hex'));return k.getPublicKey('hex','compressed');});
const backing={version:2,genesis:h(1),committeeDigest:h(2),vaultSpend:h(3),vaultAddress:'vault',intentHash:h(4),txId:h(5),blockHash:h(6),blockHeight:10,outputIndex:1,globalIndex:12,outputKey:h(7),keyImage:h(8),amountAtomic:'1000',destinationNetwork:'ergo-testnet',destinationAsset:h(9),recipient:'recipient',creditedAtomic:'900'};
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'watcher-novelty-')),handles=[];
  const entries=keys.map((guardKey,i)=>{const configuration={custodyDomain:'local-monero-genesis:'+backing.genesis,guardKey,committeeKeys:keys,quorum:3,maxFaults:1,activationId:'activation',policyEpoch:'1',policyDigest:h(10),backingPolicy:'single-deposit-v2'},file=join(directory,'guard-'+i+'.sqlite');
    const ledger=Ledger.create(file,configuration);handles.push(ledger);const {dev,ino}=lstatSync(file);return {file,configuration,identity:{dev,ino}};});
  const store=openWatcherStore(join(directory,'watcher.sqlite'));handles.push(store);
  const view=openWatcherCreditView({entries,committeeKeys:keys,remember:rows=>store.creditContinuity(rows)});handles.push(view);
  t.after(()=>handles.reverse().forEach(handle=>handle.close()));
  const request=(value=backing)=>({binding:{obligationId:'claim',creditTransactionDigest:h(11),sourceIntentDigest:value.intentHash,triggerBoxId:h(12),policyDigest:h(10),committeeDigest:committeeConfigDigest(entries[0].configuration)},outputs:[{sourceNetwork:'mainnet',publicKey:value.outputKey}],backing:value});
  return {directory,entries,ledgers:handles.slice(0,4),store,view,request};
}
test('all four current ledgers must report new backing without a write',t=>{const f=fixture(t),before=f.ledgers.map(l=>l.checkpoint());f.view.assertNew(backing);assert.deepEqual(f.ledgers.map(l=>l.checkpoint()),before);});
for(const kind of ['P','I','invalidated'])test('watcher rejects retained '+kind+' even with a changed transaction/intent',t=>{const f=fixture(t);f.view.assertNew(backing);const r=f.request();f.ledgers[2].assign(r);if(kind==='invalidated')f.ledgers[2].invalidate('claim','source-changed');const other={...backing,txId:h(20),intentHash:h(21),...(kind==='P'?{keyImage:h(22)}:kind==='I'?{outputKey:h(23)}:{})};assert.throws(()=>f.view.assertNew(other),/Watcher backing already claimed/);});
test('a fresh watcher reader reuses durable continuity, refusing rollback and same-revision drift',t=>{const f=fixture(t);f.view.assertNew(backing);const row={guardKey:keys[0],identity:f.entries[0].identity,checkpoint:f.ledgers[0].checkpoint()};f.store.creditContinuity([{...row,checkpoint:{...row.checkpoint,revision:1}}]);assert.throws(()=>f.view.assertNew(backing),/Watcher credit revision regressed/);assert.throws(()=>f.store.creditContinuity([{...row,checkpoint:{...row.checkpoint,revision:1,stateDigest:h(30)}}]),/Watcher credit state drift/);});
test('the operator roster cannot be shortened, reordered, duplicated or rebound',t=>{const f=fixture(t);for(const entries of [f.entries.slice(1),[f.entries[1],f.entries[0],...f.entries.slice(2)],[f.entries[0],f.entries[0],...f.entries.slice(2)],f.entries.map((e,i)=>i?e:{...e,identity:{dev:0,ino:0}})])assert.throws(()=>openWatcherCreditView({entries,committeeKeys:keys,remember:()=>{}}));});
