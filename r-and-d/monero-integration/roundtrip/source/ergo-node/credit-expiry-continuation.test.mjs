import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createECDH} from 'node:crypto';
import * as wasm from 'ergo-lib-wasm-nodejs';
import {createFreshDepositAdmission} from '../consumer/freshDepositAdmission.mjs';
import {encodeDepositMemo,encodeDepositEnvelope} from '../consumer/depositDelivery.mjs';
import {encodeIntent} from '../packages/monero-deposit/lib/intentCodec.ts';
import {NATIVE_SOURCE_PIN} from '../packages/monero-deposit/lib/evidence.ts';
import {MoneroCreditAssignment,canonicalAssignment,committeeConfigDigest} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {createMoneroCreditSigner,snapshotCreditSigning} from '../guard-service/src/deposit/moneroCreditSigner.mjs';
import {freshCreditConfigurations} from './credit-custody.mjs';
import {captureFreshCreditSource} from './fresh-credit-source.mjs';

const h=n=>n.toString(16).padStart(64,'0');
const signal=()=>new AbortController().signal;
const signingFixture=JSON.parse(readFileSync(new URL('../guard-service/src/deposit/fixtures/credit-signing.json',import.meta.url),'utf8'));
const keys=[1,2,3,4].map(n=>{const key=createECDH('secp256k1');key.setPrivateKey(Buffer.from(h(n),'hex'));return key.getPublicKey('hex','compressed');});
const signingInputs=()=>[wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(signingFixture.txBytes,'hex')),3,
  signingFixture.inputBoxes.map(hex=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(hex,'hex'))),
  signingFixture.dataInputs.map(hex=>wasm.ErgoBox.sigma_parse_bytes(Buffer.from(hex,'hex')))];
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

// The only synthetic ports are the external Monero daemon, native observer and
// proof verifier. Admission, source selection, SQLite custody and signing gate
// are the production components used by the local roundtrip.
function sourceFixture(){
  const directory=mkdtempSync(join(tmpdir(),'monero-credit-expiry-'));
  const configuration={genesis:h(1),committeeDigest:h(2),vaultSpend:h(3),vaultAddress:'4'.repeat(95),vaultEpoch:'1',
    destinationAsset:h(4),bridgeFee:'100',networkFee:'20',minConfirmations:10,maxObservationAge:100};
  const candidate={id:1,txId:h(5),sourceBlockId:h(6),sourceHeight:4097,transactionHex:'aabb',scope:''};
  const intent={version:2,domain:'rosen-monero-deposit',source_network:'mainnet',vault_epoch:'1',vault_address:configuration.vaultAddress,
    destination_network:'ergo-testnet',destination_asset:h(4),bridge_fee:'100',network_fee:'20',txid:h(5),to_address:'test-recipient',
    amount:'10000',expiry_height:4198n,outputs:[{output_index:1n,output_public_key:h(7),amount:'10000'}]};
  const memo={genesis:h(1),vaultSpend:h(3),sourceNetwork:'mainnet',destinationNetwork:'ergo-testnet',vaultEpoch:'1',
    destinationAsset:h(4),amount:'10000',bridgeFee:'100',networkFee:'20',expiryHeight:'4198',recipient:'test-recipient'};
  const output={version:1,committeeDigest:h(2),sourceBinding:h(8),genesis:h(1),vaultAddress:configuration.vaultAddress,txId:h(5),
    blockHash:h(6),blockHeight:4097,outputIndex:1,globalIndex:8888,outputKey:h(7),commitment:h(9),amountAtomic:'10000',
    keyImage:h(10),depositData:[encodeDepositMemo(memo).toString('hex')]};
  const packet={blockHex:'bb',blockHash:h(6),height:4097,miner:{txId:h(11),transactionHex:'aa',outputIndices:[8886]},
    transactions:[{txId:h(5),transactionHex:'aabb',outputIndices:[8887,8888]}]};
  const state={tip:4197,spent:0,sourceHash:h(6),tipHash:h(12),proofCalls:0,nativeCalls:0};
  const network={getBlockPacket:async()=>structuredClone(packet),getCurrentHeight:async()=>state.tip,
    getBlockAtHeight:async height=>({height,hash:height===4097?state.sourceHash:state.tipHash}),
    getOutput:async index=>({index,key:h(7),mask:h(9),txId:h(5),height:4097,unlocked:true}),
    getKeyImageStatus:async()=>state.spent};
  const observer={async observe(received,certificate,txId,index,abort){state.nativeCalls++;abort.throwIfAborted();
    assert.deepEqual(received,packet);assert.equal(certificate,'test-certificate\n');assert.equal(txId,h(5));assert.equal(index,1);
    return structuredClone(output);}};
  const options={network,observer,configuration,deliveryDirectory:directory,certificateDirectory:directory,
    async verifyProof(request){state.proofCalls++;return {...request,sourcePin:NATIVE_SOURCE_PIN,good:true,received:'10000'};},
    async validateRecipient(value){assert.equal(value,'test-recipient');}};
  writeFileSync(join(directory,h(5)+'.proof'),encodeDepositEnvelope({intentBytes:encodeIntent(intent),proof:'OutProofV2'+'1'.repeat(132)}));
  writeFileSync(join(directory,h(5)+'.1.certificate'),'test-certificate\n');
  const readers=()=>[0,1,2,3].map(()=>createFreshDepositAdmission(options));
  const first=readers();candidate.scope=first[0].scope;
  return {directory,candidate,state,readers,first};
}

function requestFor(read,snapshot,configuration){
  const {decision,backing}=read;
  return {binding:{obligationId:decision.depositId,creditTransactionDigest:snapshot.digest,
    sourceIntentDigest:decision.intentHash,triggerBoxId:h(16),policyDigest:configuration.policyDigest,
    committeeDigest:committeeConfigDigest(configuration)},
    outputs:decision.outputs.map(output=>({sourceNetwork:decision.sourceNetwork,publicKey:output.publicKey})),
    backing:structuredClone(backing)};
}

// This callback composes the real source and durable ledger. It does not supply
// an admission verdict or bypass the source's assigned-versus-new selection.
function verifier(source,ledger,configuration){
  return async snapshot=>{
    const first=await source.read(0),assignment=requestFor(first,snapshot,configuration);
    const exactClaim=()=>{
      const claim=ledger.readClaim(assignment.binding.obligationId);
      if(claim.status==='assigned'){
        assert.equal(canonicalAssignment(claim.request),canonicalAssignment(assignment),'Exact retained assignment');
        ledger.assertAssigned(assignment);
      }else assert.equal(claim.status,'missing','Assigned claim invalidated');
    };
    const assertCurrent=()=>{source.current();exactClaim();};
    assertCurrent();
    return {assignment,assertCurrent,async revalidate(){
      const refreshed=await source.revalidate(0,first),again=requestFor(refreshed,snapshot,configuration);
      assert.equal(canonicalAssignment(again),canonicalAssignment(assignment),'Retained request changed');
      assertCurrent();return {assignment:again,assertCurrent};
    }};
  };
}

function queueSigner(source,ledger,configuration,args){
  const entered=deferred(),finish=deferred(),calls={commitments:0,shares:0};
  const prover={generate_commitments_for_reduced_transaction(){calls.commitments++;},
    sign_reduced_transaction_multi(){calls.shares++;}};
  const participant={contributionValidationVersion:1,getProver:()=>prover,
    sign:()=>{entered.resolve();return finish.promise;},isInSign:()=>true,handleMessage(){},handleMyTurn(){},cleanup(){}};
  const signer=createMoneroCreditSigner({participant,assignment:ledger,verify:verifier(source,ledger,configuration),requireFreshContribution:true});
  const snapshot=snapshotCreditSigning(...args),job=signer.sign(...args);
  const queued=Promise.race([entered.promise,job.then(()=>{throw Error('Signer resolved before queue');},error=>{throw error;})]);
  const hook=kind=>({txId:snapshot.txId,reducedHex:snapshot.reducedHex,kind});
  const commitment=()=>participant.getProver().generate_commitments_for_reduced_transaction(args[0]);
  const peerShare=()=>participant.getProver().sign_reduced_transaction_multi(args[0]);
  return {signer,job,entered:queued,finish,hook,commitment,peerShare,calls,snapshot};
}

test('assigned credit crosses source expiry before commitment, survives restart, and fails closed on lost backing',async t=>{
  const f=sourceFixture(),args=signingInputs(),snapshot=snapshotCreditSigning(...args);
  const firstAdmission=await f.first[0].inspect(f.candidate,signal());
  assert.equal(firstAdmission.status,'accepted');
  const watcherReceipt={observation:{...firstAdmission.observation,height:firstAdmission.backing.blockHeight},trigger:{boxId:h(16)}};
  delete watcherReceipt.observation.rawData;
  const deployment={guardPublicKeys:keys,guard:{boxId:h(17)},tokens:{Asset:h(4),RWT:h(18)},
    contracts:{Lock:{tree:'abcd'},GuardSign:{tree:'1234'}}};
  const configuration=freshCreditConfigurations({deployment,scope:f.candidate.scope,genesis:h(1)})[0];
  const database=join(f.directory,'credit.sqlite');let ledger=MoneroCreditAssignment.create(database,configuration);
  t.after(()=>ledger.close());
  const openSource=async()=>captureFreshCreditSource({freshAdmission:{readers:f.readers(),candidate:f.candidate},
    watcherReceipt,readClaim:obligationId=>ledger.readClaim(obligationId)});
  const source=await openSource();assert.equal(source.initial.decision.status,'accepted');
  const expected=requestFor(source.initial,snapshot,configuration);
  const queued=queueSigner(source,ledger,configuration,args);await queued.entered;
  assert.equal(ledger.assertAssigned(expected).status,'assigned');
  assert.equal(queued.calls.commitments,0);

  // The next block makes a new delivery too late, but it cannot erase an
  // already assigned economic liability whose original backing remains live.
  f.state.tip=4198;
  assert.deepEqual(await f.readers()[0].inspect(f.candidate,signal()),{status:'expired'});
  const emptyFile=join(f.directory,'unassigned.sqlite');
  const empty=MoneroCreditAssignment.create(emptyFile,configuration);
  try {await assert.rejects(()=>captureFreshCreditSource({freshAdmission:{readers:f.readers(),candidate:f.candidate},
    watcherReceipt,readClaim:obligationId=>empty.readClaim(obligationId)}),/expired|not accepted/i);
    assert.equal(empty.checkpoint().outputs,0);
  }finally{empty.close();}
  await queued.signer.refreshContribution(queued.hook('commitment'));
  queued.commitment();assert.equal(queued.calls.commitments,1);
  queued.signer.close();queued.finish.reject(Error('simulated process exit before signing completed'));
  await assert.rejects(queued.job,/simulated process exit/);
  ledger.close();ledger=MoneroCreditAssignment.open(database,configuration);
  assert.equal(ledger.assertAssigned(expected).status,'assigned');
  const reopened=await openSource();assert.equal(reopened.initial.decision.status,'retained');
  assert.deepEqual(reopened.initial.backing,firstAdmission.backing);
  const resumed=queueSigner(reopened,ledger,configuration,args);await resumed.entered;
  assert.equal(ledger.assertAssigned(expected).status,'assigned');
  assert.equal(resumed.calls.commitments,0);
  await resumed.signer.refreshContribution(resumed.hook('commitment'));
  resumed.commitment();assert.equal(resumed.calls.commitments,1);
  resumed.finish.resolve('signed');assert.equal(await resumed.job,'signed');resumed.signer.close();

  async function refusal(name,mutate,restore){
    const pending=queueSigner(reopened,ledger,configuration,args);await pending.entered;
    mutate();await assert.rejects(pending.signer.refreshContribution(pending.hook('commitment')),name);
    assert.throws(pending.commitment);assert.equal(pending.calls.commitments,0);
    pending.signer.close();pending.finish.reject(Error('stopped after refused contribution'));
    await assert.rejects(pending.job,/stopped after refused contribution/);restore();
  }
  await refusal(/Admission spent output/,()=>{f.state.spent=1;},()=>{f.state.spent=0;});
  await refusal(/Admission source rollback/,()=>{f.state.sourceHash=h(99);},()=>{f.state.sourceHash=h(6);});
  await refusal(/invalidated|Assigned claim invalidated/,()=>{ledger.invalidate(expected.binding.obligationId,'source-invalidated');},()=>{});
  assert.equal(ledger.readClaim(expected.binding.obligationId).status,'invalidated');
  assert.equal(f.state.tip,4198);
  assert(f.state.proofCalls>0);assert(f.state.nativeCalls>0);
});
