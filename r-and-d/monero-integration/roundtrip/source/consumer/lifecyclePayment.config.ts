import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { trace } from './trace';
const normalize = (s: string) => s.replaceAll('\\', '/').replace(/^\/@fs\//, '');
const local = (s: string) => normalize(fileURLToPath(new URL(s, import.meta.url)));
const chain = local('../guard-service/src/handlers/chainHandler.ts');
const processor = local('../guard-service/src/transaction/transactionProcessor.ts');
const constants = local('../guard-service/src/utils/constants.ts');
export default defineConfig({ cacheDir: process.env.W1HB_TRACE_DIR + '/cache', plugins: [{
  name: 'actual-payment-processor-scoped-bootstrap-facts', enforce: 'pre',
  resolveId(source, importer) {
    if (!importer) return;
    const from = normalize(importer.split('?')[0]);
    if ([chain,processor,constants].includes(from) && source.startsWith('@rosen-chains/') && source !== '@rosen-chains/abstract-chain') return local('./lifecycleChainFacts.ts');
    if (from === chain && (source.startsWith('../configs/') || ['src/db/databaseAction','../db/dataSource','./multiSigHandler','./tokenHandler','./tssHandler'].includes(source))) return local('./lifecyclePorts.ts');
    if (from === processor && ['../db/databaseAction','../configs/guardsDogeConfigs','../handlers/notificationHandler'].includes(source)) return local('./lifecyclePorts.ts');
  },
  transform(code, id) {
    const path = normalize(id.split('?')[0]);
    if (/^[A-Za-z]:\//.test(path)) { const raw = readFileSync(path); trace('vite-raw', { path, bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') }); }
  },
}, { name: 'payment-lifecycle-transformed-evidence', enforce: 'post', transform(code,id) {
  const path = normalize(id.split('?')[0]); trace('vite-transformed',{path,bytes:Buffer.byteLength(code),sha256:createHash('sha256').update(code).digest('hex')},code);
} }], test: { environment:'node', globals:true, setupFiles:['./setup.ts'], include:[process.env.W1HC_SPEC ?? 'lifecyclePayment.spec.ts'], pool:'forks',poolOptions:{forks:{singleFork:true}}, testTimeout:200000,hookTimeout:200000 } });
