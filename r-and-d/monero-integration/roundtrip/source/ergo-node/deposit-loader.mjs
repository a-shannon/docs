import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {captureContributionPackage} from '../tools/contribution-package.mjs';
const require=createRequire(config.rosenRoot+'/package.json');
const ts=require('typescript');
const contribution=config.contributionPackage?captureContributionPackage(config.contributionPackage):undefined;
// The opt-in local roundtrip uses the same explicit service ports as the
// existing retained/agreement/lifecycle Vitest compositions. Transaction,
// request, agreement, journal and payment validation still load their real code.
function roundtripPort(specifier,parent){
  if(config.v2Return!==true)return;
  const from=parent?.split('?')[0],is=relative=>from===sourceURL('guard-service/src/'+relative);
  const agreement=['agreement/txAgreement.ts','verification/requestVerifier.ts','verification/transactionVerifier.ts','verification/eventVerifier.ts'].some(is);
  if(agreement){
    if(specifier==='../handlers/chainHandler')return sourceURL('guard-service/src/handlers/chainHandler.ts');
    if(['../communication/rosenDialer','../configs/configs','../db/databaseAction','../db/databaseHandler','../handlers/guardPkHandler','../handlers/minimumFeeHandler','../utils/constants','../utils/guardTurn','@rosen-chains/ergo'].includes(specifier))return sourceURL('consumer/agreementPorts.ts');
    if(['../configs/guardsErgoConfigs','../event/eventBoxes','../synchronization/eventSynchronization'].includes(specifier))return sourceURL('consumer/isolation.ts');
  }
  if(is('event/eventOrder.ts')){
    if(specifier==='../handlers/chainHandler')return sourceURL('consumer/resolver.ts');
    if(specifier==='../handlers/tokenHandler')return sourceURL('consumer/fixturePorts.ts');
    if(['../configs/guardsErgoConfigs','./eventBoxes'].includes(specifier))return sourceURL('consumer/isolation.ts');
  }
  if(is('utils/utils.ts')&&specifier==='./constants')return sourceURL('consumer/fixturePorts.ts');
  if(['handlers/chainHandler.ts','transaction/transactionProcessor.ts','utils/constants.ts'].some(is)&&specifier.startsWith('@rosen-chains/')&&specifier!=='@rosen-chains/abstract-chain')return sourceURL('consumer/lifecycleChainFacts.ts');
  if(is('handlers/chainHandler.ts')&&(specifier.startsWith('../configs/')||['src/db/databaseAction','../db/dataSource','./multiSigHandler','./tokenHandler','./tssHandler'].includes(specifier)))return sourceURL('consumer/lifecyclePorts.ts');
  if(is('transaction/transactionProcessor.ts')&&['../db/databaseAction','../configs/guardsDogeConfigs','../handlers/notificationHandler'].includes(specifier))return sourceURL('consumer/lifecyclePorts.ts');
}
export async function resolve(specifier,context,next){
  const port=roundtripPort(specifier,context.parentURL);if(port)return next(port,context);
  if(specifier==='@rosen-bridge/monero-deposit')return next(sourceURL('packages/monero-deposit/lib/index.ts'),context);
  if(contribution&&specifier==='@rosen-bridge/ergo-multi-sig')return next(contribution.entry,context);
  if(contribution&&context.parentURL?.startsWith(contribution.prefix)&&!specifier.startsWith('.')&&!specifier.startsWith('node:'))
    return next(pathToFileURL(require.resolve(specifier)).href,context);
  try{return await next(specifier,context);}catch(error){
    const choices=[specifier+'.js',specifier+'.ts',specifier+'/index.js',specifier+'/index.ts'];
    if(specifier.endsWith('.js'))choices.unshift(specifier.slice(0,-3)+'.ts');
    for(const candidate of choices){try{return await next(candidate,context);}catch{}}
    throw error;
  }
}
export async function load(url,context,next){
  if(contribution&&url.startsWith(contribution.prefix)){
    const source=contribution.read(url);
    return {format:url.endsWith('.json')?'json':'module',shortCircuit:true,source};
  }
  if(url.endsWith('.ts'))return {format:'module',shortCircuit:true,source:ts.transpileModule(await fs.readFile(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,experimentalDecorators:true,emitDecoratorMetadata:false,useDefineForClassFields:false}}).outputText};
  return next(url,context);
}
