import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {captureContributionPackage} from '../tools/contribution-package.mjs';
const require=createRequire(config.rosenRoot+'/package.json');
const ts=require('typescript');
const contribution=config.contributionPackage?captureContributionPackage(config.contributionPackage):undefined;
export async function resolve(specifier,context,next){
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
