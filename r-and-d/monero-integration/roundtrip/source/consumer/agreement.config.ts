import {defineConfig,type UserConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
import retained from './retained.config';
import {trace} from './trace';
const normalize=(path:string)=>path.replaceAll('\\','/').replace(/^\/@fs\//,'');
const local=(path:string)=>normalize(fileURLToPath(new URL(path,import.meta.url)));
const roots=new Set(['agreement/txAgreement.ts','verification/requestVerifier.ts','verification/transactionVerifier.ts','verification/eventVerifier.ts'].map(p=>local('../guard-service/src/'+p)));
const services=new Set(['../communication/rosenDialer','../configs/configs','../db/databaseAction','../db/databaseHandler','../handlers/guardPkHandler','../handlers/minimumFeeHandler','../utils/constants','../utils/guardTurn']);
const base=retained as UserConfig;
export default defineConfig({...base,plugins:[{name:'actual-agreement-fixture-facts',enforce:'pre',resolveId(source,importer){
  if(!importer)return;const from=normalize(importer.split('?')[0]);if(!roots.has(from))return;
  let target:string|undefined;
  if(source==='../handlers/chainHandler')target='resolver.ts';
  else if(services.has(source)||source==='@rosen-chains/ergo')target='agreementPorts.ts';
  else if(['../configs/guardsErgoConfigs','../event/eventBoxes','../synchronization/eventSynchronization'].includes(source))target='isolation.ts';
  if(target){const path=local('./'+target);trace('alias',{source,importer,path});return path;}
}},...(base.plugins??[])],test:{...base.test,include:[process.env.W1HC_SPEC??'approvalAuthority.spec.ts']}});
