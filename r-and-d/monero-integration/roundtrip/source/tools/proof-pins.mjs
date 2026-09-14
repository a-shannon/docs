import {posix} from 'node:path';
const digest=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
export function proofPath(value){
  return typeof value==='string'&&value.length>1&&value.length<=4096&&value.startsWith('/')&&!value.startsWith('//')&&
    !/[\x00-\x1f\x7f\\]/.test(value)&&posix.normalize(value)===value&&!value.endsWith('/');
}
export function captureProofConfiguration(config){
  for(const field of ['proofBinary','proofLibrary'])if(!proofPath(config[field])||!digest(config[field+'Sha256']))throw Error('Prepared proof path and pin required');
  const libraries=config.proofSharedLibraries;
  if(!Array.isArray(libraries)||libraries.length===0||libraries.length>64)throw Error('Proof shared-library closure required');
  const seen=new Set([config.proofBinary]);
  const captured=libraries.map(row=>{
    if(!row||Object.getPrototypeOf(row)!==Object.prototype||Object.keys(row).sort().join(',')!=='path,sha256'||
      !proofPath(row.path)||!digest(row.sha256)||seen.has(row.path))throw Error('Proof shared-library entry');
    seen.add(row.path);return Object.freeze({path:row.path,sha256:row.sha256});
  });
  if(!captured.some(row=>row.path===config.proofLibrary&&row.sha256===config.proofLibrarySha256))throw Error('Pinned wallet library absent from closure');
  return Object.freeze({proofBinary:config.proofBinary,proofBinarySha256:config.proofBinarySha256,
    proofLibrary:config.proofLibrary,proofLibrarySha256:config.proofLibrarySha256,proofSharedLibraries:Object.freeze(captured)});
}
export function proofArtifactPins(config){
  const captured=captureProofConfiguration(config);
  return [{path:captured.proofBinary,sha256:captured.proofBinarySha256},...captured.proofSharedLibraries];
}
