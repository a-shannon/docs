import {defineConfig} from 'vitest/config';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {trace} from './trace';
const normalize=(path:string)=>path.replaceAll('\\','/').replace(/^\/@fs\//,'');
const local=(path:string)=>normalize(fileURLToPath(new URL(path,import.meta.url)));
const verifier=local('../guard-service/src/verification/transactionVerifier.ts');
const eventOrder=local('../guard-service/src/event/eventOrder.ts');
const utils=local('../guard-service/src/utils/utils.ts');
const adapter=local('./adapter.ts');
const isolated=new Set(['../configs/configs','../db/databaseAction','../db/databaseHandler','../handlers/minimumFeeHandler','../utils/constants']);
export default defineConfig({cacheDir:process.env.W1HB_TRACE_DIR+'/cache',plugins:[{
  name:'retained-exact-fixture-seams',enforce:'pre',
  resolveId(source,importer){
    if(!importer)return;const from=normalize(importer.split('?')[0]);let target:string|undefined;
    if(from===verifier)target=source==='../handlers/chainHandler'?'resolver.ts':isolated.has(source)?'isolation.ts':undefined;
    if(from===eventOrder){
      if(source==='../handlers/chainHandler')target='resolver.ts';
      else if(source==='../handlers/tokenHandler')target='fixturePorts.ts';
      else if(source==='../configs/guardsErgoConfigs'||source==='./eventBoxes')target='isolation.ts';
    }
    if(from===utils&&source==='./constants')target='fixturePorts.ts';
    if(target){const path=local('./'+target);trace('alias',{source,importer,path});return path;}
  },
  transform(code,id){
    const path=normalize(id.split('?')[0]);
    if(/^[A-Za-z]:\//.test(path)){const raw=readFileSync(path);trace('vite-raw',{path,bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')});}
    if(path===adapter){
      const needle='    admitted.set(s.json,s);\n    const transaction=new NativePayment(s);';
      if(code.split(needle).length!==2)throw Error('Admission observation seam changed');
      return code.replace(needle,"    admitted.set(s.json,s);\n    process.emit('w1hc-admission' as never);\n    const transaction=new NativePayment(s);");
    }
  }
},{name:'retained-transformed-source',enforce:'post',transform(code,id){const path=normalize(id.split('?')[0]);trace('vite-transformed',{path,bytes:Buffer.byteLength(code),sha256:createHash('sha256').update(code).digest('hex')},code);}}],
test:{environment:'node',globals:true,setupFiles:['./setup.ts'],include:[process.env.W1HC_SPEC??'retainedIntegration.spec.ts'],pool:'forks',poolOptions:{forks:{singleFork:true}},testTimeout:200000,hookTimeout:200000}});
