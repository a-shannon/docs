import {launchNative,MoneroChain} from './adapter';
import {setFixtureChain} from './resolver';
import {verify} from './integration';
import {SigningStatus} from '@rosen-chains/abstract-chain';
it('isolates the specified concrete predicate against a genuine retained native producer',async()=>{
 const gate=process.env.W1HB_GATE!;const chain=await MoneroChain.create();setFixtureChain(chain);const owner=await launchNative();
 try {if(gate==='zero-change'){expect(chain.verifyTransactionExtraConditions(owner.transaction,SigningStatus.UnSigned)).toBe(true);expect(chain.calls).toEqual(['extra']);}else if(gate==='consistency'){await expect(verify(owner.transaction)).rejects.toThrow();expect(chain.calls).toEqual(['consistency']);}else{expect(await verify(owner.transaction)).toBe(false);expect(chain.calls).toEqual(gate==='fee'?['consistency','fee']:gate==='conservation'?['consistency','fee','no-burn']:['consistency','fee','no-burn','extra']);expect(await chain.verifyPaymentTransaction(owner.transaction)).toBe(true);if(gate!=='fee')expect(await chain.verifyTransactionFee(owner.transaction)).toBe(true);if(gate!=='conservation')expect(await chain.verifyNoTokenBurned(owner.transaction)).toBe(true);if(gate!=='change')expect(chain.verifyTransactionExtraConditions(owner.transaction,SigningStatus.UnSigned)).toBe(true);}}
 finally{await owner.close();setFixtureChain(undefined);}
});
