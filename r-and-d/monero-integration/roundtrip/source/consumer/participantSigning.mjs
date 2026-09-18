import {runCeremony,canonical} from './participantHarness.mjs';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {captureBackingClaim} from './backingClaim.mjs';
import {guardParticipantIO} from './participantAuthority.mjs';
import {fundPreparedDeposit} from './participantDepositFunding.mjs';

const hex32=()=>randomBytes(32).toString('hex');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const liveVaults=new WeakMap();

/** Export public replay bytes after holder inspection. This does not enroll the
 * epoch: consumers must independently pin the returned committee configuration. */
export function encodeParticipantDepositCertificate({init,ready,identities,genesis,config,envelopes,keyImage}) {
  const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (!hash(genesis) || !hash(keyImage) || !Array.isArray(ready) || ready.length !== 4 ||
      !Array.isArray(identities) || identities.length !== 4 || !Array.isArray(envelopes) || envelopes.length !== 2 ||
      init.threshold !== 2 || !hash(init.epoch) || !hash(init.ceremony)) throw Error('Participant certificate context');
  const authorityIdentities = identities.map(({id,publicKey},slot) => {
    if (id !== slot + 1 || typeof publicKey !== 'string' || !/^0[23][0-9a-f]{64}$/.test(publicKey)) {
      throw Error('Participant certificate identity');
    }
    return {id,publicKey};
  });
  if (canonical(init.roster) !== canonical(authorityIdentities) ||
      new Set(authorityIdentities.map(row => row.publicKey)).size !== 4) throw Error('Participant certificate roster');
  const roster = {groupKey:ready[0].groupKey,verificationShares:structuredClone(ready[0].verificationShares)};
  if (!hash(roster.groupKey) || !Array.isArray(roster.verificationShares) || roster.verificationShares.length !== 4 ||
      roster.verificationShares.some((row,slot) => row.id !== slot + 1 || !hash(row.publicKey))) {
    throw Error('Participant certificate public shares');
  }
  const domainDigest = (domain,value) => createHash('sha256').update(domain).update(Buffer.from([0])).update(canonical(value)).digest('hex');
  const rosterDigest = domainDigest('rosen-monero/local-dkg-roster/v1',roster);
  for (let slot = 0; slot < 4; slot++) {
    const row = ready[slot];
    if (row.id !== slot + 1 || row.threshold !== 2 || row.n !== 4 || row.epoch !== init.epoch ||
        row.ceremony !== init.ceremony || row.rosterDigest !== rosterDigest ||
        canonical({groupKey:row.groupKey,verificationShares:row.verificationShares}) !== canonical(roster)) {
      throw Error('Participant certificate readiness');
    }
  }
  if (config.type !== 'inspect-source' || config.genesis !== genesis || config.epoch !== init.epoch ||
      config.ceremony !== init.ceremony || config.rosterDigest !== rosterDigest ||
      (config.sourcePolicy !== undefined && config.sourcePolicy !== 'authenticated-backing-v1')) {
    throw Error('Participant certificate configuration');
  }
  const committee = {genesis,epoch:init.epoch,ceremony:init.ceremony,threshold:2,
    profile:'ed25519-shamir-untweaked-standard',roster,identities:authorityIdentities,
    sourcePolicy:config.sourcePolicy ?? null};
  const committeeDigest = domainDigest('rosen-monero/source-certificate-committee/v1',committee);
  const shared = structuredClone(config); delete shared.type;
  const binding = domainDigest('rosen-monero/local-source-config/v1',shared);
  for (let slot = 0; slot < 2; slot++) {
    const envelope = envelopes[slot];
    if (envelope.type !== 'inspection-peer' || envelope.from !== slot + 1 || envelope.to !== 2 - slot ||
        envelope.round !== 1 || envelope.sequence !== 1 || envelope.binding !== binding ||
        ['ceremony','epoch','rosterDigest','genesis','inspection'].some(name => envelope[name] !== config[name])) {
      throw Error('Participant certificate envelope');
    }
  }
  const certificate = canonical({version:1,committeeDigest,config,envelopes,keyImage}) + '\n';
  if (Buffer.byteLength(certificate) > 65536 || !/^[\x00-\x7f]*$/.test(certificate)) {
    throw Error('Participant certificate bound');
  }
  return Object.freeze({committee:structuredClone(committee),certificate});
}
function checkFinal(frame){
  if(typeof frame!=='string'||frame.length>32768||!frame.endsWith('\n'))throw Error('Participant final bound');
  const rows=frame.slice(0,-1).split('\n');
  if(rows.length!==6||rows[0]!=='W1HDF1'||rows.slice(1,5).some(v=>!/^[0-9a-f]{64}$/.test(v))||
    !/^(?:[0-9a-f]{2}){1,9408}$/.test(rows[5]))throw Error('Participant final profile');
  const bytes=Buffer.from(rows[5],'hex');if(digest(bytes)!==rows[4])throw Error('Participant final bytes');
  return Object.freeze({expectationDigest:rows[1],binding:rows[2],txId:rows[3],byteDigest:rows[4],bytesHex:rows[5]});
}

/** Opens actual actors and funds their public vault on the already-owned daemon. */
export async function openParticipantVault({binary,sha256,runtime,mode='coinbase',beforeDepositSubmit,depositData}){
  if(!['coinbase','deposit'].includes(mode))throw Error('Participant funding mode');
  if(beforeDepositSubmit!==undefined&&(mode!=='deposit'||typeof beforeDepositSubmit!=='function'))throw Error('Participant deposit preparation mode');
  if(depositData!==undefined&&(mode!=='deposit'||typeof depositData!=='function'||beforeDepositSubmit!==undefined))throw Error('Participant deposit data mode');
  const ceremony=await runCeremony({binary,sha256,keepAlive:true});
  try{
    const depositDirectory=mode==='deposit'?mkdtempSync(join(runtime,'donor-')):undefined;
    let funded;
    if(beforeDepositSubmit!==undefined){funded=await fundPreparedDeposit(ceremony.actors[0],depositDirectory,ceremony.ready[0].groupKey,beforeDepositSubmit);}
    else{const data=depositData===undefined?undefined:await depositData(ceremony.ready[0].groupKey);
      if(data!==undefined&&(typeof data!=='string'||!/^(?:[0-9a-f]{2}){1,254}$/.test(data)))throw Error('Participant deposit data');
      await ceremony.actors[0].send(mode==='deposit'?{type:'fund-deposit',runtimeDirectory:depositDirectory,...(data===undefined?{}:{depositData:data})}:{type:'fund'});
      funded=await ceremony.actors[0].next(mode==='deposit'?180000:60000,'funding');}
    if(funded.type!=='funded'||funded.id!==1||!/^[0-9a-f]{64}$/.test(funded.genesis)||funded.source?.kind!==mode)throw Error('Participant funding response');
    const handle=Object.freeze({groupKey:ceremony.ready[0].groupKey,rosterDigest:ceremony.summary.rosterDigest,
      genesis:funded.genesis,vaultAddress:funded.vaultAddress,close:ceremony.close});
    liveVaults.set(handle,{ceremony,funded,binary,sha256,runtime,depositDirectory,used:false,inspected:false});
    return handle;
  }catch(error){await ceremony.close();throw error;}
}

/** Original holders scan the ordinary deposit without creating signing machines. */
export function captureParticipantDeposit(vault){
  const state=liveVaults.get(vault);
  if(!state||state.used||state.funded.source.kind!=='deposit')throw Error('Participant deposit unavailable');
  return structuredClone(state.funded.source.deposit);
}

export async function inspectParticipantDeposit(vault,{fault,sourcePolicy,snapshot}={}){
  if(sourcePolicy!==undefined&&sourcePolicy!=='authenticated-backing-v1')throw Error('Participant source policy');
  const state=liveVaults.get(vault);
  if(!state||state.used||state.inspected||state.funded.source.kind!=='deposit')throw Error('Participant inspection unavailable');
  if(snapshot!==undefined && sourcePolicy!=='authenticated-backing-v1')throw Error('Participant snapshot profile');
  const selectedSnapshot=snapshot??state.funded.snapshot,properties=Object.getOwnPropertyDescriptors(selectedSnapshot);
  if(Object.getPrototypeOf(selectedSnapshot)!==Object.prototype || Reflect.ownKeys(selectedSnapshot).length!==2 ||
    !['height','hash'].every(key=>properties[key]?.enumerable&&Object.hasOwn(properties[key],'value')) ||
    !Number.isSafeInteger(selectedSnapshot.height)||selectedSnapshot.height<=0||!/^[0-9a-f]{64}$/.test(selectedSnapshot.hash))throw Error('Participant snapshot schema');
  const capturedSnapshot=Object.freeze({...selectedSnapshot});
  state.inspected=true;state.inspectionPolicy=sourcePolicy;
  const {ceremony,funded}=state,actors=ceremony.actors.slice(0,2),inspection=hex32();
  const shared={type:'inspect-source',ceremony:ceremony.init.ceremony,epoch:ceremony.init.epoch,
    rosterDigest:vault.rosterDigest,genesis:vault.genesis,inspection,snapshot:capturedSnapshot,source:funded.source,...(sourcePolicy?{sourcePolicy}:{})};
  if(fault==='genesis')shared.genesis=hex32();
  if(fault==='snapshot')shared.snapshot={...shared.snapshot,hash:hex32()};
  try{
    await Promise.all(actors.map(a=>a.send(shared)));
    const proofs=await Promise.all(actors.map(a=>a.next(30000,'source-proof')));
    for(let i=0;i<2;i++){
      const p=proofs[i];
      if(p.type!=='inspection-peer'||p.from!==i+1||p.to!==2-i||p.round!==1||p.sequence!==1||p.inspection!==inspection||
        p.ceremony!==shared.ceremony||p.epoch!==shared.epoch||p.genesis!==shared.genesis||p.rosterDigest!==shared.rosterDigest||
        !/^[0-9a-f]{64}$/.test(p.binding)||!/^[0-9a-f]+$/.test(p.payload)||!/^[0-9a-f]{128}$/.test(p.signature))throw Error('Participant inspection envelope');
    }
    if(proofs[0].binding!==proofs[1].binding)throw Error('Participant inspection binding');
    if(fault==='signature')proofs[0]={...proofs[0],signature:'00'.repeat(64)};
    await Promise.all([actors[0].send(proofs[1]),actors[1].send(proofs[0])]);
    const reports=await Promise.all(actors.map(a=>a.next(60000,'source-verification')));
    const deposit=funded.source.deposit;
    for(let i=0;i<2;i++){
      const r=reports[i];
      if(r.type!=='source-verified'||r.id!==i+1||r.inspection!==inspection||r.ceremony!==shared.ceremony||r.epoch!==shared.epoch||
        r.genesis!==shared.genesis||r.rosterDigest!==shared.rosterDigest||canonical(r.snapshot)!==canonical(capturedSnapshot)||
        r.txId!==deposit.txId||r.blockHash!==deposit.blockHash||r.blockHeight!==deposit.blockHeight||r.outputKey!==deposit.outputKey||
        r.outputIndex!==deposit.outputIndex||r.chainIndex!==deposit.chainIndex||r.amountAtomic!==deposit.amountAtomic||
        !/^[0-9a-f]{64}$/.test(r.keyImage)||r.spentStatus!==0||r.sourcePolicy!==sourcePolicy||
        (sourcePolicy?(!Number.isSafeInteger(r.historyOccurrences)||r.historyOccurrences<1||r.historyOccurrences>0xffffffff):r.historyOccurrences!==1)||r.walletSigns!==0)throw Error('Participant source observation');
    }
    const withoutId=({id,...report})=>report;
    if(canonical(withoutId(reports[0]))!==canonical(withoutId(reports[1])))throw Error('Participant source disagreement');
    const replay = encodeParticipantDepositCertificate({init:ceremony.init,ready:ceremony.ready,identities:ceremony.identities,
      genesis:vault.genesis,config:shared,envelopes:proofs,keyImage:reports[0].keyImage});
    // Only public source data leaves the issuer. The private scalar remains a file capability for the proof helper.
    return Object.freeze({deposit:Object.freeze({...deposit}),observation:Object.freeze({...reports[0]}),...replay,
      publicScan:Object.freeze({groupPublicKey:vault.groupKey,genesis:vault.genesis,snapshot:structuredClone(capturedSnapshot),source:structuredClone(funded.source),keyImage:reports[0].keyImage,...(sourcePolicy?{sourcePolicy}:{})}),
      donorProofKeyPath:join(state.depositDirectory,'donor-tx-key.private')});
  }catch(error){await ceremony.close();throw error;}
}

/** The object registry admits only a vault created by this issuer's pinned processes. */
export async function prepareParticipantSigning(vault,{request,rosenKeys,timestamp,fault,backingClaim}){
  const state=liveVaults.get(vault);if(!state||state.used)throw Error('Participant vault unavailable');
  if(state.inspectionPolicy==='authenticated-backing-v1'){
    const {request:claimRequest}=captureBackingClaim(backingClaim),backing=claimRequest.backing,deposit=state.funded.source.deposit;
    if(backing.genesis!==vault.genesis||backing.vaultSpend!==vault.groupKey||backing.txid!==deposit.txId||
      backing.outputIndex!==String(deposit.outputIndex)||backing.globalIndex!==String(deposit.chainIndex)||
      backing.publicKey!==deposit.outputKey||backing.amountAtomic!==deposit.amountAtomic)throw Error('Participant backing claim mismatch');
  }
  state.used=true;
  const {ceremony,funded,runtime}=state;
  let approvalCurrent=()=>{};
  const current=()=>{if(backingClaim!==undefined)captureBackingClaim(backingClaim);approvalCurrent();};
  const actors=guardParticipantIO(ceremony.actors.slice(0,2),current);
  const attempt=hex32(),seed=hex32(),directory=mkdtempSync(join(runtime,'participant-attempt-'));
  const directories=[1,2].map(id=>{const path=join(directory,String(id));mkdirSync(path);return path;});
  const shared={type:'configure',ceremony:ceremony.init.ceremony,epoch:ceremony.init.epoch,rosterDigest:vault.rosterDigest,
    genesis:vault.genesis,selected:[1,2],attempt,seed,request,source:funded.source,rosenKeys,required:3,timestamp};
  const counts={proofs:0,preprocesses:0,descriptors:0,shares:0};
  const exchange=async round=>{
    const outgoing=await Promise.all(actors.map(a=>a.next(30000,`round-${round}`)));
    for(let i=0;i<2;i++){
      const v=outgoing[i];
      if(v.type!=='sign-peer'||v.from!==i+1||v.to!==2-i||v.round!==round||v.sequence!==round||v.attempt!==attempt||
        v.ceremony!==shared.ceremony||v.epoch!==shared.epoch||v.genesis!==shared.genesis||v.rosterDigest!==shared.rosterDigest||
        canonical(v.selected)!=='[1,2]'||!/^[0-9a-f]+$/.test(v.payload)||!/^[0-9a-f]{128}$/.test(v.signature))throw Error('Participant signing outbound context');
    }
    if(round===5)counts.proofs+=2;if(round===6)counts.preprocesses+=2;if(round===7)counts.descriptors+=2;if(round===8)counts.shares+=2;
    if(fault==='crossed-attempt'&&round===5)outgoing[0]={...outgoing[0],attempt:hex32()};
    if(fault==='wrong-sender'&&round===5)outgoing[0]={...outgoing[0],from:2};
    await actors[1].send(outgoing[0]);
    if(fault==='replay'&&round===5)await actors[1].send(outgoing[0]);
    if(fault==='interrupt-after-share'&&round===8){actors[0].child.kill();throw Error('Participant interrupted after contribution');}
    await actors[0].send(outgoing[1]);
  };
  try{
    await Promise.all(actors.map((a,i)=>a.send({...shared,runtimeDirectory:directories[i]})));
    for(const round of [5,6,7])await exchange(round);
    const candidates=await Promise.all(actors.map(a=>a.next(30000,'candidate')));
    for(let i=0;i<2;i++){const c=candidates[i];if(c.type!=='candidate'||c.id!==i+1||c.request!==request||
      !/^[0-9a-f]{64}$/.test(c.expectationDigest)||!/^[0-9a-f]{64}$/.test(c.binding))throw Error('Participant candidate context');}
    const withoutId=({id,...data})=>data;
    if(canonical(withoutId(candidates[0]))!==canonical(withoutId(candidates[1])))throw Error('Participant candidate disagreement');
    const candidate=candidates[0];let consumed=false;
    return Object.freeze({candidate:Object.freeze({...candidate}),directories:Object.freeze([...directories]),
      counts:()=>Object.freeze({...counts}),
      sign:async(certificate,assertApprovalCurrent=()=>{})=>{
        if(consumed)throw Error('Participant attempt already consumed');consumed=true;
        if(typeof assertApprovalCurrent!=='function')throw Error('Participant approval authority required');
        approvalCurrent=assertApprovalCurrent;
        try{
          for(const actor of actors)await actor.send({type:'approve',expectationDigest:candidate.expectationDigest,certificate});
          await exchange(8);
          const outputs=await Promise.all(actors.map(a=>a.next()));
          for(let i=0;i<2;i++)if(outputs[i].type!=='final'||outputs[i].id!==i+1||outputs[i].walletSigns!==1)throw Error('Participant final owner');
          if(outputs[0].result!==outputs[1].result)throw Error('Participant final disagreement');
          const final=checkFinal(outputs[0].result);
          if(final.expectationDigest!==candidate.expectationDigest||final.binding!==candidate.binding)throw Error('Participant final anchor');
          return final;
        }catch(error){await ceremony.close();throw error;}
      },close:ceremony.close});
  }catch(error){await ceremony.close();throw error;}
}

export async function recoverParticipantFinal({binary,sha256,directory,expectationDigest}){
  if(digest(readFileSync(binary))!==sha256||!/^[0-9a-f]{64}$/.test(expectationDigest))throw Error('Participant recovery pin');
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,['recover',directory,expectationDigest],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let data=Buffer.alloc(0),stderr=0,failed=false;
    const timer=setTimeout(()=>{failed=true;child.kill();},15000);
    child.once('error',()=>{failed=true;});
    child.stdout.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length>65537){failed=true;child.kill();}});
    child.stderr.on('data',chunk=>{stderr+=chunk.length;if(stderr>4096){failed=true;child.kill();}});
    child.once('close',code=>{clearTimeout(timer);try{
      if(failed||code!==0||data.at(-1)!==10)throw Error('Participant recovery refused');
      const text=data.subarray(0,-1).toString('ascii'),value=JSON.parse(text);
      if(canonical(value)!==text||value.type!=='recovered'||value.walletSigns!==0)throw Error('Participant recovery profile');
      const final=checkFinal(value.result);if(final.expectationDigest!==expectationDigest)throw Error('Participant recovery anchor');resolve(final);
    }catch{reject(Error('Participant recovery refused'));}});
  });
}
