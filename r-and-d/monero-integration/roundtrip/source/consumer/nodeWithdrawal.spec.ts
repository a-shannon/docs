import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {launchAuthorizedNative,recoverAuthorizedNative,MoneroChain} from './adapter';
import {terms} from './projectionFixture';
import {configureFixtureTokens} from './fixturePorts';
import {buildUnapprovedMoneroPayout} from '../guard-service/src/withdrawal/moneroWithdrawalOrder';
import {WithdrawalJournal} from './withdrawalJournal';
import {nativePin} from './nativePin';
import {getTxDataHash,verify} from './integration';
import {setupAgreement,state,closeAgreementDatabase} from './agreementPorts';
import {FixtureAgreement,votes} from './agreementFixture';
import {setFixtureChain} from './resolver';
import {LocalMonero,daemonPin} from './localMonero';
import {trace} from './trace';

const probes=vi.hoisted(()=>({children:[] as {child:any;args:string[];phases:string[]}[]}));
vi.mock('node:child_process',async(original)=>{
  const actual=await original<typeof import('node:child_process')>();
  return {...actual,spawn:(...args:any[])=>{
    const child=Reflect.apply(actual.spawn,undefined,args);
    if(String(args[0]).endsWith('synthetic-candidate-host.exe')){
      const entry={child,args:args[1] as string[],phases:[] as string[]};probes.children.push(entry);let pending='';
      child.stderr?.on('data',(chunk:Buffer)=>{pending+=chunk.toString('ascii');if(pending.length>4096)throw Error('Native stderr bound');
        const lines=pending.split('\n');pending=lines.pop()!;for(const line of lines)if(/^host:[a-z-]+$/.test(line)){
          entry.phases.push(line);trace('native-phase',{phase:line,recovery:entry.args[0]==='--recover'});
        }
      });
    }
    return child;
  }};
});
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
let node:LocalMonero|undefined,closes:(()=>Promise<void>)[]=[];
beforeEach(async()=>{
  probes.children=[];closes=[];node=await LocalMonero.start();process.env.MONERO_LOCAL_RPC_PORT=String(node.port);
  trace('local-daemon',{nettype:'fakechain',offline:true,peers:0,hardfork:16,daemonSha256:daemonPin.sha256,nativeSha256:nativePin.sha256});
});
afterEach(async()=>{
  const errors:Error[]=[];
  const bounded=async(operation:()=>Promise<void>)=>{let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Cleanup deadline')),5000);})]);}
    catch{errors.push(Error('Fixture cleanup failed'));}finally{clearTimeout(timer);}
  };
  try{
    for(const close of closes)await bounded(close);
    for(const {child} of probes.children)await bounded(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();
      while(child.exitCode===null&&child.signalCode===null)await delay(25);
    }});
    await bounded(closeAgreementDatabase);
  }finally{
    setFixtureChain(undefined);delete process.env.MONERO_LOCAL_RPC_PORT;
    try{await node?.stop();}catch{errors.push(Error('Owned daemon cleanup failed'));}
    finally{node=undefined;vi.restoreAllMocks();}
  }
  if(errors.length)throw new AggregateError(errors,'Fixture cleanup');
});
async function nativeResult(args:string[]):Promise<{code:number|null;text:string}>{
  const child=spawn(nativePin.path,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
  let text='',failed=false;
  const timer=setTimeout(()=>{failed=true;child.kill();},30000);
  child.stdout.on('data',chunk=>{text+=chunk.toString('ascii');if(text.length>4096){failed=true;child.kill();}});
  const [code]=await once(child,'close');clearTimeout(timer);
  if(failed)throw Error('Native node observation bound');return {code,text:text.trim()};
}
async function nativeCommand(args:string[]):Promise<string>{
  const result=await nativeResult(args);if(result.code!==0)throw Error('Native node observation failed');return result.text;
}
async function completedWithdrawal(){
  const data=terms();data.profile.maxMinerFeeAtomic='1000000000000';await configureFixtureTokens(data.profile.tokens);
  const chain=await MoneroChain.create();setFixtureChain(chain);
  const request=await buildUnapprovedMoneroPayout(data.source,data.profile);await setupAgreement(request.eventId);
  const database=join(mkdtempSync(join(nativePin.runtime,'node-withdrawal-')),'reservation.sqlite');
  const authority={epoch:'1',publicKeys:state.keys,requiredSign:3,nativeParticipants:[1,2,3,4],nativeThreshold:2,nativeSelected:[1,2]};
  const owner=await launchAuthorizedNative(request,{database,clock:()=>1000n,leaseDuration:1000000n,authority});closes.push(owner.close);
  expect(await verify(owner.transaction)).toBe(true);
  const assets=await chain.getTransactionAssets(owner.transaction),order=chain.extractTransactionOrder(owner.transaction);
  const amount=order[0].assets.nativeToken,fee=assets.inputAssets.nativeToken-assets.outputAssets.nativeToken,change=assets.outputAssets.nativeToken-amount;
  expect(amount).toBe(1000000000n);expect(fee>0n&&change>0n).toBe(true);
  const agreement=new FixtureAgreement();await agreement.prepare();const timestamp=Math.floor(Date.now()/1000);
  const signatures=await votes(owner.transaction,timestamp);await agreement.approve(owner.transaction,[...signatures.slice(0,3),''],timestamp);
  const receipt=agreement.takeVerifiedAgreement(getTxDataHash(owner.transaction));expect(receipt!==undefined).toBe(true);
  await owner.approve(receipt);expect(probes.children.flatMap(p=>p.phases).filter(p=>p==='host:wallet-sign-entry')).toHaveLength(0);
  const native=probes.children.find(p=>!p.args[0].startsWith('--'))!;
  const result=await owner.sign();
  expect(native.phases.filter(p=>p==='host:wallet-sign-entry')).toHaveLength(2);
  const recovered=await recoverAuthorizedNative(database,result.reservationId);
  expect(recovered.txId).toBe(result.txId);expect(digest(recovered.txBytes)).toBe(result.byteDigest);
  expect(Buffer.from(recovered.txBytes).equals(Buffer.from(result.txBytes))).toBe(true);
  return {result,recovered,database,request,directory:native.args[0],amount,fee,change};
}
function refusal(result:any){
  expect(result.status).not.toBe('OK');
  return {status:String(result.status),invalidInput:result.invalid_input===true,invalidOutput:result.invalid_output===true,
    doubleSpend:result.double_spend===true,verificationFailed:result.verification_failed===true,lowFee:result.fee_too_low===true};
}

it('accepts and includes the exact authorized withdrawal and scans recipient plus vault change',async()=>{
  const {result,recovered,directory,amount,fee,change}=await completedWithdrawal();
  const altered=Buffer.from(result.txBytes);altered[altered.length-1]^=1;
  const rejected=refusal(await node!.submit(altered));trace('altered-final-rejected',rejected);
  const accepted=await node!.submit(recovered.txBytes);expect(accepted.status).toBe('OK');expect(accepted.double_spend).not.toBe(true);
  const pending=await node!.transaction(result.txId);expect(pending.txs).toHaveLength(1);expect(pending.txs[0].in_pool).toBe(true);
  trace('node-accepted',{txId:result.txId,byteDigest:result.byteDigest,actualWalletSignEntries:2});
  const address=await nativeCommand(['--node-address']);expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{95}$/);
  await node!.mine(1,address);
  const observed=await node!.transaction(result.txId);expect(observed.txs).toHaveLength(1);expect(observed.txs[0].in_pool).toBe(false);
  expect(observed.txs[0].tx_hash).toBe(result.txId);
  const scan=JSON.parse(await nativeCommand(['--node-observe',directory,result.txId,String(amount),String(fee),String(change)]));
  expect(scan).toEqual({status:'node-observed',txId:result.txId,blockHeight:observed.txs[0].block_height,
    recipientAtomic:String(amount),changeAtomic:String(change),feeAtomic:String(fee),recipientOutputs:1,changeOutputs:1});
  trace('node-confirmed-scanned',{...scan,inputAtomic:String(amount+fee+change),byteDigest:result.byteDigest});
  const valid=['--node-observe',directory,result.txId,String(amount),String(fee),String(change)];
  for(const [index,replacement,label] of [[2,'0'.repeat(64),'transaction'],[3,String(amount+1n),'recipient-amount'],
    [4,String(fee+1n),'fee'],[5,String(change+1n),'change-amount']] as const){
    const args=[...valid];args[index]=replacement;const refused=await nativeResult(args);
    expect(refused.code).not.toBe(0);expect(refused.text).toBe('');
    trace('scanner-mismatch-rejected',{field:label,nonzeroExit:true,noObservationResult:true});
  }
  expect(probes.children.flatMap(p=>p.phases).filter(p=>p==='host:wallet-sign-entry')).toHaveLength(2);
});

it('rejects the same signed bytes after their actual funding leaves the canonical chain',async()=>{
  const {result,database,request}=await completedWithdrawal();
  expect((await node!.submit(result.txBytes)).status).toBe('OK');
  const accepted=await node!.transaction(result.txId);expect(accepted.txs).toHaveLength(1);expect(accepted.txs[0].in_pool).toBe(true);
  expect((await node!.rpc('flush_txpool',{txids:[result.txId]})).status).toBe('OK');
  expect((await node!.transaction(result.txId)).txs??[]).toHaveLength(0);
  const before=await node!.isolated();expect(before.height).toBeGreaterThan(60);
  const popped=await node!.call('/pop_blocks',{nblocks:before.height-1});expect(popped.status).toBe('OK');expect((await node!.isolated()).height).toBe(1);
  const rejected=refusal(await node!.submit(result.txBytes));
  expect(rejected.invalidInput).toBe(true);
  const missing=await node!.transaction(result.txId);expect(missing.txs??[]).toHaveLength(0);
  const journal=await WithdrawalJournal.open(database);try{expect((await journal.readByRequestDigest(request.requestDigest))?.state).toBe('completed');}finally{await journal.close();}
  const recovered=await recoverAuthorizedNative(database,result.reservationId);expect(recovered.byteDigest).toBe(result.byteDigest);
  expect(probes.children.flatMap(p=>p.phases).filter(p=>p==='host:wallet-sign-entry')).toHaveLength(2);
  trace('canonical-funding-removed',{...rejected,committedBytesPreserved:true,newSigningAttempts:0});
});
