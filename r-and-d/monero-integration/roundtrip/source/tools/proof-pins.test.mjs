import test from 'node:test';
import assert from 'node:assert/strict';
import {captureProofConfiguration,proofArtifactPins,proofPath} from './proof-pins.mjs';

const good=()=>({proofBinary:'/fixture/tx-proof',proofBinarySha256:'11'.repeat(32),proofLibrary:'/fixture/libwallet.so',proofLibrarySha256:'22'.repeat(32),
  proofSharedLibraries:[{path:'/fixture/libwallet.so',sha256:'22'.repeat(32)},{path:'/fixture/libcrypto.so',sha256:'33'.repeat(32)}]});
test('captures every shared-library pin and retains the exact wallet binding',()=>{
  const config=good(),captured=captureProofConfiguration(config),pins=proofArtifactPins(config);
  assert.equal(pins.length,3);assert.equal(pins[2].path,'/fixture/libcrypto.so');
  config.proofSharedLibraries[1].sha256='44'.repeat(32);assert.equal(captured.proofSharedLibraries[1].sha256,'33'.repeat(32));
  assert(Object.isFrozen(captured)&&Object.isFrozen(captured.proofSharedLibraries)&&Object.isFrozen(captured.proofSharedLibraries[0]));
});
test('missing, duplicate, malformed or independently mismatched library declarations refuse',()=>{
  for(const mutate of [c=>delete c.proofSharedLibraries,c=>c.proofSharedLibraries=[],
    c=>c.proofSharedLibraries.push({...c.proofSharedLibraries[0]}),
    c=>c.proofSharedLibraries[1].path=c.proofBinary,
    c=>c.proofSharedLibraries[1].sha256='AA'.repeat(32),
    c=>c.proofSharedLibraries[1].extra=0,c=>delete c.proofSharedLibraries[1].sha256,
    c=>c.proofSharedLibraries[0].sha256='55'.repeat(32),c=>c.proofSharedLibraries.shift(),
    c=>c.proofSharedLibraries=Array.from({length:65},(_,i)=>({path:`/fixture/lib${i}.so`,sha256:'22'.repeat(32)}))]){
    const config=good();mutate(config);assert.throws(()=>captureProofConfiguration(config));
  }
});
test('each noncanonical path is refused independently while unchanged pins remain valid',()=>{
  assert(proofPath('/fixture/libwallet.so'));
  for(const path of ['relative','//fixture/lib.so','/fixture//lib.so','/fixture/../lib.so','/fixture/./lib.so','/fixture/lib.so/','/fixture\\lib.so','/fixture/\nlib.so','/']){
    assert.equal(proofPath(path),false);const config=good();config.proofSharedLibraries[1].path=path;assert.throws(()=>captureProofConfiguration(config));
  }
});
