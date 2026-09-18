import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {createFreshDepositAdmission} from '../consumer/freshDepositAdmission.mjs';
import {captureMinimumFeeAuthority,verifyMinimumFeeAuthority} from './minimum-fee-authority.mjs';

/** New liability admission requires current historical policy. Retained backing
 * remains bound to its original proof and the caller's existing ledger claim. */
export function bindProcessSourceFees({admission,configuration,feeAuthority},ports={}){
  assert(feeAuthority&&Object.keys(feeAuthority).sort().join(',')===
    'ergoTokenId,expectedErgoTree,minConfirmations,minFeeNFT,nodeUrl','Process fee authority policy');
  const cfg=structuredClone(configuration),policy=structuredClone(feeAuthority);
  assert.equal(policy.ergoTokenId,cfg.destinationAsset,'Process fee authority asset');
  const decimal=value=>{assert(typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=0xffffffffffffffffn,'Process fee amount');return BigInt(value);};
  const configuredBridge=decimal(cfg.bridgeFee),configuredNetwork=decimal(cfg.networkFee);
  const maximum=(...values)=>values.reduce((a,b)=>a>b?a:b);
  async function inspect(input,signal){
    signal.throwIfAborted();const candidate=structuredClone(input);
    const selected={...policy,fromChain:'monero',toChain:'ergo',sourceChainHeight:candidate.sourceHeight};
    const authority=await captureMinimumFeeAuthority(selected,ports);signal.throwIfAborted();
    const result=await admission.inspect(candidate,signal);signal.throwIfAborted();
    if(result.status!=='accepted')return result;
    const amount=decimal(result.observation.amount),bridge=decimal(result.observation.bridgeFee),network=decimal(result.observation.networkFee),fee=authority.feeConfig;
    assert.equal(bridge,configuredBridge,'Process proof-bound bridge fee');assert.equal(network,configuredNetwork,'Process proof-bound network fee');
    assert.equal(bridge,maximum(bridge,BigInt(fee.bridgeFee),amount*BigInt(fee.feeRatio)/BigInt(fee.feeRatioDivisor)),'Process insufficient bridge fee');
    assert.equal(network,maximum(network,BigInt(fee.networkFee)),'Process insufficient network fee');
    assert(amount>bridge+network,'Process positive credited amount');
    assert.equal(result.decision.amount,amount,'Process proof-bound amount');
    assert.equal(result.decision.destinationAmount,amount-bridge-network,'Process proof-bound destination amount');
    assert.equal(result.backing.creditedAtomic,(amount-bridge-network).toString(),'Process proof-bound backing amount');
    await verifyMinimumFeeAuthority(selected,authority,ports);signal.throwIfAborted();return result;
  }
  return Object.freeze({scope:admission.scope,inspect,
    async verify(candidate,signal){try{const result=await inspect(candidate,signal);
      return result.status==='accepted'?{status:'accepted',observation:result.observation}:result;
    }catch{return {status:'pending'};}},
    readRetainedBacking:(candidate,expected,signal)=>admission.readRetainedBacking(candidate,expected,signal)});
}

/** One process-owned source connection, native observer and proof verifier. */
export async function openProcessSource(descriptor){
  assert(descriptor&&Object.keys(descriptor).sort().join(',')===
    'certificateDirectory,configuration,deliveryDirectory,endpoints,feeAuthority,genesis,nativeOptions','Process source descriptor');
  const selected=structuredClone(descriptor),abort=new AbortController();
  const [{config},{nativeProof}]=await Promise.all([import('../tools/config.mjs'),import('../consumer/depositSource.ts')]);
  const moduleAt=name=>import(pathToFileURL(join(config.scannerAdapterRoot,'lib',name+'.ts')).href);
  const [{MoneroNetworkConnector},{NativeDepositObserver}]=await Promise.all([
    moduleAt('moneroNetworkConnector'),moduleAt('nativeDepositObserver')]);
  const require=createRequire(join(config.rosenRoot,'package.json')),wasm=require('ergo-lib-wasm-nodejs');
  const network=new MoneroNetworkConnector({endpoints:selected.endpoints,genesis:selected.genesis});
  const observer=new NativeDepositObserver(selected.nativeOptions);let proofCalls=0,closed=false;
  const admission=bindProcessSourceFees({...selected,admission:createFreshDepositAdmission({...selected,network,observer,
    verifyProof:request=>{if(closed)throw Error('Process source closed');proofCalls++;
      return nativeProof('verify',request,config.runtimeDirectory);},
    validateRecipient:address=>assert.equal(wasm.Address.from_base58(address).to_base58(wasm.NetworkPrefix.Testnet),address)})});
  return Object.freeze({scope:admission.scope,get proofCalls(){return proofCalls;},
    async anchor(height){if(closed)throw Error('Process source closed');const block=await network.getBlockAtHeight(height);
      if(closed)throw Error('Process source closed');return {height:block.height,hash:block.hash};},
    inspect(candidate,signal=abort.signal){if(closed)throw Error('Process source closed');return admission.inspect(candidate,AbortSignal.any([abort.signal,signal]));},
    verify(candidate,signal=abort.signal){if(closed)throw Error('Process source closed');return admission.verify(candidate,AbortSignal.any([abort.signal,signal]));},
    readRetainedBacking(candidate,expectedBacking,signal=abort.signal){if(closed)throw Error('Process source closed');
      return admission.readRetainedBacking(candidate,expectedBacking,AbortSignal.any([abort.signal,signal]));},
    close(){closed=true;abort.abort();network.close();}});
}
