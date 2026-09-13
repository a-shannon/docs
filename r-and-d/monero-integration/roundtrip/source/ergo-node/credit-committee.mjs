import { mkdirSync, existsSync, readdirSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createECDH } from 'node:crypto';
import { MoneroCreditAssignment, canonicalAssignment, committeeConfigDigest, assignmentConfigDigest } from '../guard-service/src/db/moneroCreditAssignment.mjs';
import { createMoneroCreditSigner, snapshotCreditSigning } from '../guard-service/src/deposit/moneroCreditSigner.mjs';

const committeeCustody=new WeakMap();
/** Only an actual committee handle can expose its retained claim operations. */
export function captureCreditCommittee(handle){
  const custody=committeeCustody.get(handle);
  if(!custody)throw Error('backing:committee-unissued');
  custody.current();return custody;
}

/** Fixed four-member local transport. Source verification remains guard-owned;
 * persistent assignments are never released by timeout or transport cleanup. */
export async function createCreditCommittee({ directory, deployment, verifyForGuard, getStateContext,
    policyDigest, activationId, custodyDomain, policyEpoch='1', backingPolicy, timeoutMs=60000 }) {
  if (!isAbsolute(directory ?? '') || typeof verifyForGuard!=='function' || typeof getStateContext!=='function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs<100 || timeoutMs>60000 || deployment?.threshold!==3 ||
      !Array.isArray(deployment.guardPublicKeys) || deployment.guardPublicKeys.length!==4 ||
      !Array.isArray(deployment.guardSecrets) || deployment.guardSecrets.length!==4) throw Error('credit-committee:composition');
  const keys=[...deployment.guardPublicKeys];
  const configs=keys.map(guardKey=>({custodyDomain,guardKey,committeeKeys:[...keys],quorum:3,maxFaults:1,activationId,policyEpoch,policyDigest,...(backingPolicy===undefined?{}:{backingPolicy})}));
  configs.forEach(assignmentConfigDigest);
  const secrets=[...deployment.guardSecrets];
  for (let i=0;i<4;i++) {
    if (typeof secrets[i]!=='string' || !/^[0-9a-f]{64}$/.test(secrets[i])) throw Error('credit-committee:secret-shape');
    try { const key=createECDH('secp256k1');key.setPrivateKey(Buffer.from(secrets[i],'hex'));
      if (key.getPublicKey('hex','compressed')!==keys[i]) throw Error(); }
    catch { throw Error('credit-committee:key-binding'); }
  }
  const {MultiSigHandler,MultiSigUtils}=await import('@rosen-bridge/ergo-multi-sig');
  const {ECDSA}=await import('@rosen-bridge/encryption');
  const {DummyLogger}=await import('@rosen-bridge/abstract-logger');
  // The package's protocol envelope version is tied to this exact implementation.
  const bootstrap=canonicalAssignment({domain:'rosen-monero-credit-committee',version:1,protocolVersion:'3.0.1',configs});
  const manifest=join(directory,'committee-bootstrap.json');
  let fresh=false;
  if (existsSync(directory)) {
    const stat=lstatSync(directory);if(!stat.isDirectory() || stat.isSymbolicLink()) throw Error('credit-committee:directory');
    if (!existsSync(manifest)) {
      if(readdirSync(directory).length) throw Error('credit-committee:missing-bootstrap');
      fresh=true;
    }
  } else { mkdirSync(directory,{recursive:true});fresh=true; }
  const files=configs.map((_,i)=>join(directory,`guard-${i}.sqlite`));
  if (fresh) {
    const fd=openSync(manifest,'wx');
    try {writeFileSync(fd,bootstrap);fsyncSync(fd);} finally {closeSync(fd);}
  } else {
    if(lstatSync(manifest).isSymbolicLink() || readFileSync(manifest,'utf8')!==bootstrap) throw Error('credit-committee:bootstrap-drift');
    if(files.some(file=>!existsSync(file))) throw Error('credit-committee:missing-ledger');
  }
  const ledgers=[],participants=[],facades=[],peerIds=keys.map((_,i)=>`local-credit-guard-${i}`);
  const counts={messagesSubmitted:0,messagesDelivered:0,completedGuards:0,guardCommitments:[0,0,0,0],guardPartialSigns:[0,0,0,0]};
  const pending=[],requests=new Map();let closed=false,pumping=false,transportReady=false,active,drain;
  let notifyFailure;
  const fail=()=>{if(notifyFailure)notifyFailure(Error('credit-committee:transport-failed'));};
  function enqueue(sender,message,recipients) {
    if(closed)return;
    if(typeof message!=='string' || message.length>2000000 || !Array.isArray(recipients) || pending.length>=1000) {fail();return;}
    const targets=recipients.length?recipients:peerIds.filter((_,i)=>i!==sender);
    if(targets.some(id=>!peerIds.includes(id))) {fail();return;}
    counts.messagesSubmitted++;pending.push({sender,message,targets:[...targets]});kick();
  }
  function kick() {
    if(closed || !transportReady || pumping)return;
    pumping=true;
    drain=Promise.resolve().then(async()=>{
      try {
        while(!closed && pending.length) {
          const packet=pending.shift();
          for(const id of packet.targets) {
            if(closed)break;
            await facades[peerIds.indexOf(id)].handleMessage(packet.message,peerIds[packet.sender]);counts.messagesDelivered++;
          }
        }
      } catch {fail();}
      finally {pumping=false;if(!closed && pending.length)kick();}
    });
  }
  try {
    for(let i=0;i<4;i++)ledgers.push(fresh?MoneroCreditAssignment.create(files[i],configs[i]):MoneroCreditAssignment.open(files[i],configs[i]));
    for(let i=0;i<4;i++) {
      const enc=new ECDSA(secrets[i]);
      const participant=new MultiSigHandler({logger:new DummyLogger(),multiSigUtilsInstance:new MultiSigUtils(getStateContext),
        messageEnc:enc,secretHex:secrets[i],txSignTimeout:60,turnTime:600,
        submit:(message,recipients)=>enqueue(i,message,recipients),
        guardDetection:{activeGuards:async()=>peerIds.map((peerId,index)=>({peerId,index}))},commGuardsPk:[...keys],ergoGuardPks:[...keys]});
      if(participant.protocolVersion!=='3.0.1' || participant.getPk()!==keys[i] || await enc.getPk()!==keys[i]) throw Error('credit-committee:implementation-pin');
      // Instrument only operation counts; never inspect or publish native hints.
      const prover=participant.getProver.bind(participant);let counted;
      participant.getProver=()=>{
        if(!counted)counted=new Proxy(prover(),{get(target,name){const value=Reflect.get(target,name,target);
          if(name==='generate_commitments_for_reduced_transaction' || name==='sign_reduced_transaction_multi')
            return (...args)=>{counts[name==='generate_commitments_for_reduced_transaction'?'guardCommitments':'guardPartialSigns'][i]++;return value.apply(target,args);};
          return typeof value==='function'?value.bind(target):value;}});
        return counted;
      };
      const turn=participant.handleMyTurnForTx.bind(participant);
      participant.handleMyTurnForTx=async txId=>{
        if(closed || !active || txId!==active.txId)return;
        active.queued.add(i);
        if(active.queued.size===4 && !active.started) {
          active.started=true;transportReady=true;
          // .sign has populated every native participant queue before this hook.
          Promise.resolve().then(async()=>{try{for(const p of participants)await p.turn(txId);kick();}catch{fail();}});
        }
      };
      participants.push({participant,turn});
      facades.push(createMoneroCreditSigner({participant,assignment:ledgers[i],verify:snapshot=>verifyForGuard(i,snapshot)}));
    }
  } catch(error) {
    closed=true;facades.forEach(f=>f.close());ledgers.forEach(l=>l.close());throw error;
  }
  const sign=(reduced,required,boxes,dataBoxes=[])=>{
    let snapshot;try{snapshot=snapshotCreditSigning(reduced,required,boxes,dataBoxes);}catch(error){return Promise.reject(error);}
    const prior=requests.get(snapshot.txId);
    if(prior)return prior.digest===snapshot.digest?prior.promise:Promise.reject(Error('credit-committee:request-conflict'));
    if(closed)return Promise.reject(Error('credit-committee:closed'));
    if(active)return Promise.reject(Error('credit-committee:active-session'));
    active={txId:snapshot.txId,queued:new Set(),started:false};transportReady=false;
    const promise=Promise.resolve().then(async()=>{
      let timer;
      const stopped=new Promise((_,reject)=>{notifyFailure=reject;timer=setTimeout(()=>reject(Error('credit-committee:timeout-retained')),timeoutMs);});
      try {
        const jobs=facades.map(f=>f.sign(snapshot.reduced,required,snapshot.inputs,snapshot.dataInputs).then(tx=>{counts.completedGuards++;return tx;}));
        const result=await Promise.race([Promise.all(jobs),stopped]);
        const serialized=result.map(tx=>Buffer.from(tx.sigma_serialize_bytes()).toString('hex'));
        if(new Set(serialized).size!==1 || result.some(tx=>tx.id().to_str()!==snapshot.txId)) throw Error('credit-committee:signed-disagreement');
        // Package handleSignedTx verified every input proof with real state context.
        return result[0];
      } catch(error) {
        closed=true;transportReady=false;facades.forEach(f=>f.close());pending.length=0;throw error;
      } finally {clearTimeout(timer);notifyFailure=undefined;active=undefined;transportReady=false;}
    });
    requests.set(snapshot.txId,{digest:snapshot.digest,promise});return promise;
  };
  const handle=Object.freeze({sign,isInSign:async txId=>(await Promise.all(facades.map(f=>f.isInSign(txId)))).some(Boolean),
    configurations:()=>structuredClone(configs),committeeDigest:committeeConfigDigest(configs[0]),
    get counts(){return structuredClone(counts);},checkpoints:()=>ledgers.map(l=>l.checkpoint()),
    assertAssigned:request=>ledgers.map(l=>l.assertAssigned(request)),
    observeAssignment:request=>ledgers.map(l=>l.observeAssignment(request)),
    invalidate:(obligationId,reason)=>ledgers.map(l=>l.invalidate(obligationId,reason)),
    close:async()=>{closed=true;transportReady=false;facades.forEach(f=>f.close());pending.length=0;
      if(notifyFailure)notifyFailure(Error('credit-committee:closed-retained'));
      // Gates close before custody closes, so an in-flight async native hint reader
      // cannot obtain a later contribution from a closed guard.
      ledgers.forEach(l=>l.close());if(drain)await drain;
    }});
  const current=()=>{if(closed)throw Error('backing:committee-closed');};
  const retained=(method,request,settlement)=>{
    current();
    const rows=ledgers.map(ledger=>settlement===undefined?ledger[method](request):ledger[method](request,settlement));
    current();
    if(rows.length!==4 || new Set(rows.map(row=>row.requestDigest)).size!==1 ||
      (settlement!==undefined && new Set(rows.map(row=>row.settlementDigest)).size!==1))throw Error('backing:committee-disagreement');
    return rows;
  };
  committeeCustody.set(handle,Object.freeze({current,backingPolicy,
    committeeDigest:committeeConfigDigest(configs[0]),
    assertAssigned:request=>retained('assertAssigned',request),
    reserveSettlement:(request,settlement)=>retained('reserveSettlement',request,settlement),
    assertSettlement:(request,settlement)=>retained('assertSettlement',request,settlement)}));
  return handle;
}
