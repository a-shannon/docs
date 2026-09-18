import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {contributionPackageFiles} from './contribution-package.mjs';
import {captureExternalAdapterInputs,rosenRuntimeSeedPackages,scannerRuntimeSourceFiles} from './external-adapter-inputs.mjs';
import {assertExternalWork,freezeInputs} from './launcher-guards.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const write=(root,name,value)=>{const file=join(root,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,value);return file;};
function packageRoot(modules,name){return join(modules,...name.split('/'));}
function writePackage(modules,name,{dependencies,files={}}={}){
  const root=packageRoot(modules,name);
  if(!existsSync(join(root,'package.json'))){
    write(root,'package.json',JSON.stringify({name,version:'1.0.0',main:'index.js',...(dependencies?{dependencies}:{})}));
    write(root,'index.js','export const runtime=1;');
  }
  for(const [path,value] of Object.entries(files))write(root,path,value);return root;
}
function commit(root){
  execFileSync('git',['init','--quiet',root],{windowsHide:true});
  execFileSync('git',['-C',root,'config','user.name','Fixture'],{windowsHide:true});
  execFileSync('git',['-C',root,'config','user.email','fixture@example.invalid'],{windowsHide:true});
  execFileSync('git',['-C',root,'add','.'],{windowsHide:true});
  execFileSync('git',['-C',root,'commit','--quiet','-m','fixture'],{windowsHide:true});
  return execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
}
function fixture(t){
  const base=mkdtempSync(join(tmpdir(),'external-adapter-inputs-')),scannerRepo=join(base,'scanner'),contributionRepo=join(base,'sign-protocols'),rosenRoot=join(base,'rosen');
  const scanner=join(scannerRepo,'packages','monero-observation-extractor'),contribution=join(contributionRepo,'packages','ergo-multi-sig');
  write(scannerRepo,'.gitignore','node_modules/\n');write(scannerRepo,'package-lock.json','scanner-lock');
  for(const name of scannerRuntimeSourceFiles)write(scanner,name,name==='package.json'?JSON.stringify({
    name:'@rosen-bridge/monero-observation-extractor',version:'0.1.0',dependencies:{'scanner-dep':'1.0.0','workspace-dep':'1.0.0'}}):'export const fixture=1;');
  const scannerModules=join(scannerRepo,'node_modules');writePackage(scannerModules,'scanner-dep',{dependencies:{'shadow-dep':'1.0.0'},files:{'runtime.cjs':'module.exports=1;'}});
  writePackage(scannerModules,'shadow-dep');
  writePackage(scannerModules,'@rosen-bridge/abstract-logger');
  writePackage(scannerModules,'supports-color',{dependencies:{'has-flag':'1.0.0'}});writePackage(scannerModules,'has-flag');
  const firstWorkspace=join(scannerRepo,'packages','workspace-one'),secondWorkspace=join(scannerRepo,'packages','workspace-two');
  for(const root of [firstWorkspace,secondWorkspace]){write(root,'package.json',JSON.stringify({name:'workspace-dep',version:'1.0.0',main:'index.js'}));write(root,'index.js','export const workspace=1;');}
  const workspaceLink=packageRoot(scannerModules,'workspace-dep');mkdirSync(dirname(workspaceLink),{recursive:true});
  symlinkSync(firstWorkspace,workspaceLink,process.platform==='win32'?'junction':'dir');
  write(scannerModules,'.bin/scanner-tool','shim');
  const contributionSourceNames=contributionPackageFiles.filter(name=>name.startsWith('dist/')).map(name=>'lib/'+name.slice(5,-3)+'.ts');
  for(const name of contributionSourceNames)write(contribution,name,'export const source=1;');
  for(const name of contributionPackageFiles)write(contribution,name,name==='package.json'?JSON.stringify({
    name:'@rosen-bridge/ergo-multi-sig',version:'3.0.1',main:'dist/index.js',type:'module',dependencies:{'contribution-dep':'1.0.0'}}):'export const runtime=1;');
  write(contributionRepo,'package-lock.json','contribution-lock');
  const scannerCommit=commit(scannerRepo),contributionCommit=commit(contributionRepo);
  const aggregate=sha(contributionPackageFiles.map(name=>{const bytes=readFileSync(join(contribution,name));return name+'\0'+sha(bytes)+'\0'+bytes.length+'\n';}).join(''));
  write(rosenRoot,'package.json',JSON.stringify({name:'prepared-rosen',version:'1.0.0',dependencies:{'root-dep':'1.0.0'}}));
  write(rosenRoot,'package-lock.json','rosen-lock');
  write(rosenRoot,'services/guard-service/package.json',readFileSync(join(dirname(fileURLToPath(import.meta.url)),'../guard-service/package.json')));
  const rosenModules=join(rosenRoot,'node_modules'),guardManifest=JSON.parse(readFileSync(join(rosenRoot,'services/guard-service/package.json')));
  for(const name of Object.keys(guardManifest.dependencies))writePackage(rosenModules,name);
  for(const name of rosenRuntimeSeedPackages)writePackage(rosenModules,name);
  writePackage(rosenModules,'root-dep');writePackage(rosenModules,'contribution-dep');
  const typescript=writePackage(rosenModules,'typescript',{files:{'lib/typescript.js':'module.exports={};'}});
  write(rosenModules,'.bin/runtime-tool','shim');
  const config={rosenRoot,scannerAdapterRoot:scanner,scannerAdapterCommit:scannerCommit,
    contributionPackage:{root:contribution,sha256:aggregate,commit:contributionCommit}};
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  return {base,scannerRepo,contributionRepo,rosenRoot,scanner,contribution,scannerModules,rosenModules,config,contributionSourceNames,
    firstWorkspace,secondWorkspace,workspaceLink,typescript};
}

test('captures direct sources, installed package graphs and stable receipt metadata',t=>{
  const f=fixture(t),captured=captureExternalAdapterInputs(f.config);
  assert(captured.files.length>scannerRuntimeSourceFiles.length+contributionPackageFiles.length);
  assert.equal(captured.metadata.scanner.commit,f.config.scannerAdapterCommit);
  assert.deepEqual(captured.metadata.scanner.files.slice(0,scannerRuntimeSourceFiles.length).map(row=>row.path),
    scannerRuntimeSourceFiles.map(path=>'packages/monero-observation-extractor/'+path));
  assert.equal(captured.metadata.scanner.files.at(-1).path,'package-lock.json');
  assert.equal(captured.metadata.contribution.commit,f.config.contributionPackage.commit);
  assert.equal(captured.metadata.contribution.aggregateSha256,f.config.contributionPackage.sha256);
  assert.deepEqual(captured.metadata.contribution.files.map(row=>row.path),contributionPackageFiles);
  const installed=captured.metadata.installedDependencies;
  assert(installed.scanner.packageCount>=4&&installed.rosen.packageCount>40);
  assert(installed.scanner.packages.some(row=>row.name==='workspace-dep'&&row.target==='packages/workspace-one'));
  assert(installed.scanner.packages.some(row=>row.name==='supports-color'));
  assert(installed.rosen.packages.some(row=>row.name==='typescript'&&row.files.some(file=>file.path==='lib/typescript.js')));
  assert(installed.rosen.packages.some(row=>row.name==='contribution-dep'));
  assert(installed.scanner.bins.some(row=>row.files.some(file=>file.path==='scanner-tool')));
  assert(installed.scanner.packages.every(row=>/^[0-9a-f]{64}$/.test(row.aggregateSha256)&&row.files.every(file=>/^[0-9a-f]{64}$/.test(file.sha256))));
  assert(/^[0-9a-f]{64}$/.test(installed.scanner.closureSha256)&&/^[0-9a-f]{64}$/.test(installed.rosen.closureSha256));
  assert(/^[0-9a-f]{64}$/.test(captured.metadata.closureSha256));captured.verify();
});

test('requires immutable commits, tracked locks and scoped clean runtime sources',t=>{
  const wrong=fixture(t);wrong.config.scannerAdapterCommit='0'.repeat(40);assert.throws(()=>captureExternalAdapterInputs(wrong.config),/Scanner Git head/);
  const scanner=fixture(t);writeFileSync(join(scanner.scanner,scannerRuntimeSourceFiles[1]),'changed');assert.throws(()=>captureExternalAdapterInputs(scanner.config),/Scanner source dirty/);
  const lock=fixture(t);writeFileSync(join(lock.scannerRepo,'package-lock.json'),'changed');assert.throws(()=>captureExternalAdapterInputs(lock.config),/Scanner source dirty/);
  const contribution=fixture(t);writeFileSync(join(contribution.contribution,contribution.contributionSourceNames[0]),'changed');
  assert.throws(()=>captureExternalAdapterInputs(contribution.config),/Contribution source dirty/);
  const unrelated=fixture(t);writeFileSync(join(unrelated.scannerRepo,'unrelated.txt'),'not an imported source');
  assert.doesNotThrow(()=>captureExternalAdapterInputs(unrelated.config));
});

for(const [name,mutate] of [
  ['scanner dependency byte',f=>writeFileSync(join(f.scannerModules,'scanner-dep/runtime.cjs'),'module.exports=2;')],
  ['TypeScript byte',f=>writeFileSync(join(f.typescript,'lib/typescript.js'),'module.exports={changed:true};')],
  ['contribution dependency byte',f=>writeFileSync(join(f.rosenModules,'contribution-dep/index.js'),'export const runtime=2;')],
  ['new dependency file',f=>write(f.scannerModules,'scanner-dep/new.js','new')],
  ['removed dependency file',f=>rmSync(join(f.scannerModules,'scanner-dep/runtime.cjs'))],
])test('post-capture verification rejects '+name,t=>{const f=fixture(t),captured=captureExternalAdapterInputs(f.config);mutate(f);assert.throws(()=>captured.verify());});

test('post-capture verification rejects a retargeted workspace dependency link with identical bytes',t=>{
  const f=fixture(t),captured=captureExternalAdapterInputs(f.config);
  rmSync(f.workspaceLink);symlinkSync(f.secondWorkspace,f.workspaceLink,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>captured.verify(),/Installed dependency set changed/);
});

test('post-capture verification rejects a newly installed nested shadow dependency',t=>{
  const f=fixture(t),captured=captureExternalAdapterInputs(f.config);
  writePackage(join(f.scannerModules,'scanner-dep/node_modules'),'shadow-dep');
  assert.throws(()=>captured.verify(),/Installed dependency set changed/);
});

test('freezeInputs rejects external byte, location and Git drift and overlap',t=>{
  const f=fixture(t),captured=captureExternalAdapterInputs(f.config);
  const closure=freezeInputs({files:captured.files,paths:captured.paths,gitRoot:f.scannerRepo,expectedHead:f.config.scannerAdapterCommit,checks:[captured.verifyStructure]});
  assert.equal(closure.verify(),true);assert.throws(()=>assertExternalWork(join(f.scanner,'runtime'),captured.paths),/overlaps/);
  writeFileSync(join(f.contribution,contributionPackageFiles[1]),'changed');assert.throws(()=>closure.verify(),/Declared input changed/);
  writeFileSync(join(f.contribution,contributionPackageFiles[1]),'export const runtime=1;');
  execFileSync('git',['-C',f.contributionRepo,'commit','--allow-empty','--quiet','-m','drift'],{windowsHide:true});
  assert.throws(()=>captured.verify(),/Contribution Git head/);
});

test('configured adapter package links cannot be retargeted after capture',t=>{
  const scanner=fixture(t),scannerAlias=join(scanner.base,'scanner-alias');
  symlinkSync(scanner.scanner,scannerAlias,process.platform==='win32'?'junction':'dir');scanner.config.scannerAdapterRoot=scannerAlias;
  const scannerCapture=captureExternalAdapterInputs(scanner.config);rmSync(scannerAlias);symlinkSync(scanner.contribution,scannerAlias,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>scannerCapture.verify(),/Scanner package location changed/);
  const contribution=fixture(t),contributionAlias=join(contribution.base,'contribution-alias');
  symlinkSync(contribution.contribution,contributionAlias,process.platform==='win32'?'junction':'dir');contribution.config.contributionPackage.root=contributionAlias;
  const contributionCapture=captureExternalAdapterInputs(contribution.config);rmSync(contributionAlias);symlinkSync(contribution.scanner,contributionAlias,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>contributionCapture.verify(),/Contribution package location changed/);
});
