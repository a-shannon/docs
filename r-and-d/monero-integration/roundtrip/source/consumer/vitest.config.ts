import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import {defineConfig} from 'vitest/config';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {trace} from './trace';
const normalize=(s:string)=>s.replaceAll('\\','/').replace(/^\/@fs\//,'');
const verifier=normalize(fileURLToPath(new URL('../guard-service/src/verification/transactionVerifier.ts',import.meta.url)));
const seams=new Set(['../configs/configs','../db/databaseAction','../db/databaseHandler','../event/eventOrder','../handlers/minimumFeeHandler','../utils/constants']);
export default defineConfig({cacheDir:process.env.W1HB_TRACE_DIR+'/cache',plugins:[{
 name:'exact-common-only-seams',enforce:'pre',
 resolveId(source,importer){if(importer&&normalize(importer.split('?')[0])===verifier){const target=source==='../handlers/chainHandler'?'resolver.ts':seams.has(source)?'isolation.ts':undefined;if(target){const path=fileURLToPath(new URL(target,import.meta.url));trace('alias',{source,importer,path});return path;}}},
 transform(_code,id){const path=normalize(id.split('?')[0]);if(/^[A-Za-z]:\//.test(path)){const raw=readFileSync(path);trace('vite-raw',{path,bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')});}}
},{name:'post-transform-observer',enforce:'post',transform(code,id){trace('vite-transformed',{path:normalize(id.split('?')[0]),bytes:Buffer.byteLength(code),sha256:createHash('sha256').update(code).digest('hex')},code);}}],test:{environment:'node',globals:true,setupFiles:['./setup.ts'],include:[process.env.W1HB_NATIVE==='1'?'integration.spec.ts':'codec.spec.ts'],pool:'forks',poolOptions:{forks:{singleFork:true}},testTimeout:200000,hookTimeout:200000}});
