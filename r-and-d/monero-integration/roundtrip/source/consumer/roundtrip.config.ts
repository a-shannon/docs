import {defineConfig,type UserConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
import agreement from './agreement.config';
import lifecycle from './lifecyclePayment.config';
const base=agreement as UserConfig,payment=lifecycle as UserConfig;
const handler=fileURLToPath(new URL('../guard-service/src/handlers/chainHandler.ts',import.meta.url));
export default defineConfig({...base,plugins:[{name:'roundtrip-actual-registered-chain',enforce:'pre',resolveId(source,importer){
  if(importer&&source==='../handlers/chainHandler'&&/\/(agreement|verification|event)\//.test(importer.replaceAll('\\','/')))return handler;
}},...(payment.plugins??[]),...(base.plugins??[])],test:{...base.test,include:['roundtrip.spec.ts'],testTimeout:600000,hookTimeout:600000}});
