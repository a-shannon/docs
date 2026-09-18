import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {config} from '../tools/config.mjs';
import {createFreshDepositAdmission} from '../consumer/freshDepositAdmission.mjs';
import {nativeProof} from '../consumer/depositSource.ts';

/** One process-owned source connection, native observer and proof verifier. */
export async function openProcessSource(descriptor){
  assert(descriptor&&Object.keys(descriptor).sort().join(',')===
    'certificateDirectory,configuration,deliveryDirectory,endpoints,genesis,nativeOptions','Process source descriptor');
  const selected=structuredClone(descriptor),abort=new AbortController();
  const moduleAt=name=>import(pathToFileURL(join(config.scannerAdapterRoot,'lib',name+'.ts')).href);
  const [{MoneroNetworkConnector},{NativeDepositObserver}]=await Promise.all([
    moduleAt('moneroNetworkConnector'),moduleAt('nativeDepositObserver')]);
  const require=createRequire(join(config.rosenRoot,'package.json')),wasm=require('ergo-lib-wasm-nodejs');
  const network=new MoneroNetworkConnector({endpoints:selected.endpoints,genesis:selected.genesis});
  const observer=new NativeDepositObserver(selected.nativeOptions);let proofCalls=0,closed=false;
  const admission=createFreshDepositAdmission({...selected,network,observer,
    verifyProof:request=>{if(closed)throw Error('Process source closed');proofCalls++;
      return nativeProof('verify',request,config.runtimeDirectory);},
    validateRecipient:address=>assert.equal(wasm.Address.from_base58(address).to_base58(wasm.NetworkPrefix.Testnet),address)});
  return Object.freeze({scope:admission.scope,get proofCalls(){return proofCalls;},
    inspect(candidate,signal=abort.signal){if(closed)throw Error('Process source closed');return admission.inspect(candidate,AbortSignal.any([abort.signal,signal]));},
    verify(candidate,signal=abort.signal){if(closed)throw Error('Process source closed');return admission.verify(candidate,AbortSignal.any([abort.signal,signal]));},
    close(){closed=true;abort.abort();network.close();}});
}
