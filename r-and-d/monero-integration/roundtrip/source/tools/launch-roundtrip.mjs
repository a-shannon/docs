import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,existsSync,copyFileSync,symlinkSync} from 'node:fs';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {assertExternalWork,freezeInputs} from './launcher-guards.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=x=>createHash('sha256').update(x).digest('hex'),ordinal=(a,b)=>a<b?-1:a>b?1:0;
const args=Object.create(null),allowed=new Set(['config','manifest-sha256','check-only','collect-only','profile']);
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i]?.slice(2),value=process.argv[i+1];if(!process.argv[i]?.startsWith('--')||!allowed.has(key)||!value||Object.hasOwn(args,key))throw Error('Arguments');args[key]=value;}
if(!args.config||!isAbsolute(args.config)||!/^[0-9a-f]{64}$/.test(args['manifest-sha256']))throw Error('Explicit config and manifest pin required');
for(const key of ['check-only','collect-only'])if(args[key]&&args[key]!=='true')throw Error('Boolean option');
const profile=args.profile??'baseline';if(!['baseline','watcher-authority'].includes(profile))throw Error('Unsupported profile');
const spec=profile==='watcher-authority'?'watcherAuthority.spec.ts':'roundtrip.spec.ts';
const testConfig=profile==='watcher-authority'?'watcherAuthority.config.ts':'roundtrip.config.ts';
const configBytes=readFileSync(args.config),config=JSON.parse(configBytes);
for(const key of ['rosenRoot','runtimeDirectory','nativeBinary','moneroDaemon','ergoRuntime'])if(typeof config[key]!=='string'||!isAbsolute(config[key]))throw Error('Absolute configuration: '+key);
const work=resolve(config.runtimeDirectory),rosen=resolve(config.rosenRoot);
const observerFiles=profile==='watcher-authority'?[[config.observerBinary,config.observerSha256]]:[];
if(config.collisionExperiment!==undefined){
  if(profile!=='watcher-authority'||!['raw-before-credit','decodable-before-credit','raw-after-credit','decodable-after-credit'].includes(config.collisionExperiment))throw Error('Collision profile');
  observerFiles.push([config.collisionBinary,config.collisionSha256]);
}
for(const [file,pin] of observerFiles)if(typeof file!=='string'||!isAbsolute(file)||!/^[0-9a-f]{64}$/.test(pin)||sha(readFileSync(file))!==pin)throw Error('Observer executable pin');
assertExternalWork(work,[root,rosen,config.ergoRuntime,config.nativeBinary,config.moneroDaemon,args.config,process.execPath]);
if(observerFiles.length)assertExternalWork(work,observerFiles.map(([file])=>file));
if(existsSync(work))throw Error('New external runtime directory required');
for(const [pathKey,hashKey]of [['nativeBinary','nativeSha256'],['moneroDaemon','moneroDaemonSha256']])if(!/^[0-9a-f]{64}$/.test(config[hashKey])||sha(readFileSync(config[pathKey]))!==config[hashKey])throw Error('Executable pin: '+pathKey);
if(typeof config.ergoRecipient!=='string'||!config.ergoRecipient||typeof config.wslDistro!=='string'||!config.wslDistro)throw Error('Prepared Ergo recipient and WSL distro required');
for(const key of ['proofBinary','proofLibrary'])if(typeof config[key]!=='string'||!config[key].startsWith('/')||/[\x00-\x1f]/.test(config[key])||!/^[0-9a-f]{64}$/.test(config[key+'Sha256']))throw Error('Prepared proof path and pin required');
const list=(dir,prefix='',skip=new Set())=>readdirSync(dir).flatMap(name=>{const relative=prefix?prefix+'/'+name:name;if(skip.has(relative))return [];const absolute=join(dir,name),st=lstatSync(absolute);if(st.isSymbolicLink())throw Error('Source symlink');if(st.isDirectory())return list(absolute,relative,skip);if(!st.isFile())throw Error('Source kind');return [relative];});
const manifestBytes=readFileSync(join(root,'source-manifest.json'));if(sha(manifestBytes)!==args['manifest-sha256'])throw Error('Manifest pin');
const manifest=JSON.parse(manifestBytes),names=manifest.files.map(x=>x.path);
if(manifest.algorithm!=='sha256'||manifest.aggregateRecipe!=='UTF-8: path + NUL + sha256 + NUL + decimal bytes + LF; ordinal path order'||manifest.fileCount!==names.length||names.length>1024)throw Error('Manifest schema');
if(names.some(x=>typeof x!=='string'||!/^[A-Za-z0-9_.\/-]+$/.test(x)||x.split('/').some(y=>!y||y==='.'||y==='..'))||JSON.stringify(names)!==JSON.stringify([...new Set(names)].sort(ordinal)))throw Error('Manifest paths');
if(JSON.stringify(list(root).filter(x=>x!=='source-manifest.json').sort(ordinal))!==JSON.stringify(names))throw Error('Exact source set');
let recipe='';for(const entry of manifest.files){const bytes=readFileSync(join(root,entry.path));if(bytes.length!==entry.bytes||sha(bytes)!==entry.sha256)throw Error('Source pin: '+entry.path);recipe+=entry.path+'\0'+entry.sha256+'\0'+entry.bytes+'\n';}
if(sha(Buffer.from(recipe))!==manifest.aggregateSha256)throw Error('Aggregate pin');
for(const name of ['package.json','package-lock.json'])if(sha(readFileSync(join(root,name)))!==sha(readFileSync(join(rosen,name))))throw Error('Prepared metadata');
const dependencies=JSON.parse(readFileSync(join(root,'prepared-dependencies.json'))).workspaceDistributionFiles;
for(const entry of dependencies){if(!/^[A-Za-z0-9_@.\/-]+$/.test(entry.path)||entry.path.startsWith('/')||entry.path.split('/').some(x=>!x||x==='.'||x==='..')||sha(readFileSync(join(rosen,entry.path)))!==entry.sha256)throw Error('Prepared distribution pin');}
const declaredFiles=[...manifest.files.map(e=>({path:join(root,e.path),sha256:e.sha256})),
  {path:join(root,'source-manifest.json'),sha256:args['manifest-sha256']},{path:args.config,sha256:sha(configBytes)},
  {path:config.nativeBinary,sha256:config.nativeSha256},{path:config.moneroDaemon,sha256:config.moneroDaemonSha256},{path:process.execPath,sha256:sha(readFileSync(process.execPath))},
  ...observerFiles.map(([path,sha256])=>({path,sha256})),
  ...['package.json','package-lock.json'].map(name=>({path:join(rosen,name),sha256:manifest.files.find(e=>e.path===name).sha256})),
  ...dependencies.map(e=>({path:join(rosen,e.path),sha256:e.sha256}))];
const verifySourceSet=()=>{if(JSON.stringify(list(root).filter(x=>x!=='source-manifest.json').sort(ordinal))!==JSON.stringify(names))throw Error('Exact source set changed');};
const proofPins=['proofBinary','proofLibrary'].map(key=>({path:config[key],sha256:config[key+'Sha256']}));
const verifyProofPins=()=>{
  const program='import hashlib,json,pathlib,sys; pins=json.loads(sys.argv[1]); print(json.dumps([hashlib.sha256(pathlib.Path(p["path"]).read_bytes()).hexdigest() for p in pins]))';
  const actual=JSON.parse(execFileSync('wsl.exe',['-d',config.wslDistro,'--','python3','-c',program,JSON.stringify(proofPins)],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4096}));
  if(JSON.stringify(actual)!==JSON.stringify(proofPins.map(p=>p.sha256)))throw Error('Prepared proof pin');
};
const frozenOptions={files:declaredFiles,paths:[root,rosen,config.ergoRuntime],gitRoot:rosen,expectedHead:'1edc2fb982de4560c5265e04e2ed8b93d00b40df',validateSets:verifySourceSet,checks:[verifyProofPins]};
freezeInputs(frozenOptions);
if(args['check-only']){console.log(JSON.stringify({verified:true,fileCount:manifest.fileCount,aggregateSha256:manifest.aggregateSha256}));process.exit(0);}
mkdirSync(work);const fixture=join(work,'fixture'),runtime=join(work,'runtime'),trace=join(work,'trace');mkdirSync(fixture);mkdirSync(runtime);mkdirSync(trace);
for(const entry of manifest.files){const target=join(fixture,entry.path);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(root,entry.path),target);}
copyFileSync(join(root,'source-manifest.json'),join(fixture,'source-manifest.json'));
const linkType=process.platform==='win32'?'junction':'dir';
for(const [from,to]of [[join(rosen,'node_modules'),join(fixture,'node_modules')],[join(rosen,'node_modules'),join(fixture,'consumer/node_modules')],[join(rosen,'services/guard-service/node_modules'),join(fixture,'guard-service/node_modules')]])symlinkSync(from,to,linkType);
const runtimeConfig=join(work,'configuration.json'),runtimeConfigBytes=JSON.stringify({...config,runtimeDirectory:runtime});writeFileSync(runtimeConfig,runtimeConfigBytes,{flag:'wx'});
const skippedLinks=new Set(['node_modules','consumer/node_modules','guard-service/node_modules']);
const closure=freezeInputs({...frozenOptions,files:[...declaredFiles,...manifest.files.map(e=>({path:join(fixture,e.path),sha256:e.sha256})),{path:join(fixture,'source-manifest.json'),sha256:args['manifest-sha256']},{path:runtimeConfig,sha256:sha(runtimeConfigBytes)}],
  paths:[...frozenOptions.paths,...[...skippedLinks].map(p=>join(fixture,p))],validateSets:()=>{verifySourceSet();if(JSON.stringify(list(fixture,'',skippedLinks).sort(ordinal))!==JSON.stringify([...names,'source-manifest.json'].sort(ordinal)))throw Error('Exact copied source set changed');}});
const proofConfig=JSON.stringify(Object.fromEntries(['proofBinary','proofBinarySha256','proofLibrary','proofLibrarySha256'].map(k=>[k,config[k]])));
const runId=randomUUID(),cwd=join(fixture,'consumer');
const env={...process.env,ROUNDTRIP_CONFIG:runtimeConfig,ROUNDTRIP_PROOF_CONFIG:proofConfig,WSLENV:[process.env.WSLENV,'ROUNDTRIP_PROOF_CONFIG'].filter(Boolean).join(':'),PARTICIPANT_SHA256:config.nativeSha256,MONERO_NODE_NATIVE_SHA256:config.nativeSha256,PARTICIPANT_BIN:config.nativeBinary,W1HB_RUN_ID:runId,W1HB_TRACE_DIR:trace,W1HC_SPEC:spec,NODE_OPTIONS:'--experimental-vm-modules --import ./observe.mjs --import tsx --import '+pathToFileURL(join(fixture,'ergo-node/deposit-register.mjs')).href};
const command=[join(rosen,'node_modules/vitest/vitest.mjs'),args['collect-only']?'list':'run','--config',testConfig,...(args['collect-only']?[]:['--reporter','verbose'])];
writeFileSync(join(work,'execution-before.json'),JSON.stringify({runId,profile,manifestSha256:args['manifest-sha256'],aggregateSha256:manifest.aggregateSha256,nodeSha256:sha(readFileSync(process.execPath)),nativeSha256:config.nativeSha256,moneroDaemonSha256:config.moneroDaemonSha256,...(observerFiles.length?{observerSha256:config.observerSha256}:{}),...(config.collisionExperiment?{collisionExperiment:config.collisionExperiment,collisionSha256:config.collisionSha256}:{}),command},null,2),{flag:'wx'});
const child=spawn(process.execPath,command,{cwd,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']}),stdout=[],stderr=[];
child.stdout.on('data',x=>stdout.push(Buffer.from(x)));child.stderr.on('data',x=>stderr.push(Buffer.from(x)));
const code=await new Promise((ok,bad)=>{child.once('error',bad);child.once('close',ok);});
writeFileSync(join(work,'stdout.log'),Buffer.concat(stdout),{flag:'wx'});writeFileSync(join(work,'stderr.log'),Buffer.concat(stderr),{flag:'wx'});
let unchanged=false,verificationFailure;
try{unchanged=closure.verify();}catch(error){
  verificationFailure={phase:'post-run',category:error?.code==='ETIMEDOUT'?'read-timeout':'input-verification-failed',code:['ETIMEDOUT','ENOENT','EACCES','EPERM'].includes(error?.code)?error.code:'VERIFICATION_FAILED'};
}
writeFileSync(join(work,'execution-after.json'),JSON.stringify({runId,exitCode:code,inputsUnchanged:unchanged,...(verificationFailure?{verificationFailure}:{})}),{flag:'wx'});
console.log(JSON.stringify({exitCode:code,inputsUnchanged:unchanged,aggregateSha256:manifest.aggregateSha256}));process.exitCode=code===0&&unchanged?0:1;
