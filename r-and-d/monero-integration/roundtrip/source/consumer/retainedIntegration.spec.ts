import {once} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {DataSource} from '@rosen-bridge/extended-typeorm';
import EventOrder from '../guard-service/src/event/eventOrder';
import {launchReservedNative} from './adapter';
import {fixture,recipient} from './projectionFixture';
import {fromJson,getTxDataHash,verify} from './integration';
import {setFixtureChain} from './resolver';
import {nativePin} from './nativePin';
import {trace} from './trace';

const probes=vi.hoisted(()=>({children:[] as {child:any;phases:string[]}[],admissions:0}));
vi.mock('node:child_process',async(original)=>{
  const actual=await original<typeof import('node:child_process')>();
  return {...actual,spawn:(...args:any[])=>{
    const child=Reflect.apply(actual.spawn,undefined,args);
    const entry={child,phases:[] as string[]};probes.children.push(entry);
    let pending='';
    child.stderr?.on('data',(chunk:Buffer)=>{
      pending+=chunk.toString('ascii');if(pending.length>4096)throw Error('Fixture stderr exceeded bound');
      const lines=pending.split('\n');pending=lines.pop()!;
      for(const line of lines)if(/^host:[a-z-]+$/.test(line)){
        entry.phases.push(line);trace('native-phase',{phase:line});
      }
    });
    return child;
  }};
});
const admission=()=>{probes.admissions++;trace('admission-observed',{});};
beforeAll(()=>process.on('w1hc-admission',admission));
afterAll(()=>process.off('w1hc-admission',admission));
let closes:(()=>Promise<void>)[]=[];
beforeEach(()=>{probes.children=[];probes.admissions=0;closes=[];});
afterEach(async()=>{
  for(const close of closes)await close();
  for(const {child} of probes.children)if(child.exitCode===null&&child.signalCode===null){
    const ended=once(child,'close');child.kill();await ended;
  }
  setFixtureChain(undefined);vi.restoreAllMocks();
});
function setup(){const root=mkdtempSync(join(nativePin.runtime,'test-'));return {database:join(root,'reservation.sqlite'),clock:()=>1000n,leaseDuration:1000000n};}
async function stored(database:string){
  const ds=new DataSource({type:'sqlite',database,entities:[],synchronize:false,logging:false});
  await ds.initialize();try{return {states:await ds.query('SELECT state FROM monero_withdrawal_reservation'),
    outputs:await ds.query('SELECT COUNT(*) AS count FROM monero_withdrawal_output')};}finally{await ds.destroy();}
}

describe('retained actual request / reservation / native / Rosen join',()=>{
  it('admits the exact native candidate only after actual commit, then revokes on close',async()=>{
    const calls=vi.spyOn(EventOrder,'createEventPaymentOrder');
    const {request,chain}=await fixture();const state=setup();const phases:string[]=[];
    const owner=await launchReservedNative(request,{...state,fault:point=>{
      phases.push(point);trace('registry-phase',{phase:point});
      if(point==='construct-before-commit'||point==='construct-after-commit')expect(probes.admissions).toBe(0);
    }});closes.push(owner.close);
    expect(calls.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(probes.admissions).toBe(1);expect(phases).toContain('construct-after-commit');
    expect(probes.children).toHaveLength(1);expect(probes.children[0].phases).toContain('host:sealed-two');
    const tx=owner.transaction;const json=tx.toJson();const digest=getTxDataHash(tx);
    expect(tx.eventId).toBe(request.eventId);expect(await verify(fromJson(json))).toBe(true);
    expect(chain.calls).toEqual(['consistency','fee','no-burn','extra']);
    const order=chain.extractTransactionOrder(tx);expect(order[0].address).toBe(recipient);
    expect(order[0].assets.nativeToken).toBe(1000000000n);
    expect((await stored(state.database)).states).toEqual([{state:'completed'}]);
    expect(Number((await stored(state.database)).outputs[0].count)).toBe(2);
    const pending=verify(tx);const closing=owner.close();await expect(pending).rejects.toThrow();await closing;
    expect(()=>fromJson(json)).toThrow();expect(()=>getTxDataHash(tx)).toThrow();
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(probes.children[0].child.exitCode!==null||probes.children[0].child.signalCode!==null).toBe(true);
  });
  it.each(['construct-before-commit','construct-after-commit'] as const)('%s failure admits nothing and preserves input exclusion',async(point)=>{
    const {request}=await fixture();const state=setup();let reached=false;
    await expect(launchReservedNative(request,{...state,fault:at=>{
      if(at===point){reached=true;trace('fault-observed',{fault:point});throw Error('Injected commit boundary failure');}
    }})).rejects.toThrow();
    expect(reached).toBe(true);expect(probes.admissions).toBe(0);
    expect(probes.children).toHaveLength(1);expect(probes.children[0].phases).toContain('host:sealed-two');
    const row=await stored(state.database);expect(row.states).toEqual([{state:point==='construct-before-commit'?'claimed':'completed'}]);
    expect(Number(row.outputs[0].count)).toBe(2);
    expect(probes.children[0].child.exitCode!==null||probes.children[0].child.signalCode!==null).toBe(true);
  });
  it('expired offer-to-grant deadline blocks the actual claim continuation without waiting for timers',async()=>{
    const {request}=await fixture();const state=setup();let now=0,reached=false;
    await expect(launchReservedNative(request,{...state,monotonicNow:()=>now,fault:point=>{
      if(point==='claim-after-commit'){reached=true;now=180001;trace('fault-observed',{fault:'monotonic-expiry'});}
    }})).rejects.toThrow();
    expect(reached).toBe(true);expect(probes.admissions).toBe(0);
    expect(probes.children[0].phases).toContain('host:offer-held');
    expect(probes.children[0].phases).not.toContain('host:grant-accepted');
    expect((await stored(state.database)).states).toEqual([{state:'claimed'}]);
  });
  it.each(['stdout','stderr'] as const)('observed %s read error revokes retained ownership and retires the child',async(stream)=>{
    const {request,chain}=await fixture();const owner=await launchReservedNative(request,setup());closes.push(owner.close);
    const tx=owner.transaction;expect(await verify(tx)).toBe(true);
    const entry=probes.children[0];const ended=once(entry.child,'close');
    const pending=chain.verifyPaymentTransaction(tx);
    trace('fault-observed',{fault:stream+'-read-error'});entry.child[stream].emit('error',new Error('Injected read failure'));
    await expect(pending).rejects.toThrow();await ended;expect(()=>tx.toJson()).toThrow();
  });
  it('STOP destroys actual retained holders while the command pipe remains open',async()=>{
    const {request}=await fixture();const owner=await launchReservedNative(request,setup());closes.push(owner.close);
    const entry=probes.children[0];entry.child.stdin.write('STOP\n');
    await vi.waitFor(()=>expect(entry.phases).toContain('host:retired'),{timeout:3000,interval:20});
    expect(entry.child.stdin.writableEnded).toBe(false);expect(entry.child.exitCode).toBe(null);
    trace('stop-retired-before-eof',{});await owner.close();expect(()=>owner.transaction.toJson()).toThrow();
  });
  it('a completed reservation cannot recreate admission in a replacement host',async()=>{
    const {request}=await fixture();const state=setup();
    const owner=await launchReservedNative(request,state);closes.push(owner.close);
    const json=owner.transaction.toJson();await owner.close();
    await expect(launchReservedNative(request,state)).rejects.toThrow();
    expect(probes.admissions).toBe(1);expect(probes.children).toHaveLength(2);
    expect(probes.children[1].phases).not.toContain('host:grant-accepted');expect(()=>fromJson(json)).toThrow();
    expect((await stored(state.database)).states).toEqual([{state:'completed'}]);
    expect(Number((await stored(state.database)).outputs[0].count)).toBe(2);
  });
  it('cancellation at committed transfer leaves no admitted candidate',async()=>{
    const {request}=await fixture();const state=setup();const controller=new AbortController();let reached=false;
    await expect(launchReservedNative(request,{...state,fault:point=>{
      if(point==='construct-after-commit'){reached=true;controller.abort();}
    }},controller.signal)).rejects.toThrow();
    expect(reached).toBe(true);expect(probes.admissions).toBe(0);
    expect((await stored(state.database)).states).toEqual([{state:'completed'}]);
  });
  it('host replacement across the commit await prevents old generation admission',async()=>{
    const {request}=await fixture();const state=setup();let replacement:Promise<unknown>|undefined;
    await expect(launchReservedNative(request,{...state,fault:point=>{
      if(point==='construct-after-commit')replacement=launchReservedNative({},setup()).catch(()=>undefined);
    }})).rejects.toThrow();
    expect(replacement).toBeDefined();await replacement;expect(probes.admissions).toBe(0);
    expect((await stored(state.database)).states).toEqual([{state:'completed'}]);
  });
});
