import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {config} from '../tools/config.mjs';
import {createWatcherProcessTransport} from '../ergo-node/watcher-process-transport.mjs';
import {createGuardProcessCommittee} from '../ergo-node/guard-process-committee.mjs';
import {openCreditVerifier,creditOrder} from '../ergo-node/authorized-credit.mjs';
import {openProcessSource} from '../ergo-node/process-source.mjs';
import {retainCreditRecord} from '../ergo-node/credit-recovery.mjs';
import {snapshotCreditSigning} from '../guard-service/src/deposit/moneroCreditSigner.mjs';
import {rpc,confirmed} from '../ergo-node/rosen-node.mjs';

const require=createRequire(path.join(config.rosenRoot,'package.json')),wasm=require('ergo-lib-wasm-nodejs');
const {TransactionType}=await import(pathToFileURL(path.join(config.rosenRoot,'packages/abstract-chain/dist/index.js')));
const hex=value=>Buffer.from(value.sigma_serialize_bytes()).toString('hex');
const sum=values=>values.reduce((a,b)=>a+b,0);
const stage=(name,values={})=>console.log(JSON.stringify({stage:'process-'+name,...values}));
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});

/** Controlled local fault campaign. Every actor owns a process and durable store. */
export async function runProcessScenario({directory,deployment,candidate,sourceDescriptor,proofFile,certificateFile}){
  const publicDeployment=structuredClone(deployment);delete publicDeployment.guardSecrets;
  for(const watcher of publicDeployment.watchers)delete watcher.secretKey;
  const proofBytes=fs.readFileSync(proofFile),certificateBytes=fs.readFileSync(certificateFile);
  const root=path.join(directory,'processes');fs.mkdirSync(root);
  function provision(role,index){
    const home=path.join(root,role+'-'+index),inbox=path.join(home,'inbox'),runtime=path.join(home,'runtime');
    fs.mkdirSync(inbox,{recursive:true});fs.mkdirSync(runtime);
    const proof=path.join(inbox,path.basename(proofFile));fs.writeFileSync(proof,proofBytes);
    fs.writeFileSync(path.join(inbox,path.basename(certificateFile)),certificateBytes);
    const roundtripConfig=path.join(home,'roundtrip.json');write(roundtripConfig,{...config,runtimeDirectory:runtime});
    return {home,proof,roundtripConfig,source:{...structuredClone(sourceDescriptor),deliveryDirectory:inbox,certificateDirectory:inbox}};
  }
  const watcherHomes=[0,1].map(i=>provision('watcher',i)),watcherFiles=watcherHomes.map((h,index)=>{
    const file=path.join(h.home,'participant.json');write(file,{version:1,index,roundtripConfig:h.roundtripConfig,
      dependencyRoot:config.rosenRoot,watcher:deployment.watchers[index],deployment:publicDeployment,
      databasePath:path.join(h.home,'watcher.sqlite'),source:h.source,
      fault:{pauseAt:index===0?'beforeRevealConfirmation':'beforeCommitmentBroadcast'}});return file;
  });
  let watchers,guards,verifier;const sources=[],faults=[],actions=[];let actionError;
  const schedule=fn=>{const action=Promise.resolve().then(fn).catch(error=>{actionError??=error;});actions.push(action);};
  const finishActions=async()=>{await Promise.all(actions.splice(0));if(actionError)throw actionError;};
  let killedCommitment=false,killedReveal=false,killPartial=false,killedPartial=false;
  try{
    watchers=await createWatcherProcessTransport({configFiles:watcherFiles,directory:root,onEvent(type,payload){
      if(type!=='checkpoint')return;
      if(payload.index===1&&payload.checkpoint==='beforeCommitmentBroadcast')schedule(async()=>{
        if(!killedCommitment){killedCommitment=true;await watchers.kill(1);}else await watchers.resume(1,payload.checkpoint);});
      if(payload.index===0&&payload.checkpoint==='beforeRevealConfirmation')schedule(async()=>{
        if(!killedReveal){killedReveal=true;await watchers.kill(0);}else await watchers.resume(0,payload.checkpoint);});
    }});
    fs.unlinkSync(watcherHomes[1].proof);
    await assert.rejects(()=>watchers.publish(candidate),/ENOENT/);await finishActions();
    assert.equal(watchers.counts.uniqueCommitmentTransactions,0);assert.equal(killedCommitment,false);
    fs.writeFileSync(watcherHomes[1].proof,proofBytes);faults.push('watcher-missing-proof-before-commitment');
    stage('watchers-started',{watchers:2});
    await assert.rejects(()=>watchers.publish(candidate),/RPC client killed/);await finishActions();assert(killedCommitment);
    await watchers.restart(1);faults.push('watcher-killed-after-queue-before-broadcast');
    await assert.rejects(()=>watchers.publish(candidate),/RPC client killed/);await finishActions();assert(killedReveal);
    await watchers.restart(0);faults.push('watcher-killed-after-reveal-broadcast');
    const receipt=await watchers.publish(candidate);await finishActions();
    assert.equal(receipt.commitments.length,2);assert(receipt.transaction.numConfirmations>0);
    await Promise.all([watchers.restart(0),watchers.restart(1)]);
    const replay=await watchers.publish(candidate);await finishActions();assert.equal(replay.transaction.id,receipt.transaction.id);
    assert.equal(watchers.counts.uniqueCommitmentTransactions,2);assert.equal(watchers.counts.uniqueRevealTransactions,1);
    stage('watcher-recovery-passed',{commitments:2,reveals:1});

    const guardHomes=[0,1,2,3].map(i=>provision('guard',i)),guardFiles=guardHomes.map((h,index)=>{
      const file=path.join(h.home,'participant.json');write(file,{version:1,index,roundtripConfig:h.roundtripConfig,
        directory:path.join(h.home,'state'),secretKey:deployment.guardSecrets[index],deployment:publicDeployment,
        source:h.source,candidate,watcherReceipt:receipt});return file;
    });
    guards=await createGuardProcessCommittee({configFiles:guardFiles,guardKeys:deployment.guardPublicKeys,onEvent(type,payload){
      if(type==='checkpoint'&&payload.checkpoint==='beforePartial'&&killPartial&&!killedPartial){
        killedPartial=true;schedule(()=>guards.kill(payload.index));}
    }});
    assert.equal(new Set([...watchers.pids,...guards.pids,process.pid]).size,7,'Six distinct child processes required');
    const initialPids={watchers:watchers.pids,guards:guards.pids};stage('six-actors-ready');
    for(let i=0;i<4;i++)sources.push(await openProcessSource(sourceDescriptor));
    verifier=await openCreditVerifier({directory:path.join(directory,'process-verifier'),deployment:publicDeployment,
      watcherReceipt:receipt,freshAdmission:{readers:sources,candidate}});
    const payment=await verifier.chain.generateTransaction(receipt.observation.requestId,TransactionType.payment,
      creditOrder(verifier.initial.decision,publicDeployment,receipt.commitments.map(c=>c.WID)),[],[],
      [hex(wasm.ErgoBox.from_json(JSON.stringify(receipt.trigger)))],
      [hex(wasm.ErgoBox.from_json(JSON.stringify(await rpc('/utxo/byId/'+deployment.guard.boxId))))]);
    retainCreditRecord(path.join(directory,'process-candidate.json'),payment.toJson());
    const captured=snapshotCreditSigning(wasm.ReducedTransaction.sigma_parse_bytes(payment.txBytes),3,
      payment.inputBoxes.map(b=>wasm.ErgoBox.sigma_parse_bytes(b)),payment.dataInputs.map(b=>wasm.ErgoBox.sigma_parse_bytes(b)));
    const snapshot=Object.fromEntries(['digest','txId','reducedHex','inputHex','dataHex','requiredSign'].map(k=>[k,captured[k]]));
    const assignment=verifier.expectedAssignment(captured),checkpoints=rows=>rows.map(row=>row.checkpoint);
    function claimed(rows){for(const row of rows){assert.equal(row.claims,1);assert.equal(row.outputs,1);assert.equal(row.nullifiers,1);assert.equal(row.settlements,0);}}

    await assert.rejects(()=>guards.sign(snapshot,{drop:[0,1,2,3],completionTimeoutMs:3000}),/transport timeout/);
    assert.equal(sum(guards.counts.guardPartialSigns),0);await guards.restartAll();
    const retained=checkpoints(await guards.stats());claimed(retained);await guards.assertAssigned(assignment);
    faults.push('all-signing-messages-dropped');stage('dropped-transport-refused');

    killPartial=true;
    await assert.rejects(()=>guards.sign(snapshot,{pausePartials:true}),/RPC client killed/);await finishActions();assert(killedPartial);
    assert(sum(guards.counts.guardCommitments)>0);assert.equal(sum(guards.counts.guardPartialSigns),0);
    killPartial=false;await guards.restartAll();assert.deepEqual(checkpoints(await guards.stats()),retained);
    faults.push('guard-killed-before-native-partial');stage('guard-crash-recovery-passed');

    fs.unlinkSync(guardHomes[2].proof);
    await assert.rejects(()=>guards.sign(snapshot),/ENOENT/);assert.equal(sum(guards.counts.guardCommitments),0);
    fs.writeFileSync(guardHomes[2].proof,proofBytes);await guards.restartAll();
    assert.deepEqual(checkpoints(await guards.stats()),retained);faults.push('one-guard-proof-unavailable');

    await guards.kill(0);const originalConfig=fs.readFileSync(guardFiles[0]);
    try{const changed=JSON.parse(originalConfig);changed.directory=path.join(guardHomes[0].home,'fresh-state');
      fs.writeFileSync(guardFiles[0],JSON.stringify(changed));await assert.rejects(()=>guards.restart(0),/configuration bytes drift/);
      assert.equal(fs.existsSync(changed.directory),false);
    }finally{fs.writeFileSync(guardFiles[0],originalConfig);}
    await guards.restart(0);await guards.assertAssigned(assignment);assert.deepEqual(checkpoints(await guards.stats()),retained);
    faults.push('guard-config-directory-drift');stage('retained-ledger-binding-passed');

    const beforeQuorum=await guards.stats(),coordinator=beforeQuorum[0].coordinatorIndex;
    assert(beforeQuorum.every(row=>row.coordinatorIndex===coordinator));const offline=(coordinator+1)%4;
    await guards.kill(offline);const selected=[0,1,2,3].filter(i=>i!==offline);
    const quorum=await guards.sign(snapshot,{indices:selected});assert.equal(quorum.txId,snapshot.txId);
    assert.equal(guards.counts.completedGuards,3);assert.equal(sum(guards.counts.guardPartialSigns),3);
    const quorumSigned=wasm.Transaction.sigma_parse_bytes(Buffer.from(quorum.signedHex,'hex'));
    assert.equal(await rpc('/transactions/check',JSON.parse(quorumSigned.to_json())),snapshot.txId);
    const threeOfFour={offlineIndex:offline,completedGuards:3,checkedByNode:true,broadcast:false};
    stage('three-of-four-passed',threeOfFour);await guards.restartAll();
    assert.deepEqual(checkpoints(await guards.stats()),retained);

    const signed=await guards.sign(snapshot,{delayMs:20,duplicate:true});assert.equal(guards.counts.completedGuards,4);
    const native=wasm.Transaction.sigma_parse_bytes(Buffer.from(signed.signedHex,'hex'));
    assert.equal(native.id().to_str(),snapshot.txId);assert.equal(await rpc('/transactions/check',JSON.parse(native.to_json())),snapshot.txId);
    const fresh=await guards.verifyFresh(snapshot);for(const row of fresh)assert.deepEqual(row,assignment);
    const record={txId:snapshot.txId,signedHex:signed.signedHex,transaction:JSON.parse(native.to_json()),
      policyDigest:verifier.policyDigest,committee:guards.configurations(),counts:guards.counts};
    const recordFile=path.join(directory,'process-signed-credit.json');retainCreditRecord(recordFile,JSON.stringify(record));
    assert.equal(await rpc('/transactions',record.transaction),record.txId);const credit=await confirmed(record.txId);
    assert(credit.numConfirmations>0);assert.equal(credit.id,record.txId);stage('credit-confirmed');
    const finalStats=await guards.stats();claimed(checkpoints(finalStats));
    assert(finalStats.every(row=>row.proofCalls>0));
    await guards.restartAll();await Promise.all([watchers.restart(0),watchers.restart(1)]);
    const recovered=JSON.parse(fs.readFileSync(recordFile,'utf8'));
    assert.equal(hex(wasm.Transaction.sigma_parse_bytes(Buffer.from(recovered.signedHex,'hex'))),hex(wasm.Transaction.from_json(JSON.stringify(recovered.transaction))));
    assert.equal(recovered.txId,snapshot.txId);assert.equal(recovered.policyDigest,verifier.policyDigest);
    assert.deepEqual(recovered.committee,guards.configurations());await guards.assertAssigned(assignment);
    assert.deepEqual(checkpoints(await guards.stats()),retained);
    assert.equal((await confirmed(recovered.txId)).id,credit.id);
    assert.equal((await watchers.publish(candidate)).transaction.id,receipt.transaction.id);await finishActions();
    const result={stage:'multiprocess-local-qualified',watchers:2,guards:4,moneroDaemons:2,independentAdministrators:false,
      initialPids,finalPids:{watchers:watchers.pids,guards:guards.pids},watcherCounts:watchers.counts,
      faults,threeOfFour,delayedDuplicateTransport:true,guardCounts:record.counts,
      guardFreshProofCalls:finalStats.map(s=>s.proofCalls),durableClaimsRetained:true,
      confirmedCreditCount:1,creditTxId:credit.id,creditRestartStable:true};
    return result;
  }finally{await guards?.close();await watchers?.close();verifier?.close();for(const source of sources)source.close();}
}
