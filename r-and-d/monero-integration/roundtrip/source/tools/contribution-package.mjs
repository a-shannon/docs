import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

// Exact runtime closure of the reviewed ergo-multi-sig package. External package
// dependencies resolve through the existing prepared Rosen distribution.
export const contributionPackageFiles=Object.freeze(['package.json','dist/const.js','dist/index.js','dist/multiSigHandler.js','dist/multiSigUtils.js','dist/types.js']);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function captureContributionPackage(configuration){
  const fields=Object.keys(configuration??{}).sort().join(',');
  if(!configuration||!['root,sha256','commit,root,sha256'].includes(fields)||
      !isAbsolute(configuration.root??'')||!/^[0-9a-f]{64}$/.test(configuration.sha256))throw Error('Contribution package configuration');
  if(Object.hasOwn(configuration,'commit')&&!/^[0-9a-f]{40}$/.test(configuration.commit))throw Error('Contribution package commit');
  const {root:configuredRoot,sha256:expectedDigest}=configuration;
  const root=realpathSync(configuredRoot),urls=new Map();
  const captured=contributionPackageFiles.map(name=>{
    const file=join(root,name);
    if(!lstatSync(file).isFile()||realpathSync(file)!==file)throw Error('Contribution package path');
    const bytes=readFileSync(file),digest=sha(bytes);urls.set(pathToFileURL(file).href,{file,digest});
    return Object.freeze({name,file,sha256:digest,bytes:bytes.length});
  });
  const snapshot=captured.map(row=>row.name+'\0'+row.sha256+'\0'+row.bytes+'\n').join('');
  if(sha(snapshot)!==expectedDigest)throw Error('Contribution package pin');
  const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  if(pkg.name!=='@rosen-bridge/ergo-multi-sig'||pkg.version!=='3.0.1'||pkg.main!=='dist/index.js'||pkg.type!=='module')
    throw Error('Contribution package identity');
  const read=url=>{
    const row=urls.get(url);if(!row)throw Error('Contribution package undeclared module');
    if(realpathSync(configuredRoot)!==root||realpathSync(row.file)!==row.file)throw Error('Contribution package location changed');
    const bytes=readFileSync(row.file);if(sha(bytes)!==row.digest)throw Error('Contribution package changed');return bytes;
  };
  return Object.freeze({entry:pathToFileURL(join(root,'dist/index.js')).href,root,
    prefix:pathToFileURL(root).href+'/',sha256:expectedDigest,has:url=>urls.has(url),read,
    files:Object.freeze(captured.map(row=>Object.freeze({path:row.file,name:row.name,sha256:row.sha256,bytes:row.bytes}))),
    verify:()=>{for(const url of urls.keys())read(url);}});
}
