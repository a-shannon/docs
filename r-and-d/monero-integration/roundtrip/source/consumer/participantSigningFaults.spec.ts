import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,mkdtempSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ECDSA} from '@rosen-bridge/encryption';
import {Participant} from './participantHarness.mjs';
import * as signing from './participantSigning.mjs';
import {LocalMonero} from './localMonero';
import {MoneroChain,launchDistributedNative} from './adapter';
import {terms} from './projectionFixture';
import {configureFixtureTokens} from './fixturePorts';
import {setFixtureChain} from './resolver';
import {buildUnapprovedMoneroPayout} from '../guard-service/src/withdrawal/moneroWithdrawalOrder';
import {captureUnapprovedMoneroPayoutRequest} from '../guard-service/src/withdrawal/moneroWithdrawalNativeProjection';
import {retainedRequest} from './retainedCodec';
import {setupAgreement,state,closeAgreementDatabase} from './agreementPorts';
import {FixtureAgreement,votes} from './agreementFixture';
import {getTxDataHash,verify} from './integration';

const binary=config.nativeBinary;
const sha256=config.nativeSha256;
const runtimeRoot=config.runtimeDirectory;
const evidence=process.env.W1HB_TRACE_DIR!;
const outcomes:Array<Record<string,unknown>>=[];
const originalSend=Participant.prototype.send,originalNext=Participant.prototype.next;
const originalPrepare=signing.prepareParticipantSigning;
type Seen={child:any;exitCode:number|null|undefined;closed:boolean;stderrTail:string};
let node:LocalMonero|undefined,vault:any,caseRuntime:string;
let observed:{actors:Map<number,Seen>;proofs:number;shares:number;candidates:number;approvals:number;signEntries:number};

// Instrument the existing transport without replacing its data or verification.
// Retain only child handles, fixed phase tags and counts; never retain raw frames.
beforeEach(async()=>{
  expect(createHash('sha256').update(readFileSync(binary)).digest('hex')).toBe(sha256);
  observed={actors:new Map(),proofs:0,shares:0,candidates:0,approvals:0,signEntries:0};
  vi.spyOn(Participant.prototype,'send').mockImplementation(function(this:any,value:any){
    if(!observed.actors.has(this.id)){
      const item:Seen={child:this.child,exitCode:undefined,closed:false,stderrTail:''};
      observed.actors.set(this.id,item);
      this.child.once('exit',(code:number|null)=>{item.exitCode=code;});
      this.child.once('close',()=>{item.closed=true;});
      this.child.stderr.on('data',(bytes:Buffer)=>{
        const text=item.stderrTail+bytes.toString('ascii');
        const lines=text.split('\n');item.stderrTail=lines.pop()!.slice(-80);
        for(const line of lines)if(line==='participant:wallet-sign-entry')observed.signEntries++;
      });
    }
    if(value.type==='approve')observed.approvals++;
    return originalSend.call(this,value);
  });
  vi.spyOn(Participant.prototype,'next').mockImplementation(function(this:any,...args:any[]){
    return originalNext.apply(this,args).then((value:any)=>{
      if(value.type==='sign-peer'&&value.round===5)observed.proofs++;
      if(value.type==='sign-peer'&&value.round===8)observed.shares++;
      if(value.type==='candidate')observed.candidates++;
      return value;
    });
  });
  caseRuntime=mkdtempSync(join(runtimeRoot,'signing-faults-'));
  node=await LocalMonero.start(caseRuntime);process.env.MONERO_LOCAL_RPC_PORT=String(node.port);
});
afterEach(async()=>{
  try{await vault?.close();await closeAgreementDatabase();}
  finally{setFixtureChain(undefined);delete process.env.MONERO_LOCAL_RPC_PORT;await node?.stop();
    expect([...observed.actors.values()].every(actor=>actor.closed)).toBe(true);
    expect(node?.child.exitCode!==null||node?.child.signalCode!==null).toBe(true);
    node=undefined;vault=undefined;vi.restoreAllMocks();}
});
afterAll(()=>{writeFileSync(join(evidence,'aggregate-outcomes.json'),JSON.stringify({schema:'participant-signing-faults/v1',binarySha256:sha256,cases:outcomes},null,2)+'\n');});

async function fixture(){
  const data=terms();data.profile.maxMinerFeeAtomic='1000000000000';
  await configureFixtureTokens(data.profile.tokens);setFixtureChain(await MoneroChain.create());
  const request=await buildUnapprovedMoneroPayout(data.source,data.profile);
  vault=await signing.openParticipantVault({binary,sha256,runtime:caseRuntime});
  return {data,request};
}
function markerCounts(directory:string):Record<string,number>{
  const counts={consumed:0,terminal:0};
  for(const item of readdirSync(directory,{withFileTypes:true})){
    if(item.isDirectory()){const child=markerCounts(join(directory,item.name));counts.consumed+=child.consumed;counts.terminal+=child.terminal;}
    else if(item.name==='consumed.private')counts.consumed++;
    else if(item.name==='terminal.private')counts.terminal++;
  }
  return counts;
}

describe('authenticated signing transport process faults',()=>{
  it.each(['wrong-sender','crossed-attempt','replay'])('%s retires the native recipient before approval or signing-share release',async fault=>{
    const {request}=await fixture();
    const projection=await captureUnapprovedMoneroPayoutRequest(request);
    const nativeRequest=retainedRequest(projection,randomBytes(32).toString('hex'));
    const rosenKeys=await Promise.all([1,2,3,4].map(i=>new ECDSA(i.toString(16).padStart(64,'0')).getPk()));
    let refused=false;
    try{await signing.prepareParticipantSigning(vault,{request:nativeRequest.hex,rosenKeys,timestamp:Math.floor(Date.now()/1000),fault});}
    catch(error){refused=true;expect(String((error as Error).message)).toMatch(/^Participant (closed|unavailable|pipe closed)/);}
    expect(refused).toBe(true);
    expect(observed.proofs).toBe(2);
    expect(observed.actors.size).toBe(4);expect(observed.actors.get(2)?.exitCode).toBe(1);
    expect(observed.approvals).toBe(0);expect(observed.signEntries).toBe(0);
    expect(observed.shares).toBe(0);expect(observed.candidates).toBe(0);
    expect(markerCounts(caseRuntime)).toEqual({consumed:0,terminal:0});
    expect((await node!.call('/get_transaction_pool',{})).transactions??[]).toHaveLength(0);
    outcomes.push({fault,refused:true,participants:4,round5Responses:2,nativeRecipientExit:1,approvalCommands:0,walletSignEntries:0,signatureShares:0,consumedMarkers:0,terminalRecords:0});
  },90000);

  it('selected participant interruption after real approved shares prevents common completion and missing-terminal recovery',async()=>{
    const {request,data}=await fixture();await setupAgreement(request.eventId,data);
    vi.spyOn(signing,'prepareParticipantSigning').mockImplementation((handle:any,options:any)=>originalPrepare(handle,{...options,fault:'interrupt-after-share'}));
    const timestamp=Math.floor(Date.now()/1000);
    const authority={epoch:'1',publicKeys:state.keys,requiredSign:3,nativeParticipants:[1,2,3,4],nativeThreshold:2,nativeSelected:[1,2]};
    const owner=await launchDistributedNative(vault,request,{database:join(caseRuntime,'reservation.sqlite'),clock:()=>1000n,leaseDuration:1000000n,authority},timestamp);
    expect(await verify(owner.transaction)).toBe(true);
    const agreement=new FixtureAgreement();await agreement.prepare();const signatures=await votes(owner.transaction,timestamp);
    await agreement.approve(owner.transaction,[...signatures.slice(0,3),''],timestamp);
    const receipt=agreement.takeVerifiedAgreement(getTxDataHash(owner.transaction));expect(receipt!==undefined).toBe(true);
    await owner.approve(receipt);expect(owner.counts().shares).toBe(0);
    await expect(owner.sign()).rejects.toThrow('Participant interrupted after contribution');
    expect(observed.actors.size).toBe(4);expect(observed.actors.get(1)?.child.killed).toBe(true);
    expect(observed.approvals).toBe(2);expect(observed.signEntries).toBe(2);expect(observed.shares).toBe(2);
    expect(owner.counts().shares).toBe(2);
    expect(owner.directories.every((directory:string)=>existsSync(join(directory,'consumed.private')))).toBe(true);
    expect(existsSync(join(owner.directories[0],'terminal.private'))).toBe(false);
    await expect(signing.recoverParticipantFinal({binary,sha256,directory:owner.directories[0],expectationDigest:owner.anchor.expectationDigest})).rejects.toThrow('Participant recovery refused');
    await expect(owner.sign()).rejects.toThrow('sign-used');expect(observed.shares).toBe(2);
    expect((await node!.call('/get_transaction_pool',{})).transactions??[]).toHaveLength(0);
    outcomes.push({fault:'interrupt-after-share',refused:true,participants:4,actualRosenCertificate:true,walletSignEntries:2,signatureShares:2,consumedMarkers:2,interruptedOwnerTerminal:false,recoveryRefused:true,secondSignRefused:true});
  },90000);
});
