import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {builtinModules,createRequire} from 'node:module';
import {existsSync,lstatSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureContributionPackage} from './contribution-package.mjs';

export const scannerRuntimeSourceFiles=Object.freeze(['package.json','lib/moneroNetworkConnector.ts','lib/types.ts','lib/nativeDepositObserver.ts',
  'lib/moneroObservationExtractor.ts','lib/actions/candidateStore.ts','lib/entities/moneroCandidateEntity.ts','tests/fixtures.ts']);
export const rosenRuntimeSeedPackages=Object.freeze([
  '@noble/hashes','@rosen-bridge/abstract-logger','@rosen-bridge/abstract-scanner','@rosen-bridge/address-codec',
  '@rosen-bridge/address-manager','@rosen-bridge/communication','@rosen-bridge/dialer','@rosen-bridge/encryption',
  '@rosen-bridge/extended-typeorm','@rosen-bridge/json-bigint','@rosen-bridge/minimum-fee','@rosen-bridge/semaphore',
  '@rosen-bridge/tokens','@rosen-bridge/watcher-data-extractor','@rosen-chains/abstract-chain','@rosen-chains/binance',
  '@rosen-chains/bitcoin','@rosen-chains/bitcoin-esplora','@rosen-chains/bitcoin-runes','@rosen-chains/bitcoin-runes-rpc',
  '@rosen-chains/cardano','@rosen-chains/cardano-blockfrost-network','@rosen-chains/cardano-koios-network','@rosen-chains/doge',
  '@rosen-chains/doge-blockcypher','@rosen-chains/doge-esplora','@rosen-chains/doge-rpc','@rosen-chains/ergo',
  '@rosen-chains/ergo-explorer-network','@rosen-chains/ergo-node-network','@rosen-chains/ethereum','@rosen-chains/evm',
  '@rosen-chains/evm-rpc','@rosen-chains/firo','@rosen-chains/firo-electrumx','@rosen-chains/handshake',
  '@rosen-chains/handshake-rpc','@rosen-clients/rate-limited-axios','blakejs','ergo-lib-wasm-nodejs','lodash-es','supports-color','typescript',
]);
const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),ordinal=(a,b)=>a<b?-1:a>b?1:0;
const builtins=new Set([...builtinModules,...builtinModules.map(name=>'node:'+name)]);
const limits=Object.freeze({packages:2048,files:100000,bytes:2*1024*1024*1024});
const runGit=(root,args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024}).trim();
const slash=value=>value.replaceAll('\\','/');
function inside(root,path){const name=relative(root,path);return name===''||(!name.startsWith('..'+sep)&&name!=='..'&&!isAbsolute(name));}
function under(root,path){const name=slash(relative(root,path));assert(name&&!name.startsWith('../')&&!isAbsolute(name),'Dependency path outside prepared root');return name;}
function gitSource(label,packageRoot,expectedCommit,sourceFiles){
  assert(/^[0-9a-f]{40}$/.test(expectedCommit??''),label+' commit pin');
  const gitRoot=realpathSync(runGit(packageRoot,['rev-parse','--show-toplevel'])),head=runGit(gitRoot,['rev-parse','HEAD']);
  const names=sourceFiles.map(file=>under(gitRoot,file));
  const verify=()=>{
    assert.equal(realpathSync(runGit(packageRoot,['rev-parse','--show-toplevel'])),gitRoot,label+' Git root');
    assert.equal(runGit(gitRoot,['rev-parse','HEAD']),expectedCommit,label+' Git head');
    for(const name of names)runGit(gitRoot,['ls-files','--error-unmatch','--',name]);
    assert.equal(runGit(gitRoot,['status','--porcelain=v1','--untracked-files=all','--',...names]),'',label+' source dirty');
  };
  verify();return {gitRoot,head,verify};
}
function sourceFile(root,name,label){
  const file=resolve(root,name),stat=lstatSync(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&realpathSync(file)===file,label+' source path');
  const bytes=readFileSync(file);return Object.freeze({path:file,name,sha256:sha(bytes),bytes:bytes.length});
}
function manifest(root){const file=join(root,'package.json'),stat=lstatSync(file);assert(stat.isFile()&&!stat.isSymbolicLink(),'Package manifest path');return JSON.parse(readFileSync(file,'utf8'));}
function dependencyRows(pkg){
  const rows=new Map();
  for(const [kind,values] of [['dependency',pkg.dependencies],['optional',pkg.optionalDependencies],['peer',pkg.peerDependencies]]){
    for(const [name,spec] of Object.entries(values??{})){
      const optional=kind==='optional'||(kind==='peer'&&pkg.peerDependenciesMeta?.[name]?.optional===true),old=rows.get(name);
      rows.set(name,{name,spec,kind:old&&!old.optional?old.kind:kind,optional:(old?.optional??true)&&optional});
    }
  }
  return [...rows.values()].sort((a,b)=>ordinal(a.name,b.name));
}
function locatePackage(fromRoot,name){
  const search=createRequire(join(fromRoot,'package.json')).resolve.paths(name)??[];
  for(const base of search){const root=join(base,...name.split('/'));if(existsSync(join(root,'package.json')))return root;}
}
function scanTree(root,hashFiles){
  const files=[];let bytes=0;
  const visit=(directory,prefix='')=>{
    for(const name of readdirSync(directory).sort(ordinal)){
      if(name==='node_modules')continue;
      const path=join(directory,name),relativeName=prefix?prefix+'/'+name:name,stat=lstatSync(path);
      assert(!stat.isSymbolicLink(),'Dependency tree symlink: '+relativeName);
      if(stat.isDirectory())visit(path,relativeName);
      else if(stat.isFile()){
        bytes+=stat.size;
        files.push({path,relative:relativeName,bytes:stat.size,...(hashFiles?{sha256:sha(readFileSync(path))}:{})});
      }else throw Error('Dependency tree file kind: '+relativeName);
    }
  };
  visit(root);return {files,bytes};
}
function seedRows(pkg,resolverRoot,via){return dependencyRows(pkg).map(row=>({...row,resolverRoot,via}));}
function captureDependencyGraph({label,anchorRoot,seeds,binRoots=[],hashFiles=true}){
  const anchor=realpathSync(anchorRoot),queue=[...seeds].sort((a,b)=>ordinal(a.name,b.name)),packages=new Map(),missing=[],runtimeBuiltins=[];
  while(queue.length){
    const task=queue.shift();
    if(builtins.has(task.name)){runtimeBuiltins.push({from:under(anchor,realpathSync(task.resolverRoot)),name:task.name});continue;}
    const resolutionRoot=locatePackage(task.resolverRoot,task.name);
    if(!resolutionRoot){
      if(task.optional){missing.push({from:under(anchor,realpathSync(task.resolverRoot)),name:task.name,kind:task.kind});continue;}
      throw Error(label+' dependency missing: '+task.name);
    }
    const targetRoot=realpathSync(resolutionRoot);
    assert(inside(anchor,resolutionRoot)&&inside(anchor,targetRoot),label+' dependency outside prepared root');
    const pkg=manifest(targetRoot),alias=typeof task.spec==='string'&&task.spec.startsWith('npm:'+pkg.name+'@');
    assert(pkg.name===task.name||alias,label+' dependency identity: '+task.name);
    let entry=packages.get(targetRoot);
    if(entry){entry.resolutions.add(under(anchor,resolutionRoot));continue;}
    assert(packages.size<limits.packages,label+' dependency package limit');
    const tree=scanTree(targetRoot,hashFiles);
    entry={name:pkg.name,version:String(pkg.version??''),target:under(anchor,targetRoot),resolutions:new Set([under(anchor,resolutionRoot)]),tree};
    assert(entry.version,label+' dependency version');packages.set(targetRoot,entry);
    queue.push(...seedRows(pkg,targetRoot,entry.target));
  }
  const bins=binRoots.map(path=>{
    const present=existsSync(path);if(!present)return {path:slash(relative(anchor,path)),present,tree:{files:[],bytes:0}};
    const root=realpathSync(path);assert(inside(anchor,root),label+' binary shim path');return {path:under(anchor,path),present,tree:scanTree(root,hashFiles)};
  });
  const packageRows=[...packages.entries()].map(([root,row])=>({root,...row,resolutions:[...row.resolutions].sort(ordinal)}))
    .sort((a,b)=>ordinal(a.target,b.target));
  const allFiles=[...packageRows.flatMap(row=>row.tree.files),...bins.flatMap(row=>row.tree.files)];
  const totalBytes=allFiles.reduce((n,row)=>n+row.bytes,0);
  assert(allFiles.length<=limits.files&&totalBytes<=limits.bytes,label+' installed dependency closure limit');
  const metadataPackages=packageRows.map(row=>({name:row.name,version:row.version,target:row.target,resolutions:row.resolutions,
    fileCount:row.tree.files.length,bytes:row.tree.bytes,files:row.tree.files.map(file=>({path:file.relative,bytes:file.bytes,...(hashFiles?{sha256:file.sha256}:{})})),
    ...(hashFiles?{aggregateSha256:sha(row.tree.files.map(file=>file.relative+'\0'+file.sha256+'\0'+file.bytes+'\n').join(''))}:{})}));
  const metadataBins=bins.map(row=>({path:row.path,present:row.present,fileCount:row.tree.files.length,bytes:row.tree.bytes,
    files:row.tree.files.map(file=>({path:file.relative,bytes:file.bytes,...(hashFiles?{sha256:file.sha256}:{})}))}));
  const orderedMissing=missing.sort((a,b)=>ordinal(JSON.stringify(a),JSON.stringify(b))),orderedBuiltins=runtimeBuiltins.sort((a,b)=>ordinal(JSON.stringify(a),JSON.stringify(b)));
  const structure={packages:metadataPackages.map(row=>({name:row.name,version:row.version,target:row.target,resolutions:row.resolutions,
    files:row.files.map(file=>({path:file.path,bytes:file.bytes}))})),bins:metadataBins.map(row=>({path:row.path,present:row.present,files:row.files.map(file=>({path:file.path,bytes:file.bytes}))})),
    missingOptional:orderedMissing,runtimeBuiltins:orderedBuiltins};
  const metadata={packageCount:packageRows.length,fileCount:allFiles.length,bytes:totalBytes,packages:metadataPackages,bins:metadataBins,
    missingOptional:orderedMissing,runtimeBuiltins:orderedBuiltins};
  if(hashFiles)metadata.closureSha256=sha(JSON.stringify(metadata));
  const paths=[anchorRoot,anchor,...packageRows.flatMap(row=>[...row.resolutions.map(path=>join(anchor,path)),row.root]),...binRoots];
  return {files:allFiles,paths,structure,metadata};
}
function uniqueFiles(rows){
  const found=new Map();for(const row of rows){const key=(process.platform==='win32'?realpathSync(row.path).toLowerCase():realpathSync(row.path)),old=found.get(key);
    if(old)assert.equal(old.sha256,row.sha256,'Conflicting external input');else found.set(key,row);}
  return [...found.values()];
}
function uniquePaths(rows){return [...new Set(rows.map(path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path)))];}

/** Exact executed adapter bytes, installed package graphs and immutable public
 * source identities. Source commits and runtime digests do not claim a
 * reproducible build or capture operating-system shared libraries. */
export function captureExternalAdapterInputs(configuration){
  assert(configuration&&typeof configuration==='object','External adapter configuration');
  assert(isAbsolute(configuration.scannerAdapterRoot??''),'Scanner package root');
  assert(isAbsolute(configuration.rosenRoot??''),'Prepared Rosen root');
  const configuredScannerRoot=resolve(configuration.scannerAdapterRoot),scannerRoot=realpathSync(configuredScannerRoot);
  const scannerFiles=scannerRuntimeSourceFiles.map(name=>sourceFile(scannerRoot,name,'Scanner'));
  const scannerPackage=manifest(scannerRoot);assert.equal(scannerPackage.name,'@rosen-bridge/monero-observation-extractor','Scanner package identity');
  const scannerGitRoot=realpathSync(runGit(scannerRoot,['rev-parse','--show-toplevel'])),scannerLock=sourceFile(scannerGitRoot,'package-lock.json','Scanner lock');
  const scannerGit=gitSource('Scanner',scannerRoot,configuration.scannerAdapterCommit,[...scannerFiles.map(row=>row.path),scannerLock.path]);
  const contribution=captureContributionPackage(configuration.contributionPackage);
  assert(/^[0-9a-f]{40}$/.test(configuration.contributionPackage?.commit??''),'Contribution commit pin');
  const contributionSources=contribution.files.map(row=>row.name==='package.json'?'package.json':'lib/'+row.name.slice(5,-3)+'.ts')
    .map(name=>sourceFile(contribution.root,name,'Contribution'));
  const contributionGitRoot=realpathSync(runGit(contribution.root,['rev-parse','--show-toplevel'])),contributionLock=sourceFile(contributionGitRoot,'package-lock.json','Contribution lock');
  const contributionGit=gitSource('Contribution',contribution.root,configuration.contributionPackage.commit,[...contributionSources.map(row=>row.path),contributionLock.path]);
  const rosenRoot=realpathSync(configuration.rosenRoot);manifest(rosenRoot);
  const guardRoot=join(rosenRoot,'services','guard-service');manifest(guardRoot);
  const rosenFiles=[sourceFile(rosenRoot,'package.json','Rosen'),sourceFile(rosenRoot,'package-lock.json','Rosen lock'),sourceFile(guardRoot,'package.json','Guard')];
  assert.equal(sha(readFileSync(join(sourceRoot,'guard-service','package.json'))),rosenFiles[2].sha256,'Prepared guard package manifest');
  const scannerSeeds=[...seedRows(scannerPackage,scannerRoot,'scanner'),...['@rosen-bridge/abstract-logger','supports-color'].map(name=>({
    name,spec:'*',kind:'direct',optional:false,resolverRoot:scannerRoot,via:'scanner-harness',
  }))];
  const runtimeSeeds=rosenRuntimeSeedPackages.flatMap(name=>[
    {name,spec:'*',kind:'direct',optional:false,resolverRoot:rosenRoot,via:'fixture-root'},
    {name,spec:'*',kind:'direct',optional:false,resolverRoot:guardRoot,via:'guard-service'},
  ]);
  const rosenSeeds=[...runtimeSeeds,...seedRows(manifest(contribution.root),rosenRoot,'contribution')];
  const scannerClosure=captureDependencyGraph({label:'Scanner',anchorRoot:scannerGit.gitRoot,seeds:scannerSeeds,binRoots:[join(scannerGit.gitRoot,'node_modules','.bin')]});
  const rosenClosure=captureDependencyGraph({label:'Rosen',anchorRoot:rosenRoot,seeds:rosenSeeds,
    binRoots:[join(rosenRoot,'node_modules','.bin'),join(guardRoot,'node_modules','.bin')]});
  const scannerMetadata={commit:scannerGit.head,files:[...scannerFiles,scannerLock].map(({path,sha256})=>({path:under(scannerGit.gitRoot,path),sha256}))};
  const contributionMetadata={commit:contributionGit.head,aggregateSha256:contribution.sha256,
    files:contribution.files.map(({name: path,sha256})=>({path,sha256})),sourceLockSha256:contributionLock.sha256};
  const installedDependencies={scanner:scannerClosure.metadata,rosen:rosenClosure.metadata};
  const closureSha256=sha(JSON.stringify({scanner:scannerMetadata,contribution:contributionMetadata,installedDependencies}));
  const metadata=Object.freeze({scanner:Object.freeze(scannerMetadata),contribution:Object.freeze(contributionMetadata),installedDependencies,closureSha256});
  const configuredContributionRoot=resolve(configuration.contributionPackage.root),allFiles=uniqueFiles([...scannerFiles,scannerLock,...contribution.files,contributionLock,...rosenFiles,...scannerClosure.files,...rosenClosure.files]);
  const initialStructure=JSON.stringify({scanner:scannerClosure.structure,rosen:rosenClosure.structure});
  const graphOptions={scanner:{label:'Scanner',anchorRoot:scannerGit.gitRoot,seeds:scannerSeeds,binRoots:[join(scannerGit.gitRoot,'node_modules','.bin')]},
    rosen:{label:'Rosen',anchorRoot:rosenRoot,seeds:rosenSeeds,binRoots:[join(rosenRoot,'node_modules','.bin'),join(guardRoot,'node_modules','.bin')]}};
  const verifyStructure=()=>{
    const currentScanner=captureDependencyGraph({...graphOptions.scanner,hashFiles:false});
    const currentRosen=captureDependencyGraph({...graphOptions.rosen,hashFiles:false});
    assert.equal(JSON.stringify({scanner:currentScanner.structure,rosen:currentRosen.structure}),initialStructure,'Installed dependency set changed');return true;
  };
  const verify=()=>{
    assert.equal(realpathSync(configuredScannerRoot),scannerRoot,'Scanner package location changed');scannerGit.verify();
    assert.equal(realpathSync(configuredContributionRoot),contribution.root,'Contribution package location changed');contributionGit.verify();contribution.verify();
    for(const row of allFiles)assert.equal(sha(readFileSync(row.path)),row.sha256,'External input changed');
    verifyStructure();return true;
  };
  return Object.freeze({files:Object.freeze(allFiles.map(row=>Object.freeze({path:row.path,sha256:row.sha256}))),
    paths:Object.freeze(uniquePaths([configuredScannerRoot,scannerRoot,scannerGit.gitRoot,configuredContributionRoot,contribution.root,contributionGit.gitRoot,rosenRoot,...scannerClosure.paths,...rosenClosure.paths])),
    metadata,verify,verifyStructure});
}
