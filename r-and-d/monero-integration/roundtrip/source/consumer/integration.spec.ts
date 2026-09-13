import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {PaymentTransaction,SigningStatus,TransactionType} from '@rosen-chains/abstract-chain';
import {blake2b} from 'blakejs';
import {launchNative,MoneroChain,OfflineNetwork} from './adapter';
import {canonical} from './codec';
import {setFixtureChain,getChain} from './resolver';
import {fromJson,getTxDataHash,verify} from './integration';
import {trace} from './trace';
describe('actual retained native to original Rosen common verifier',()=>{
 it('issues, consumes immutable candidate, rejects unadmitted data and revokes observed close',async()=>{
  const chain=await MoneroChain.create();setFixtureChain(chain);
  const owner=await launchNative();const tx=owner.transaction;
  try {
   expect(tx).toBeInstanceOf(PaymentTransaction);expect(Object.isFrozen(tx)).toBe(true);
   const text=tx.toJson();const hash=getTxDataHash(tx);
   expect(hash).toBe(Buffer.from(blake2b(text,undefined,32)).toString('hex'));
   const restored=fromJson(text);expect(restored.toJson()).toBe(text);
   expect(await verify(restored)).toBe(true);expect(chain.calls).toEqual(['consistency','fee','no-burn','extra']);
   const order=chain.extractTransactionOrder(tx);const assets=await chain.getTransactionAssets(tx);
   expect(order).toHaveLength(1);expect(order[0].assets.nativeToken).toBeGreaterThan(0n);expect(assets.inputAssets.nativeToken).toBeGreaterThan(assets.outputAssets.nativeToken);expect(chain.getMinimumNativeToken()).toBe(0n);
   const bytes=tx.txBytes;bytes.fill(0);expect(tx.toJson()).toBe(text);
   for(const key of ['network','eventId','txId','txType','txBytes','toJson'])expect(()=>Object.defineProperty(tx,key,{value:'mutated'})).toThrow();
   expect(()=>Object.setPrototypeOf(tx,{})).toThrow();
   order[0].address='changed';order[0].assets.nativeToken=0n;order[0].assets.tokens.push({id:'bad',value:1n});assets.inputAssets.nativeToken=0n;assets.outputAssets.tokens.push({id:'bad',value:1n});
   expect(chain.extractTransactionOrder(tx)[0].assets.nativeToken).toBeGreaterThan(0n);expect((await chain.getTransactionAssets(tx)).outputAssets.tokens).toEqual([]);
   expect(await verify(tx)).toBe(true);expect(getTxDataHash(tx)).toBe(hash);
   const fake=new PaymentTransaction('monero',tx.txId,tx.eventId,tx.txBytes,TransactionType.payment);expect(()=>chain.extractTransactionOrder(fake)).toThrow();expect(()=>getTxDataHash(fake)).toThrow();await expect(verify(fake)).rejects.toThrow();
   const changed=Buffer.from(tx.txBytes);changed[7]^=1;const id=createHash('sha256').update('W1h/local-native-proposal/v1\0','ascii').update(changed.subarray(0,-32)).digest();id.copy(changed,changed.length-32);
   expect(()=>fromJson(canonical(tx.eventId,changed.toString('hex'),id.toString('hex')))).toThrow('Unadmitted');
   for(const invalid of [text+' ',text.replace('"network":"monero"','"network":"unknown"'),text.replace('{','{"eventId":"00",'),text.replace('"payment"','"reward"')])expect(()=>fromJson(invalid)).toThrow();
   expect(()=>getChain('unknown')).toThrow();expect(chain.verifyTransactionExtraConditions(tx,SigningStatus.Signed)).toBe(false);
   await expect(new OfflineNetwork().getHeight()).rejects.toThrow();await expect(chain.signTransaction()).rejects.toThrow();await expect(chain.submitTransaction()).rejects.toThrow();await expect(chain.generateMultipleTransactions()).rejects.toThrow();
   const pending=chain.verifyPaymentTransaction(tx);const closing=owner.close();await expect(pending).rejects.toThrow();await closing;
   expect(()=>chain.extractTransactionOrder(tx)).toThrow();expect(()=>tx.toJson()).toThrow();expect(()=>fromJson(text)).toThrow();expect(()=>getTxDataHash(tx)).toThrow();await expect(verify(tx)).rejects.toThrow();
  } finally {await owner.close();setFixtureChain(undefined);}
 });
 it('generation replacement never revives old objects and explicit cancellation revokes after awaits',async()=>{
  const chain=await MoneroChain.create();setFixtureChain(chain);const first=await launchNative();const old=first.transaction;const text=old.toJson();const controller=new AbortController();
  const replacement=launchNative(controller.signal);expect(()=>old.toJson()).toThrow();await expect(verify(old)).rejects.toThrow();
  const next=await replacement;
  try {expect(await verify(next.transaction)).toBe(true);expect(()=>fromJson(text)).toThrow();const pending=chain.verifyTransactionFee(next.transaction);controller.abort();await expect(pending).rejects.toThrow();expect(()=>chain.extractTransactionOrder(next.transaction)).toThrow();await expect(verify(next.transaction)).rejects.toThrow();}
  finally{await first.close();await next.close();setFixtureChain(undefined);}
 });
 afterAll(()=>{const req=createRequire(import.meta.url);for(const path of Object.keys(req.cache).filter(p=>p.includes('node_modules'))){const raw=readFileSync(path);trace('cjs-load',{path:path.replaceAll('\\','/'),bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')});}});
});
