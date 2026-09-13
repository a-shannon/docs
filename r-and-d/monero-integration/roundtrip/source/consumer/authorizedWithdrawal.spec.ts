import {once} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DataSource} from '@rosen-bridge/extended-typeorm';
import {launchAuthorizedNative,recoverAuthorizedNative} from './adapter';
import {WithdrawalJournal,type JournalFault,type JournalFaultPoint} from './withdrawalJournal';
import {fixture} from './projectionFixture';
import {nativePin} from './nativePin';
import {getTxDataHash,verify} from './integration';
import {setupAgreement,state,closeAgreementDatabase} from './agreementPorts';
import {FixtureAgreement,votes} from './agreementFixture';
import {setFixtureChain} from './resolver';
import {trace} from './trace';

const probes=vi.hoisted(()=>({children:[] as {child:any;phases:string[];recovery:boolean;commands:string[];suppressedBytes:number;suppressedTag:string}[],loseFinal:false}));
vi.mock('node:child_process',async(original)=>{
  const actual=await original<typeof import('node:child_process')>();
  return {...actual,spawn:(...args:any[])=>{
    const child=Reflect.apply(actual.spawn,undefined,args);
    const recovery=Array.isArray(args[1])&&args[1][0]==='--recover';
    const entry={child,phases:[] as string[],recovery,commands:[] as string[],suppressedBytes:0,suppressedTag:''};probes.children.push(entry);
    let pending='',signSent=false,killedForLoss=false;
    const loseAfterObserved=()=>{
      if(!killedForLoss&&!recovery&&probes.loseFinal&&entry.suppressedTag==='W1HDF1\n'&&entry.phases.includes('host:terminal-committed')){
        killedForLoss=true;trace('fault-observed',{fault:'lost-final-after-terminal',suppressedBytes:entry.suppressedBytes});child.kill();
      }
    };
    if(child.stdin){const write=child.stdin.write.bind(child.stdin);child.stdin.write=(...values:any[])=>{
      const first=String(values[0]).split('\n',1)[0];
      if(/^(W1HD[QGPS]1|STOP)$/.test(first)){entry.commands.push(first);trace('native-command',{tag:first});}
      if(first==='W1HDS1')signSent=true;
      return Reflect.apply(write,undefined,values);
    };}
    // Lose only delivery after the real signing command. Never record private frames.
    const emit=child.stdout.emit.bind(child.stdout);
    child.stdout.emit=(event:string,...values:any[])=>{
      if(event==='data'&&!recovery&&probes.loseFinal&&signSent){
        entry.suppressedBytes+=values[0].length;
        entry.suppressedTag+=values[0].subarray(0,7-entry.suppressedTag.length).toString('ascii');
        loseAfterObserved();return false;
      }
      return emit(event,...values);
    };
    child.stderr?.on('data',(chunk:Buffer)=>{
      pending+=chunk.toString('ascii');if(pending.length>4096)throw Error('Fixture stderr bound');
      const lines=pending.split('\n');pending=lines.pop()!;
      for(const line of lines)if(/^host:[a-z-]+$/.test(line)){
        entry.phases.push(line);trace('native-phase',{phase:line,recovery});
        loseAfterObserved();
      }
    });
    return child;
  }};
});
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
let closes:(()=>Promise<void>)[]=[];
beforeEach(()=>{probes.children=[];probes.loseFinal=false;closes=[];});
afterEach(async()=>{
  for(const close of closes)await close();
  for(const {child} of probes.children)if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'close');child.kill();await ended;}
  await closeAgreementDatabase();setFixtureChain(undefined);vi.restoreAllMocks();
});
async function started(journalFault?:JournalFault){
  const data=await fixture();await setupAgreement(data.request.eventId);
  const authority={epoch:'1',publicKeys:state.keys,requiredSign:3,nativeParticipants:[1,2,3,4],nativeThreshold:2,nativeSelected:[1,2]};
  const database=join(mkdtempSync(join(nativePin.runtime,'joined-withdrawal-')),'reservation.sqlite');
  const owner=await launchAuthorizedNative(data.request,{database,clock:()=>1000n,leaseDuration:1000000n,authority,...(journalFault?{journalFault}:{})});closes.push(owner.close);
  return {...data,authority,database,owner};
}
async function approve(owner:Awaited<ReturnType<typeof launchAuthorizedNative>>,route='absent-receiver'){
  const agreement=new FixtureAgreement();await agreement.prepare();let timestamp=Math.floor(Date.now()/1000);
  const tx=owner.transaction;
  if(route==='creator'){agreement.addTransactionToQueue(tx);await agreement.processAgreementQueue();timestamp=agreement.candidateTime(tx)!;expect(timestamp).toBeTypeOf('number');}
  if(route==='selected-receiver'){expect(await agreement.request(tx)).toBe(true);agreement.select(tx,timestamp);}
  const signatures=await votes(tx,timestamp);
  if(route==='creator'){
    await agreement.respond(tx,1,signatures[1],timestamp);expect(agreement.takeVerifiedAgreement(getTxDataHash(tx))).toBeUndefined();
    await agreement.respond(tx,2,signatures[2],timestamp);
  }else await agreement.approve(tx,[...signatures.slice(0,3),''],timestamp);
  const receipt=agreement.takeVerifiedAgreement(getTxDataHash(owner.transaction));expect(receipt!==undefined).toBe(true);
  const approval=await owner.approve(receipt);return {agreement,approval};
}
async function entry(database:string,requestDigest:string){const journal=await WithdrawalJournal.open(database);try{return await journal.readByRequestDigest(requestDigest);}finally{await journal.close();}}
async function excluded(database:string){const db=new DataSource({type:'sqlite',database,logging:false});await db.initialize();try{
  expect(await db.query('SELECT state FROM monero_withdrawal_reservation')).toEqual([{state:'completed'}]);
  expect(Number((await db.query('SELECT COUNT(*) AS n FROM monero_withdrawal_output'))[0].n)).toBe(2);
}finally{await db.destroy();}}
function noSign(){expect(probes.children.flatMap(c=>c.phases).filter(x=>x==='host:wallet-sign-entry')).toHaveLength(0);expect(probes.children.flatMap(c=>c.commands)).not.toContain('W1HDS1');}
function recoveryOnly(){const children=probes.children.filter(c=>c.recovery);expect(children.length).toBeGreaterThan(0);for(const c of children){
  expect(c.commands).toHaveLength(0);expect(c.phases.some(x=>/sign-entry|offer-held|sealed-two|grant-accepted/.test(x))).toBe(false);
}}

it.each(['creator','selected-receiver','absent-receiver'])('%s joins actual Rosen authorization to original native signing, committed delivery and identical fresh-process recovery',async(route)=>{
  const {owner,database,request}=await started();expect(await verify(owner.transaction)).toBe(true);
  const {approval}=await approve(owner,route);noSign();
  const completed=await owner.sign();
  expect(completed.status).toBe('completed-retained-withdrawal');expect(completed.requestDigest).toBe(request.requestDigest);
  expect(completed.bindingDigest).toBe(approval.bindingDigest);expect(digest(completed.txBytes)).toBe(completed.byteDigest);
  const signer=probes.children[0];expect(signer.phases.filter(x=>x==='host:wallet-sign-entry')).toHaveLength(2);
  expect(signer.phases).toContain('host:expectation-committed');
  expect(signer.phases.indexOf('host:expectation-committed')).toBeLessThan(signer.phases.indexOf('host:wallet-sign-entry'));
  expect(signer.phases).toContain('host:terminal-committed');expect(signer.child.exitCode!==null||signer.child.signalCode!==null).toBe(true);
  expect(()=>owner.transaction.toJson()).toThrow();await expect(owner.sign()).rejects.toThrow();
  const stored=await entry(database,request.requestDigest);expect(stored?.state).toBe('completed');
  const copy=completed.txBytes;copy[0]^=1;expect(digest(completed.txBytes)).toBe(completed.byteDigest);
  const recovered=await recoverAuthorizedNative(database,completed.reservationId);recoveryOnly();
  expect(recovered.txId).toBe(completed.txId);expect(recovered.byteDigest).toBe(completed.byteDigest);
  expect(Buffer.from(recovered.txBytes).equals(Buffer.from(completed.txBytes))).toBe(true);
  expect(probes.children[1].child.pid!==signer.child.pid).toBe(true);await excluded(database);
  trace('joined-completion-recovery',{status:completed.status,route,actualWalletSignEntries:2,freshNativeRecovery:true});
});

it.each(['unapproved','committee','generation'])('refuses %s before any actual wallet sign entry',async(fault)=>{
  const {owner,database}=await started();
  if(fault!=='unapproved'){const {agreement}=await approve(owner);if(fault==='committee')state.required=4;else agreement.clearTransactions();}
  trace('fault-observed',{fault});await expect(owner.sign()).rejects.toThrow();noSign();await excluded(database);
});

it.each(['prepared-before-commit','prepared-after-commit','signing-before-commit','signing-after-commit'] as JournalFaultPoint[])('refuses %s without signing and retains input exclusion',async(fault)=>{
  let reached=false;const {owner,database,request}=await started(at=>{trace('journal-phase',{phase:at});if(at===fault){reached=true;trace('fault-observed',{fault});throw Error('Injected durable acknowledgment failure');}});
  await approve(owner);await expect(owner.sign()).rejects.toThrow();expect(reached).toBe(true);noSign();await excluded(database);
  const stored=await entry(database,request.requestDigest);expect(stored?.state??null).toBe(fault==='prepared-before-commit'?null:'quarantined');
});

it('committee drift during the durable signing acknowledgment prevents the actual command',async()=>{
  let reached=false;const {owner,database,request}=await started(at=>{
    if(at==='signing-after-commit'){reached=true;state.required=4;trace('fault-observed',{fault:'committee-at-signing-ack'});}
  });
  await approve(owner);await expect(owner.sign()).rejects.toThrow();expect(reached).toBe(true);noSign();
  expect((await entry(database,request.requestDigest))?.state).toBe('quarantined');await excluded(database);
});

it.each(['completed-before-commit','completed-after-commit'] as JournalFaultPoint[])('never delivers from failed %s and recovers the committed native transaction',async(fault)=>{
  let reached=false;const {owner,database,request}=await started(at=>{if(at===fault){reached=true;trace('fault-observed',{fault});throw Error('Injected completion acknowledgment failure');}});
  await approve(owner);await expect(owner.sign()).rejects.toThrow();expect(reached).toBe(true);
  expect(probes.children[0].phases.filter(x=>x==='host:wallet-sign-entry')).toHaveLength(2);
  const stored=await entry(database,request.requestDigest);expect(stored?.state).toBe('completed');
  const recovered=await recoverAuthorizedNative(database,stored!.anchor.reservation.reservationId);recoveryOnly();
  expect(recovered.byteDigest).toBe(stored!.final!.byteHash);expect(digest(recovered.txBytes)).toBe(recovered.byteDigest);await excluded(database);
});

it('recovers after losing the original final response without a second signing session',async()=>{
  const {owner,database,request}=await started();await approve(owner);probes.loseFinal=true;
  await expect(owner.sign()).rejects.toThrow();
  expect(probes.children[0].phases).toContain('host:terminal-committed');
  expect(probes.children[0].suppressedBytes).toBeGreaterThan(7);expect(probes.children[0].suppressedTag).toBe('W1HDF1\n');
  expect(probes.children[0].phases.filter(x=>x==='host:wallet-sign-entry')).toHaveLength(2);
  const stored=await entry(database,request.requestDigest);expect(stored?.state).toBe('completed');
  const recovered=await recoverAuthorizedNative(database,stored!.anchor.reservation.reservationId);recoveryOnly();
  expect(digest(recovered.txBytes)).toBe(stored!.final!.byteHash);await excluded(database);
  trace('lost-delivery-recovered',{actualWalletSignEntries:2,freshNativeRecovery:true});
});
