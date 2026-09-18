// Opt-in isolated runtime qualification. Both daemons are owned by this test;
// this does not establish independently administered production endpoints.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {config} from '../tools/config.mjs';
import {LocalMonero} from './localMonero.ts';
import {openParticipantVault,inspectParticipantDeposit} from './participantSigning.mjs';
import {nativeProof} from './depositSource.ts';
import {encodeDepositMemo,encodeDepositEnvelope} from './depositDelivery.mjs';
import {encodeIntent} from '../packages/monero-deposit/lib/intentCodec.ts';
import {createFreshDepositAdmission} from './freshDepositAdmission.mjs';
import {createNativeDepositDecoder} from './nativeDepositDiscovery.mjs';
import {setupAuthorityFixture,stateContext} from '../ergo-node/authority-fixture.mjs';
import {createWatcherTransport} from '../ergo-node/watcher-runtime.mjs';
import {rpc,confirmed} from '../ergo-node/rosen-node.mjs';
import {openAuthorizedCredit,creditOrder} from '../ergo-node/authorized-credit.mjs';
import {createCreditCommittee} from '../ergo-node/credit-committee.mjs';
import {snapshotCreditSigning} from '../guard-service/src/deposit/moneroCreditSigner.mjs';
import {captureSuffix,rewind,restoreSuffix,OFFICIAL_MONERO_RPC_EXAMPLE_ADDRESS} from './moneroForkFixture.mjs';

assert.equal(process.env.MONERO_ADAPTER_LOCAL_TEST,'1','Explicit isolated adapter test required');
if(config.sourceResilience===true)assert.equal(config.processSimulation,true,'Source resilience requires process simulation');
if(config.v2Return===true){assert.equal(config.processSimulation,true);assert.notEqual(config.sourceResilience,true,'Quarantine campaign is separate from a successful return');}
const moduleAt=relative=>import(pathToFileURL(join(config.scannerAdapterRoot,relative)).href);
const {MoneroNetworkConnector}=await moduleAt('lib/moneroNetworkConnector.ts');
const {NativeDepositObserver}=await moduleAt('lib/nativeDepositObserver.ts');
const {MoneroObservationExtractor}=await moduleAt('lib/moneroObservationExtractor.ts');
const {TestScanner,openDatabase}=await moduleAt('tests/fixtures.ts');
const scannerRequire=createRequire(join(config.scannerAdapterRoot,'package.json'));
const {ObservationEntity}=scannerRequire('@rosen-bridge/abstract-observation-extractor');
const {DefaultLogger,DummyLogger}=scannerRequire('@rosen-bridge/abstract-logger');
DefaultLogger.init(new DummyLogger());
const require=createRequire(import.meta.url),wasm=require('ergo-lib-wasm-nodejs');
const {TransactionType}=await import(pathToFileURL(join(config.rosenRoot,'packages/abstract-chain/dist/index.js')).href);

async function replicate(source,target){
  const sourceInfo=await source.isolated(),targetInfo=await target.isolated();
  assert(targetInfo.height<=sourceInfo.height);
  for(let height=targetInfo.height;height<sourceInfo.height;height++){
    const block=await source.rpc('get_block',{height});
    for(const txId of block.tx_hashes??[]){
      const tx=await source.transaction(txId);assert.equal(tx.txs.length,1);
      const result=await target.submit(Buffer.from(tx.txs[0].as_hex,'hex'));assert.equal(result.status,'OK');
    }
    const submitted=await target.rpc('submit_block',[block.blob]);assert.equal(submitted.status,'OK');
  }
  assert.equal((await target.isolated()).height,sourceInfo.height);
  assert.equal((await target.rpc('get_block',{height:sourceInfo.height-1})).block_header.hash,
    (await source.rpc('get_block',{height:sourceInfo.height-1})).block_header.hash);
}

async function moneroBlock(node,height){
  const block=await node.rpc('get_block',{height});
  assert.equal(block.status,'OK');assert.equal(block.block_header.height,height);assert.equal(block.block_header.orphan_status,false);
  assert.match(block.block_header.hash,/^[0-9a-f]{64}$/);const transactions=block.tx_hashes??[];assert(Array.isArray(transactions));
  return {height,hash:block.block_header.hash,transactions:[...transactions]};
}

async function createSourceFaults(primary,replica,deposit){
  let archive=await captureSuffix(primary,deposit.blockHeight),phase='original',cycle=0;
  const events=[];
  const nodeState=async node=>{const info=await node.isolated(),tipHeight=info.height-1;
    assert.equal(info.nettype,'fakechain');assert.equal(info.offline,true);
    return {tipHeight,tipHash:(await moneroBlock(node,tipHeight)).hash,deposit:await moneroBlock(node,deposit.blockHeight)};};
  const isOriginal=state=>state.tipHeight===archive.tipHeight&&state.tipHash===archive.tipHash&&
    state.deposit.hash===deposit.blockHash&&state.deposit.transactions.includes(deposit.txId);
  const originalPair=async()=>{const [left,right]=await Promise.all([nodeState(primary),nodeState(replica)]);
    assert(isOriginal(left),'Primary must hold the exact archived suffix');assert(isOriginal(right),'Replica must hold the exact archived suffix');
    return {left,right};};
  await originalPair();
  const replaceReplica=async()=>{await rewind(replica,archive.baseHeight);
    for(let remaining=archive.blocks.length;remaining>0;remaining-=Math.min(2,remaining))
      await replica.mine(Math.min(2,remaining),OFFICIAL_MONERO_RPC_EXAMPLE_ADDRESS);
    const state=await nodeState(replica);assert.equal(state.tipHeight,archive.tipHeight,'Replacement height changed');
    assert.notEqual(state.deposit.hash,deposit.blockHash,'Replacement accidentally retained the deposit block');
    assert.notEqual(state.tipHash,archive.tipHash,'Replacement accidentally retained the original suffix');
    assert.equal(state.deposit.transactions.includes(deposit.txId),false,'Replacement retained the deposit transaction');return state;};
  const record=(fault,state)=>{const item=Object.freeze({cycle,fault,...state});events.push(item);return item;};
  const sourceFaults={
    async diverge(){
      assert.equal(phase,'original','Divergence requires the restored source');
      const before=await originalPair(),right=await replaceReplica(),left=await nodeState(primary);
      assert(isOriginal(left),'Divergence changed the primary branch');assert.equal(left.tipHeight,right.tipHeight);
      assert.notEqual(left.deposit.hash,right.deposit.hash,'Daemons did not diverge at the deposit height');
      phase='diverged';return record('one-daemon-divergence',{originalTip:left.tipHash,replacementTip:right.tipHash,
        originalDeposit:left.deposit.hash,replacementDeposit:right.deposit.hash});
    },
    async remove(){
      const left=await nodeState(primary);let right=await nodeState(replica);
      assert(isOriginal(left),'Removal requires the primary original suffix');
      if(isOriginal(right))right=await replaceReplica();
      else{
        assert.equal(right.tipHeight,archive.tipHeight,'Diverged replica height changed');
        assert.notEqual(right.deposit.hash,deposit.blockHash,'Diverged replica retained the deposit block');
        assert.equal(right.deposit.transactions.includes(deposit.txId),false,'Diverged replica retained the deposit transaction');
      }
      await rewind(primary,archive.baseHeight);await replicate(replica,primary);
      const [removedPrimary,removedReplica]=await Promise.all([nodeState(primary),nodeState(replica)]);
      assert.deepEqual(removedPrimary,removedReplica,'Replacement branches disagree');
      assert.equal(removedPrimary.tipHeight,archive.tipHeight);assert.notEqual(removedPrimary.tipHash,archive.tipHash);
      assert.notEqual(removedPrimary.deposit.hash,deposit.blockHash,'Both-daemon replacement retained the deposit block');
      assert.equal(removedPrimary.deposit.transactions.includes(deposit.txId),false,'Both-daemon replacement retained the deposit transaction');
      phase='removed';return record('both-daemon-deposit-removal',{replacementTip:removedPrimary.tipHash,
        replacementDeposit:removedPrimary.deposit.hash});
    },
    async restore(){
      assert.notEqual(phase,'original','Restore requires a source fault');
      await restoreSuffix(primary,archive);await restoreSuffix(replica,archive);
      const restored=await originalPair();phase='original';cycle++;
      return record('exact-original-restoration',{tip:restored.left.tipHash,deposit:restored.left.deposit.hash});
    },
    result(){return structuredClone({phase,cycle,depositHeight:deposit.blockHeight,depositBlockId:deposit.blockHash,
      archive:{baseHeight:archive.baseHeight,tipHeight:archive.tipHeight,tipHash:archive.tipHash,blocks:archive.blocks.length},events});},
  };
  return sourceFaults;
}

test('actual source reaches watcher commitments and four fresh guards on the isolated Ergo node', {timeout:900000},async()=>{
  assert(!existsSync(join(config.runtimeDirectory,'ergo-authority','deployment.json')),'Fresh adapter runtimeDirectory required');
  const directory=mkdtempSync(join(config.runtimeDirectory,'adapter-')),inbox=join(directory,'delivery');mkdirSync(inbox);
  let primary,replica,vault,network,extractor,scannerDb,admissionDb,transport,credit,sourceFaults;
  try{
    const deployment=await setupAuthorityFixture();
    primary=await LocalMonero.start(config.runtimeDirectory);replica=await LocalMonero.start(config.runtimeDirectory);
    process.env.MONERO_LOCAL_RPC_PORT=String(primary.port);
    const genesis=(await primary.rpc('get_block',{height:0})).block_header.hash,asset=deployment.tokens.Asset;
    console.log(JSON.stringify({stage:'adapter-owned-nodes',daemonCount:2}));
    vault=await openParticipantVault({binary:config.nativeBinary,sha256:config.nativeSha256,runtime:config.runtimeDirectory,mode:'deposit',
      depositData:vaultSpend=>encodeDepositMemo({genesis,vaultSpend,sourceNetwork:'mainnet',destinationNetwork:'ergo-testnet',vaultEpoch:'1',
        destinationAsset:asset,amount:'500000240',bridgeFee:'100',networkFee:'20',expiryHeight:'4000',recipient:config.ergoRecipient}).toString('hex')});
    const inspected=await inspectParticipantDeposit(vault,{sourcePolicy:'authenticated-backing-v1'}),d=inspected.deposit;
    await replicate(primary,replica);
    console.log(JSON.stringify({stage:'adapter-real-certificate',sourceHeight:d.blockHeight,certificateBytes:Buffer.byteLength(inspected.certificate)}));
    const endpoints=[primary,replica].map(node=>'http://127.0.0.1:'+node.port);
    network=new MoneroNetworkConnector({endpoints,genesis});
    const packet=await network.getBlockPacket(d.blockHash,d.blockHeight);
    assert.equal(packet.transactions.find(tx=>tx.txId===d.txId).outputIndices[d.outputIndex],d.chainIndex);
    const nativeOptions={nativeBinary:config.nativeBinary,nativeBinarySha256:config.nativeSha256,
      committee:inspected.committee,viewKey:'01'+'00'.repeat(31),timeoutMs:30000,maxInputBytes:16*1024*1024+128*1024,maxOutputBytes:65536};
    const observer=new NativeDepositObserver(nativeOptions);
    const native=await observer.observe(packet,inspected.certificate,d.txId,d.outputIndex,new AbortController().signal);
    assert.equal(native.keyImage,inspected.observation.keyImage);assert.equal(native.amountAtomic,d.amountAtomic);
    const intentBytes=encodeIntent({version:2,domain:'rosen-monero-deposit',source_network:'mainnet',vault_epoch:'1',vault_address:vault.vaultAddress,
      destination_network:'ergo-testnet',destination_asset:asset,bridge_fee:'100',network_fee:'20',txid:d.txId,to_address:config.ergoRecipient,
      amount:d.amountAtomic,expiry_height:4000n,outputs:[{output_index:BigInt(d.outputIndex),output_public_key:d.outputKey,amount:d.amountAtomic}]});
    const proofRequest={txHex:d.txBytes,txId:d.txId,vaultAddress:vault.vaultAddress,messageHex:Buffer.from(intentBytes).toString('hex'),proof:''};
    const proof=await nativeProof('produce',proofRequest,config.runtimeDirectory,inspected.donorProofKeyPath);
    assert.equal(proof.good,true);assert.equal(proof.received,d.amountAtomic);
    const configuration={genesis,committeeDigest:native.committeeDigest,vaultSpend:vault.groupKey,vaultAddress:vault.vaultAddress,vaultEpoch:'1',
      destinationAsset:asset,bridgeFee:'100',networkFee:'20',minConfirmations:10,maxObservationAge:1000};
    const sourceOptions={network,observer,configuration,deliveryDirectory:inbox,certificateDirectory:inbox,
      verifyProof:request=>nativeProof('verify',request,config.runtimeDirectory),
      validateRecipient:address=>{assert.equal(wasm.Address.from_base58(address).to_base58(wasm.NetworkPrefix.Testnet),address);}};
    const adapter=createFreshDepositAdmission(sourceOptions);
    const decoder=createNativeDepositDecoder({binary:config.nativeBinary,sha256:config.nativeSha256,
      policy:{genesis,vaultSpend:vault.groupKey,vaultEpoch:'1',destinationAsset:asset}});
    const database=join(directory,'observations.sqlite');scannerDb=await openDatabase(database,true);admissionDb=await openDatabase(database);
    const options={extractorId:'monero-deposits',scannerId:'monero',scope:adapter.scope,maxCandidates:100,maxTransactionBytes:1000000,
      leaseMs:120000,retryMs:1};
    const makeExtractor=()=>new MoneroObservationExtractor(scannerDb,admissionDb,options,decoder,adapter.verify,
      {verificationTimeoutMs:90000,maxConcurrentVerifications:1});
    const makeScanner=async()=>{const value=new TestScanner('monero',scannerDb,d.blockHeight-1,network);
      await value.registerExtractor(extractor);return value;};
    extractor=makeExtractor();let scanner=await makeScanner();await scanner.update();
    const pending=await extractor.processPending(1);assert.equal(pending.pending,1);assert.equal(pending.accepted,0);
    assert.equal(await scannerDb.getRepository(ObservationEntity).count(),0);
    const initialCapture=await admissionDb.query('SELECT id,scope,txId,transactionHex,sourceBlockId,sourceHeight FROM monero_candidate_entity WHERE txId=?',[d.txId]);
    assert.equal(initialCapture.length,1);const candidate={...initialCapture[0],id:Number(initialCapture[0].id),sourceHeight:Number(initialCapture[0].sourceHeight)};
    assert.deepEqual(candidate,{id:1,scope:adapter.scope,txId:d.txId,transactionHex:d.txBytes,sourceBlockId:d.blockHash,sourceHeight:d.blockHeight});
    const proofFile=join(inbox,d.txId+'.proof'),certificateFile=join(inbox,d.txId+'.'+d.outputIndex+'.certificate'),
      validProofBytes=encodeDepositEnvelope({intentBytes,proof:proof.proof}),sourceResilience=config.sourceResilience===true&&config.processSimulation===true;
    writeFileSync(certificateFile,inspected.certificate,{flag:'wx'});
    await primary.mine(2,vault.vaultAddress);await replicate(primary,replica);await scanner.update();
    if(sourceResilience){
      await assert.rejects(()=>adapter.inspect(candidate,new AbortController().signal),error=>error?.code==='ENOENT');
      const outageStarted=Date.now(),attempts=[];
      for(let attempt=0;attempt<5;attempt++){
        if(attempt>0)await delay(2500);
        if(attempt===2){extractor.close();await admissionDb.destroy();await scannerDb.destroy();
          scannerDb=await openDatabase(database);admissionDb=await openDatabase(database);extractor=makeExtractor();scanner=await makeScanner();}
        const retried=await extractor.processPending(1);assert.deepEqual(retried,{claimed:1,accepted:0,pending:1,expired:0,stale:0,failed:0});
        assert.equal(await scannerDb.getRepository(ObservationEntity).count(),0);attempts.push({attempt:attempt+1,...retried});
      }
      const outageElapsedMs=Date.now()-outageStarted;assert(outageElapsedMs>=10000,'Proof outage duration was not exercised');
      sourceFaults=await createSourceFaults(primary,replica,d);
      const scannerState=async()=>({blocks:await scannerDb.query('SELECT height,hash,parentHash,status FROM block_entity WHERE scanner=? ORDER BY height',['monero']),
        candidates:await admissionDb.query('SELECT id,txId,sourceBlockId,sourceHeight,state,revision,observationRequestId FROM monero_candidate_entity WHERE txId=? ORDER BY id',[d.txId]),
        observations:await scannerDb.getRepository(ObservationEntity).count()});
      const beforeDivergence=await scannerState();await sourceFaults.diverge();
      await assert.rejects(()=>network.getCurrentHeight(),/Monero endpoints disagree/);await scanner.update();
      assert.deepEqual(await scannerState(),beforeDivergence,'Scanner advanced while daemons disagreed');await sourceFaults.restore();
      await sourceFaults.remove();await scanner.update();
      let state=await scannerState();assert.equal(state.observations,0);assert.equal(state.candidates.length,1);assert.equal(state.candidates[0].state,'orphaned');
      assert.equal(state.blocks.some(block=>block.hash===d.blockHash),false,'Removed source block remained in scanner storage');
      await scanner.update();state=await scannerState();assert.equal(state.candidates.length,1);assert.equal(state.candidates[0].state,'orphaned');
      await sourceFaults.restore();await scanner.update();await scanner.update();state=await scannerState();
      assert.equal(state.observations,0);assert.equal(state.candidates.length,1);assert.equal(state.candidates[0].state,'pending');
      assert.equal(state.candidates[0].sourceBlockId,d.blockHash);assert(state.blocks.some(block=>block.hash===d.blockHash));
      writeFileSync(proofFile,validProofBytes,{flag:'wx'});
      const admitted=await extractor.processPending(1);assert.equal(admitted.accepted,1,JSON.stringify(admitted));
      assert.equal((await scannerDb.getRepository(ObservationEntity).count()),1);
      const acceptedRequest=(await scannerState()).candidates[0].observationRequestId;
      assert.match(acceptedRequest,/^[0-9a-f]{64}$/);
      await sourceFaults.remove();await scanner.update();state=await scannerState();
      assert.equal(state.observations,0,'Fork rollback retained the accepted observation');assert.equal(state.candidates.length,1);
      assert.equal(state.candidates[0].state,'orphaned');assert.equal(state.candidates[0].observationRequestId,acceptedRequest);
      assert.deepEqual(await extractor.processPending(1),{claimed:0,accepted:0,pending:0,expired:0,stale:0,failed:0});
      await scanner.update();await sourceFaults.restore();await scanner.update();await scanner.update();
      const recaptured=await scannerState();assert.equal(recaptured.observations,0);assert.equal(recaptured.candidates.length,1);
      assert.equal(recaptured.candidates[0].state,'pending');assert.equal(recaptured.candidates[0].sourceBlockId,d.blockHash);
      assert.equal(recaptured.candidates[0].observationRequestId,null);
      const readmitted=await extractor.processPending(1);assert.equal(readmitted.accepted,1,JSON.stringify(readmitted));
      assert.equal(await scannerDb.getRepository(ObservationEntity).count(),1);
      sourceFaults.result=(()=>{const sourceResult=sourceFaults.result,admission=Object.freeze({proofOutageMs:outageElapsedMs,
        proofOutageAttempts:attempts.length,databaseReopens:1,divergencePaused:true,pendingRollbackRecaptured:true,
        acceptedRollbackDeleted:true,acceptedRecapturedOnce:true});return ()=>({...sourceResult(),admission});})();
    }else{
      writeFileSync(proofFile,validProofBytes,{flag:'wx'});
      const admitted=await extractor.processPending(1);assert.equal(admitted.accepted,1,JSON.stringify(admitted));
    }
    const rows=await scannerDb.getRepository(ObservationEntity).find();assert.equal(rows.length,1);assert.equal(rows[0].height,d.blockHeight);
    assert.equal(rows[0].sourceBlockId,d.blockHash);assert.match(rows[0].fromAddress,/^rosen-monero-output:v2:/);
    const captured=await admissionDb.query('SELECT id,scope,txId,transactionHex,sourceBlockId,sourceHeight FROM monero_candidate_entity WHERE txId=?',[d.txId]);
    assert.equal(captured.length,1);assert.deepEqual({...captured[0],id:Number(captured[0].id),sourceHeight:Number(captured[0].sourceHeight)},candidate);

    if(config.processSimulation===true){
      const {runProcessScenario}=await import('./processAdapterScenario.mjs');
      const processResult=await runProcessScenario({directory,deployment,candidate,sourceFaults,
        sourceDescriptor:{endpoints,genesis,nativeOptions,configuration,deliveryDirectory:inbox,certificateDirectory:inbox},
        proofFile,certificateFile,...(config.v2Return===true?{returnRuntime:{node:primary,vault,source:inspected}}:{})});
      writeFileSync(join(directory,'process-result.json'),JSON.stringify(processResult,null,2),{flag:'wx'});
      console.log(JSON.stringify(processResult));return;
    }

    // Every watcher and guard gets a separately configured admission reader and
    // native observer. The shared daemon connector is only the configured source.
    const makeReaders=(count,calls)=>Array.from({length:count},(_,index)=>createFreshDepositAdmission({...sourceOptions,
      observer:new NativeDepositObserver(nativeOptions),verifyProof:async request=>{calls[index]++;return nativeProof('verify',request,config.runtimeDirectory);}}));
    const watcherProofCalls=[0,0],watcherReaders=makeReaders(2,watcherProofCalls);
    const watcherObservation=result=>{assert.equal(result.status,'accepted');const observation=structuredClone(result.observation);
      assert.equal(observation.rawData,'');delete observation.rawData;observation.height=result.backing.blockHeight;return observation;};
    const observe=async(index,rawCandidate)=>{assert.deepEqual(rawCandidate,candidate);
      return watcherObservation(await watcherReaders[index].inspect(rawCandidate,new AbortController().signal));};
    const watcherDirectory=join(directory,'watchers');
    transport=await createWatcherTransport({directory:watcherDirectory,deployment,nodePort:{rpc,confirmed,getStateContext:stateContext},
      observe,dependencyRoot:config.rosenRoot});
    const receipt=await transport.publish(candidate);assert.equal(receipt.commitments.length,2);
    assert.equal(new Set(receipt.commitments.map(value=>value.WID)).size,2);assert(receipt.transaction.numConfirmations>0);
    for(const field of ['sourceTxId','sourceBlockId','fromAddress','toAddress','amount','bridgeFee','networkFee','targetChainTokenId'])
      assert.equal(receipt.observation[field],rows[0][field]);
    transport.close();transport=await createWatcherTransport({directory:watcherDirectory,deployment,nodePort:{rpc,confirmed,getStateContext:stateContext},
      observe,dependencyRoot:config.rosenRoot});
    const replay=await transport.publish(candidate);assert.equal(replay.transaction.id,receipt.transaction.id);
    assert.deepEqual(watcherProofCalls,[2,2]);

    // Use the real verifier and exact pinned multisig package without submitting
    // either negative candidate. Removing the source proof from the private
    // inbox at a contribution hook must stop the native operation while the
    // already assigned economic identities remain durable in every ledger.
    const negativeContributionCounts=[];
    const boxHex=value=>Buffer.from(value.sigma_serialize_bytes()).toString('hex');
    const nativeBox=value=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(value,'hex'));
    const sum=values=>values.reduce((total,value)=>total+value,0);
    async function refuseContribution(label,hookOrdinal,expectedCommitments){
      const proofCalls=[0,0,0,0],readers=makeReaders(4,proofCalls),negativeDirectory=join(directory,'negative-'+label);
      let authority,committee,reopened,sourceFailure;
      try{
        authority=await openAuthorizedCredit({directory:join(negativeDirectory,'authority'),freshAdmission:{readers,candidate},watcherReceipt:receipt,deployment});
        const source=await authority.readers[0].inspect(candidate,new AbortController().signal);assert.equal(source.status,'accepted');
        const payment=await authority.chain.generateTransaction(receipt.observation.requestId,TransactionType.payment,
          creditOrder(source.decision,deployment,receipt.commitments.map(value=>value.WID)),[],[],
          [boxHex(wasm.ErgoBox.from_json(JSON.stringify(receipt.trigger)))],
          [boxHex(wasm.ErgoBox.from_json(JSON.stringify(await rpc('/utxo/byId/'+deployment.guard.boxId))))]);
        const reduced=wasm.ReducedTransaction.sigma_parse_bytes(payment.txBytes),
          inputs=payment.inputBoxes.map(value=>nativeBox(Buffer.from(value).toString('hex'))),
          dataInputs=payment.dataInputs.map(value=>nativeBox(Buffer.from(value).toString('hex'))),
          snapshot=snapshotCreditSigning(reduced,3,inputs,dataInputs);
        const probe=await authority.verifyForGuard(0,snapshot);assert.equal(probe.assignment.binding.creditTransactionDigest,snapshot.digest);
        let hooks=0;
        const verifyForGuard=async(index,current)=>{const verified=await authority.verifyForGuard(index,current),refresh=verified.revalidate;
          return {...verified,async revalidate(){hooks++;
            if(hooks===hookOrdinal){const counts=committee.counts;
              assert.equal(sum(counts.guardCommitments),expectedCommitments,'Unexpected commitment phase');
              assert.equal(sum(counts.guardPartialSigns),0,'Partial signature preceded proof removal');unlinkSync(proofFile);}
            try{return await refresh();}catch(error){sourceFailure=error;throw error;}}};};
        const committeeOptions={directory:join(negativeDirectory,'guards'),deployment,verifyForGuard,getStateContext:stateContext,
          policyDigest:probe.assignment.binding.policyDigest,activationId:'ergo-guard:'+deployment.guard.boxId,
          custodyDomain:'local-monero-genesis:'+genesis,backingPolicy:'single-deposit-v2',contributionPackage:config.contributionPackage};
        committee=await createCreditCommittee(committeeOptions);
        await assert.rejects(()=>committee.sign(reduced,3,inputs,dataInputs));
        assert(sourceFailure&&sourceFailure.code==='ENOENT','Missing proof must be the deciding source failure');
        const counts=committee.counts;assert.equal(sum(counts.guardCommitments),expectedCommitments);
        assert.equal(sum(counts.guardPartialSigns),0);assert.equal(hooks,hookOrdinal);
        const retained=committee.checkpoints();for(const checkpoint of retained){assert.equal(checkpoint.claims,1);
          assert.equal(checkpoint.outputs,1);assert.equal(checkpoint.nullifiers,1);assert.equal(checkpoint.settlements,0);}
        await committee.close();committee=undefined;
        reopened=await createCreditCommittee({...committeeOptions,verifyForGuard:async()=>{throw Error('Unexpected recovery verification');}});
        assert.deepEqual(reopened.checkpoints(),retained);assert.equal((await rpc('/utxo/byId/'+receipt.trigger.boxId)).boxId,receipt.trigger.boxId);
        negativeContributionCounts.push({label,commitments:sum(counts.guardCommitments),partialSigns:sum(counts.guardPartialSigns),proofCalls});
      }finally{
        await reopened?.close();await committee?.close();await authority?.close();writeFileSync(proofFile,validProofBytes);
      }
    }
    await refuseContribution('before-first-commitment',1,0);
    await refuseContribution('after-one-commitment',2,1);

    // Guard readers are composed only after the durable watcher trigger exists.
    // Their first capture and contribution-hook refreshes therefore reconstruct
    // the source after queueing rather than accepting a retained watcher verdict.
    const guardProofCalls=[0,0,0,0],guardReaders=makeReaders(4,guardProofCalls),creditDirectory=join(directory,'credit');
    credit=await openAuthorizedCredit({directory:creditDirectory,freshAdmission:{readers:guardReaders,candidate},watcherReceipt:receipt,deployment});
    const authorized=await credit.run();assert.equal(authorized.status,'confirmed');assert(authorized.transaction.numConfirmations>0);
    assert.equal(authorized.txId,authorized.transaction.id);assert.equal(authorized.counts.completedGuards,4);
    assert.deepEqual(authorized.sourceReceipts,[]);assert(guardProofCalls.every(value=>value>0));
    for(const checkpoint of authorized.checkpoints){assert.equal(checkpoint.claims,1);assert.equal(checkpoint.outputs,1);
      assert.equal(checkpoint.nullifiers,1);assert.equal(checkpoint.settlements,0);}
    assert.throws(()=>credit.backingClaim(),/V2 backing withdrawals require a reviewed payout join/);
    const retainedCheckpoints=structuredClone(authorized.checkpoints),readsBeforeRestart=[...guardProofCalls];
    await credit.close();credit=undefined;
    credit=await openAuthorizedCredit({directory:creditDirectory,freshAdmission:{readers:guardReaders,candidate},watcherReceipt:receipt,deployment});
    assert(guardProofCalls[0]>readsBeforeRestart[0],'Restart must reconstruct the source before ledger recovery');
    const recovered=await credit.run();assert.equal(recovered.status,'confirmed');assert.equal(recovered.txId,authorized.txId);
    assert.deepEqual(recovered.checkpoints,retainedCheckpoints);assert.deepEqual(recovered.counts,authorized.counts);
    await credit.close();credit=undefined;

    writeFileSync(join(inbox,d.txId+'.proof'),'malformed');
    assert.deepEqual(await guardReaders[0].verify(candidate,new AbortController().signal),{status:'pending'});
    const result={stage:'adapter-real-observation',daemonCount:2,independentAdministrators:false,sourceHeight:d.blockHeight,
      finalTip:await network.getCurrentHeight(),observationCount:rows.length,origin:rows[0].fromAddress,nativeKeyImageBound:true,
      actualOutProofVerified:true,lateDeliveryAccepted:true,watcherCommitments:receipt.commitments.length,watcherReplayStable:true,
      negativeContributionCounts,guardFreshProofCalls:guardProofCalls,durableCreditRestart:true,
      guardReloadRefusedMalformed:true,localGuardCreditVerified:true};
    writeFileSync(join(directory,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));
  }finally{
    await credit?.close();transport?.close();
    extractor?.close();network?.close();
    if(admissionDb?.isInitialized)await admissionDb.destroy();if(scannerDb?.isInitialized)await scannerDb.destroy();
    await vault?.close();await replica?.stop();await primary?.stop();delete process.env.MONERO_LOCAL_RPC_PORT;
  }
});
