// Isolated lifecycle fault injection against the actual privately owned child.
import {defineConfig} from 'vitest/config';
import base from './vitest.config';
import {trace} from './trace';
import {createHash} from 'node:crypto';
const fault=process.env.W1HB_FAULT;
if(fault!=='exit'&&fault!=='late-data'&&fault!=='error')throw Error('Explicit lifecycle fault required');
const change=fault==='exit'?'child.kill();':fault==='late-data'?"child.stdout.emit('data',Buffer.from('X'));":"child.emit('error',Error('Synthetic observed pipe error'));";
export default defineConfig({...base,plugins:[...(base.plugins??[]),{name:'owned-child-lifecycle-negative',enforce:'pre',transform(code,id){if(id.replaceAll('\\','/').endsWith('/consumer/adapter.ts')){const anchor='resolve(tx);';if(code.split(anchor).length!==2)throw Error('Fixture source drift');const mutated=code.replace(anchor,anchor+`setTimeout(()=>{${change}process.emit('w1hb-fault',{fault:'${fault}'});},100);`);trace('lifecycle-mutation',{fault,original:createHash('sha256').update(code).digest('hex'),mutated:createHash('sha256').update(mutated).digest('hex'),change});return mutated;}}}],test:{...base.test,include:['lifecycle-fixture.spec.ts']}});
