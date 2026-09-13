// Explicit invalid-transport substitution: production pin check remains unchanged.
import {defineConfig} from 'vitest/config';
import base from './vitest.config';
import {trace} from './trace';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export default defineConfig({...base,plugins:[...(base.plugins??[]),{name:'invalid-host-transport-only',enforce:'pre',transform(code,id){if(id.replaceAll('\\','/').endsWith('/consumer/adapter.ts')){
 const a='spawn(nativePin.path,[runtime]',b='setTimeout(fail,180000)',catchAnchor='} catch {fail();}',exitAnchor="child.once('exit',()=>{invalidate();});",stderrAnchor='if(stderr>4096)fail();';
 for(const anchor of [a,b,catchAnchor,exitAnchor,stderrAnchor,'const rows=framer.push(raw)','stderr+=raw.length'])if(code.split(anchor).length!==2)throw Error('Fixture source drift');
 const host=JSON.stringify(fileURLToPath(new URL('./hostile-host.mjs',import.meta.url)));
 const observe=(channel:string)=>`process.emit('w1hb-transport',{mode:process.env.W1HB_HOSTILE,channel:'${channel}',bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')});`;
 const rejection=(stage:string)=>`process.emit('w1hb-transport-reject',{mode:process.env.W1HB_HOSTILE,stage:${stage}});`;
 const mutated=code.replace(a,`spawn(process.execPath,[${host}]`).replace(b,`setTimeout(()=>{${rejection("'timeout'")}fail();},3000)`).replace('const rows=framer.push(raw)',observe('stdout')+'const rows=framer.push(raw)').replace('stderr+=raw.length',observe('stderr')+'stderr+=raw.length').replace(catchAnchor,`} catch(error) {${rejection('(error as Error).message')}fail();}`).replace(exitAnchor,`child.once('exit',()=>{if(!settled){${rejection("'exit-before-admission'")}}invalidate();});`).replace(stderrAnchor,`if(stderr>4096){${rejection("'stderr-bound'")}fail();}`);
 trace('transport-mutation',{original:createHash('sha256').update(code).digest('hex'),mutated:createHash('sha256').update(mutated).digest('hex')});return mutated;
 }}}],test:{...base.test,include:['transport-fixture.spec.ts'],testTimeout:10000}});
