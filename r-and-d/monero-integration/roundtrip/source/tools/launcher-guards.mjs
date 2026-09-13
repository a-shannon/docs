import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {resolve,dirname,basename,join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
// Resolve the nearest existing ancestor, including junctions, before appending
// absent components. A dangling link or inaccessible ancestor fails closed.
export function canonicalPath(input){
  if(typeof input!=='string'||!isAbsolute(input)||/[\x00-\x1f]/.test(input))throw Error('Absolute path required');
  let cursor=resolve(input);const suffix=[];
  for(;;){try{lstatSync(cursor);break;}catch(error){if(error.code!=='ENOENT')throw error;const parent=dirname(cursor);if(parent===cursor)throw error;suffix.unshift(basename(cursor));cursor=parent;}}
  const path=join(realpathSync.native(cursor),...suffix).replaceAll('\\','/').replace(/\/$/,'');
  return process.platform==='win32'?path.toLowerCase():path;
}
export function pathsOverlap(left,right){
  const a=canonicalPath(left),b=canonicalPath(right);
  return a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
}
export function assertExternalWork(work,protectedPaths){
  for(const path of protectedPaths)if(pathsOverlap(work,path))throw Error('Runtime overlaps a prepared input');
}
const gitHead=root=>execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
// The exact declared closure is frozen once and checked with the same predicate
// before execution and after completion. This does not claim unknown dependencies.
export function freezeInputs({files,paths=[],gitRoot,expectedHead,validateSets=()=>{},checks=[]}){
  const frozen=files.map(entry=>Object.freeze({...entry,canonical:canonicalPath(entry.path)}));
  const locations=[...paths,gitRoot].map(path=>Object.freeze({path,canonical:canonicalPath(path)}));
  const externalChecks=[...checks];
  const verify=()=>{
    for(const entry of frozen){if(canonicalPath(entry.path)!==entry.canonical||sha256(readFileSync(entry.path))!==entry.sha256)throw Error('Declared input changed');}
    for(const location of locations)if(canonicalPath(location.path)!==location.canonical)throw Error('Input location changed');
    if(gitHead(gitRoot)!==expectedHead)throw Error('Prepared Git head changed');
    for(const check of externalChecks)check();
    validateSets();return true;
  };
  verify();return Object.freeze({verify});
}
