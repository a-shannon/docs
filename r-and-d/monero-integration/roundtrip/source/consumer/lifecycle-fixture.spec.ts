import {launchNative,MoneroChain} from './adapter';
import {setFixtureChain} from './resolver';
import {fromJson,verify,getTxDataHash} from './integration';
it('actual retained producer is revoked by observed lifecycle fault',async()=>{
 const chain=await MoneroChain.create();setFixtureChain(chain);const owner=await launchNative();const tx=owner.transaction;
 try {const text=tx.toJson();expect(await verify(tx)).toBe(true);await new Promise(resolve=>setTimeout(resolve,600));expect(()=>tx.toJson()).toThrow();expect(()=>tx.txBytes).toThrow();expect(()=>fromJson(text)).toThrow();expect(()=>getTxDataHash(tx)).toThrow();expect(()=>chain.extractTransactionOrder(tx)).toThrow();await expect(chain.getTransactionAssets(tx)).rejects.toThrow();await expect(verify(tx)).rejects.toThrow();}
 finally{await owner.close();setFixtureChain(undefined);}
});
