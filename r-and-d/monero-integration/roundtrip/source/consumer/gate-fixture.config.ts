// Isolated test-only source mutation. Never used by normal consumer execution.
import {defineConfig} from 'vitest/config';
import base from './vitest.config';
import {trace} from './trace';
import {createHash} from 'node:crypto';
const gate=process.env.W1HB_GATE;
const mutations:Record<string,string>={fee:'s.ceiling=s.fee-1n;',conservation:'s.input=s.input-1n;',change:"s.spend='0'.repeat(64);",consistency:"Object.defineProperty(s,'eventId',{value:'0'.repeat(64)});",'zero-change':'s.change=0n;'};
if(!gate||!mutations[gate])throw Error('Explicit isolated gate required');
export default defineConfig({...base,plugins:[...(base.plugins??[]),{name:'explicit-private-snapshot-negative',enforce:'pre',transform(code,id){if(id.replaceAll('\\','/').endsWith('/consumer/adapter.ts')){const anchor=gate==='consistency'?"this.calls.push('consistency');":"s.live();if(admitted.has(s.json))";if(code.split(anchor).length!==2)throw Error('Fixture source drift');const change=(gate==='consistency'?"const s=brands.get(tx)!;"+mutations[gate]:mutations[gate])+`process.emit('w1hb-fault',{gate:'${gate}'});`;const mutated=code.replace(anchor,gate==='consistency'?anchor+change:change+anchor);trace('gate-mutation',{gate,original:createHash('sha256').update(code).digest('hex'),mutated:createHash('sha256').update(mutated).digest('hex'),change});return mutated;}}}],test:{...base.test,include:['gate-fixture.spec.ts']}});
