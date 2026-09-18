import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

// Exact runtime closure of the reviewed ergo-multi-sig package. External package
// dependencies resolve through the existing prepared Rosen distribution.
const files=['package.json','dist/const.js','dist/index.js','dist/multiSigHandler.js','dist/multiSigUtils.js','dist/types.js'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function captureContributionPackage(configuration){
  if(!configuration||Object.keys(configuration).sort().join(',')!=='root,sha256'||
      !isAbsolute(configuration.root??'')||!/^[0-9a-f]{64}$/.test(configuration.sha256))throw Error('Contribution package configuration');
  const {root:configuredRoot,sha256:expectedDigest}=configuration;
  const root=realpathSync(configuredRoot),urls=new Map();
  const snapshot=files.map(name=>{
    const file=join(root,name);
    if(!lstatSync(file).isFile()||realpathSync(file)!==file)throw Error('Contribution package path');
    const bytes=readFileSync(file),digest=sha(bytes);urls.set(pathToFileURL(file).href,{file,digest});
    return name+'\0'+digest+'\0'+bytes.length+'\n';
  }).join('');
  if(sha(snapshot)!==expectedDigest)throw Error('Contribution package pin');
  const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  if(pkg.name!=='@rosen-bridge/ergo-multi-sig'||pkg.version!=='3.0.1'||pkg.main!=='dist/index.js'||pkg.type!=='module')
    throw Error('Contribution package identity');
  const read=url=>{
    const row=urls.get(url);if(!row)throw Error('Contribution package undeclared module');
    if(realpathSync(configuredRoot)!==root||realpathSync(row.file)!==row.file)throw Error('Contribution package location changed');
    const bytes=readFileSync(row.file);if(sha(bytes)!==row.digest)throw Error('Contribution package changed');return bytes;
  };
  return Object.freeze({entry:pathToFileURL(join(root,'dist/index.js')).href,
    prefix:pathToFileURL(root).href+'/',sha256:expectedDigest,has:url=>urls.has(url),read,
    verify:()=>{for(const url of urls.keys())read(url);}});
}
