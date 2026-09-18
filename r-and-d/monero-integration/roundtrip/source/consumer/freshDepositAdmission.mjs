import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openSync,closeSync,fstatSync,readSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {blake2b} from 'blakejs';
import {decodeIntent} from '../packages/monero-deposit/lib/intentCodec.ts';
import {verifyDeposit} from '../packages/monero-deposit/lib/depositPolicy.ts';
import {NATIVE_SOURCE_PIN} from '../packages/monero-deposit/lib/evidence.ts';
import {decodeDepositData,decodeDepositEnvelope} from './depositDelivery.mjs';

const canonical=value=>JSON.stringify(value,(_,item)=>item&&Object.getPrototypeOf(item)===Object.prototype
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=(domain,value)=>createHash('sha256').update(domain).update('\0').update(canonical(value)).digest('hex');
const hash=value=>assert(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),'Admission hash');
const integer=value=>assert(Number.isSafeInteger(value)&&value>=0,'Admission integer');
const decimal=value=>assert(typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=0xffffffffffffffffn,'Admission decimal');
function readBounded(file,limit){
  const fd=openSync(file,'r');
  try{const st=fstatSync(fd);assert(st.isFile()&&st.size>0&&st.size<=limit,'Admission evidence size');
    const bytes=Buffer.alloc(st.size+1),count=readSync(fd,bytes,0,bytes.length,0);
    assert.equal(count,st.size,'Admission evidence changed');return bytes.subarray(0,count);
  }finally{closeSync(fd);}
}

/**
 * Fresh deposit composition shared by a scanner admission worker and a guard.
 * Ports are operator-configured implementations, never fields of a deposit.
 * `observer` must be NativeDepositObserver; proof must invoke the pinned Core
 * OutProofV2 verifier; validateRecipient must parse the configured destination.
 * This produces an observation proposal. Durable economic uniqueness and credit
 * commitment still belong to the guard's backing ledger and release boundary.
 */
export function createFreshDepositAdmission({network,observer,configuration,deliveryDirectory,
  certificateDirectory,verifyProof,validateRecipient}){
  assert(isAbsolute(deliveryDirectory)&&isAbsolute(certificateDirectory),'Admission evidence directories');
  assert.equal(typeof verifyProof,'function');assert.equal(typeof validateRecipient,'function');
  const cfg=structuredClone(configuration);
  assert.deepEqual(Object.keys(cfg).sort(),['bridgeFee','committeeDigest','destinationAsset','genesis',
    'maxObservationAge','minConfirmations','networkFee','vaultAddress','vaultEpoch','vaultSpend'].sort(),'Admission configuration');
  for(const key of ['committeeDigest','destinationAsset','genesis','vaultSpend'])hash(cfg[key]);
  for(const key of ['bridgeFee','networkFee','vaultEpoch'])decimal(cfg[key]);
  assert(BigInt(cfg.vaultEpoch)>0n);assert(/^[1-9A-HJ-NP-Za-km-z]{95}$/.test(cfg.vaultAddress));
  integer(cfg.minConfirmations);integer(cfg.maxObservationAge);
  // Ordinary outputs need ten blocks independently of the configurable bridge
  // confirmation policy. Coinbase and additional timelocks are refused natively.
  assert(cfg.minConfirmations>=10&&cfg.maxObservationAge>=cfg.minConfirmations,'Admission age policy');
  Object.freeze(cfg);
  const scope=digest('rosen-monero/deposit-admission-scope/v1',cfg);
  const identity=id=>({kind:'independent',id,sourcePin:NATIVE_SOURCE_PIN});

  async function inspect(input,signal){
    const candidate=structuredClone(input);
    hash(candidate.txId);hash(candidate.sourceBlockId);integer(candidate.sourceHeight);
    assert.equal(candidate.scope,scope,'Admission scope');signal.throwIfAborted();
    const packet=await network.getBlockPacket(candidate.sourceBlockId,candidate.sourceHeight);
    const row=packet.transactions.find(tx=>tx.txId===candidate.txId);
    assert(row&&row.transactionHex===candidate.transactionHex,'Admission captured transaction');
    assert.equal(packet.height,candidate.sourceHeight);assert.equal(packet.blockHash,candidate.sourceBlockId);
    const tipHeight=await network.getCurrentHeight();integer(tipHeight);
    const tip=await network.getBlockAtHeight(tipHeight);
    assert.equal(tip.height,tipHeight);hash(tip.hash);
    const confirmations=tipHeight+1-candidate.sourceHeight;
    assert(confirmations>=cfg.minConfirmations,'Admission confirmations');

    // A proof is only a locator until native ownership/certificate replay and
    // canonical memo binding succeed. A malformed first delivery is retryable.
    const envelope=readBounded(join(deliveryDirectory,candidate.txId+'.proof'),74000);
    const tuple=JSON.parse(envelope.toString('utf8'));
    assert(Array.isArray(tuple)&&tuple.length===2&&typeof tuple[0]==='string'&&/^(?:[0-9a-f]{2}){1,4096}$/.test(tuple[0]),'Admission delivery');
    const intent=decodeIntent(Buffer.from(tuple[0],'hex'));
    assert.equal(intent.version,2);assert.equal(intent.txid,candidate.txId);assert.equal(intent.outputs.length,1);
    const outputIndex=Number(intent.outputs[0].output_index);integer(outputIndex);
    const certificate=readBounded(join(certificateDirectory,candidate.txId+'.'+outputIndex+'.certificate'),65536).toString('utf8');
    signal.throwIfAborted();
    const output=await observer.observe(packet,certificate,candidate.txId,outputIndex,signal);
    for(const [key,value] of Object.entries({genesis:cfg.genesis,committeeDigest:cfg.committeeDigest,vaultAddress:cfg.vaultAddress,
      txId:candidate.txId,blockHash:candidate.sourceBlockId,blockHeight:candidate.sourceHeight,outputIndex}))assert.equal(output[key],value,'Admission native '+key);
    const selected=intent.outputs[0];
    assert.equal(output.outputKey,selected.output_public_key);assert.equal(output.amountAtomic,selected.amount);
    const memo=decodeDepositData(output.depositData);assert(memo,'Admission deposit memo');
    const request=await decodeDepositEnvelope(envelope,candidate.txId,memo,{genesis:cfg.genesis,vaultSpend:cfg.vaultSpend});
    // Expiry is based on canonical on-chain metadata, never an invalid proof or
    // unavailable service. Retained expiry does not discharge the liability.
    const expired=tipHeight-candidate.sourceHeight>cfg.maxObservationAge||BigInt(tipHeight+1)>BigInt(memo.expiryHeight);

    async function current(){
      signal.throwIfAborted();
      const found=await network.getOutput(output.globalIndex);
      assert.deepEqual(found,{index:output.globalIndex,key:output.outputKey,mask:output.commitment,
        txId:candidate.txId,height:candidate.sourceHeight,unlocked:true},'Admission output consensus');
      assert.equal(await network.getKeyImageStatus(output.keyImage),0,'Admission spent output');
      const anchor=await network.getBlockAtHeight(candidate.sourceHeight);
      assert.equal(anchor.hash,candidate.sourceBlockId,'Admission source rollback');
      const retainedTip=await network.getBlockAtHeight(tipHeight);
      assert.equal(retainedTip.hash,tip.hash,'Admission snapshot rollback');
      const now=await network.getCurrentHeight();
      assert(now>=tipHeight,'Admission chain regression');
      assert(now-candidate.sourceHeight<=cfg.maxObservationAge&&BigInt(now+1)<=intent.expiry_height,'Admission expired during verification');
      signal.throwIfAborted();
    }
    // Validate the source anchor before returning terminal policy expiry.
    if(expired){assert.equal((await network.getBlockAtHeight(candidate.sourceHeight)).hash,candidate.sourceBlockId);signal.throwIfAborted();return {status:'expired'};}
    await current();
    const snapshot={id:digest('rosen-monero/deposit-snapshot/v1',{genesis:cfg.genesis,height:tipHeight,hash:tip.hash}),
      network:'mainnet',txid:candidate.txId,blockHash:candidate.sourceBlockId,blockHeight:BigInt(candidate.sourceHeight),
      chainHeight:BigInt(tipHeight+1),minConfirmations:BigInt(cfg.minConfirmations)};
    const providers={
      addresses:{identity:identity('configured-ergo-address-parser'),async verify(value){
        assert.equal(value.vaultAddress,cfg.vaultAddress);assert.equal(value.sourceNetwork,'mainnet');
        assert.equal(value.destinationNetwork,'ergo-testnet');assert.equal(value.destinationAsset,cfg.destinationAsset);
        await validateRecipient(value.recipient);return {status:'verified',value};
      }},
      proof:{identity:identity('core-outproof-v2'),async verify(value){
        const result=await verifyProof({txHex:candidate.transactionHex,txId:candidate.txId,vaultAddress:cfg.vaultAddress,
          messageHex:Buffer.from(value.messageBytes).toString('hex'),proof:value.proof},signal);
        assert.equal(result.sourcePin,NATIVE_SOURCE_PIN);assert.equal(result.txId,candidate.txId);
        assert.equal(result.vaultAddress,cfg.vaultAddress);assert.equal(result.messageHex,Buffer.from(value.messageBytes).toString('hex'));
        assert.equal(result.proof,value.proof);assert.equal(typeof result.good,'boolean');decimal(result.received);
        return {status:'verified',value:{...value,good:result.good,received:BigInt(result.received),inPool:false,confirmations:BigInt(confirmations)}};
      }},
      receipt:{identity:identity('rust-wallet-certificate-and-daemon-output'),async reconstruct(){
        await current();return {status:'verified',value:{network:'mainnet',txid:candidate.txId,vaultAddress:cfg.vaultAddress,
          blockHash:candidate.sourceBlockId,blockHeight:BigInt(candidate.sourceHeight),snapshotId:snapshot.id,inPool:false,
          outputs:[{index:BigInt(outputIndex),publicKey:output.outputKey,amount:BigInt(output.amountAtomic),owned:true,
            maturity:'unlocked',spent:'unspent',keyOccurrences:1n}]}};
      }},
    };
    const decision=await verifyDeposit(request.intentBytes,request.proof,request.receiptEvidence,{
      version:2,domain:'rosen-monero-deposit',sourceNetwork:'mainnet',vaultEpoch:cfg.vaultEpoch,vaultAddress:cfg.vaultAddress,
      destinationNetwork:'ergo-testnet',destinationAsset:cfg.destinationAsset,nativeSourcePin:NATIVE_SOURCE_PIN,
      outputHistoryPolicy:'authenticated-backing-v1',snapshot,creditedDepositIds:new Set(),creditedOutputIds:new Set(),
    },{bridgeFee:cfg.bridgeFee,networkFee:cfg.networkFee,sourceDecimals:12,destinationDecimals:12,remainder:'reject'},providers);
    assert.equal(decision.status,'accepted','Admission policy refused');await current();
    // Stable across chain growth and across readers; source re-inclusion changes
    // the descriptor. Snapshot/reader identities are deliberately not preimages.
    const backing=Object.freeze({version:2,genesis:cfg.genesis,committeeDigest:cfg.committeeDigest,vaultSpend:cfg.vaultSpend,
      vaultAddress:cfg.vaultAddress,intentHash:decision.intentHash,txId:candidate.txId,blockHash:candidate.sourceBlockId,
      blockHeight:candidate.sourceHeight,outputIndex,globalIndex:output.globalIndex,outputKey:output.outputKey,
      keyImage:output.keyImage,amountAtomic:output.amountAtomic,destinationNetwork:'ergo-testnet',destinationAsset:cfg.destinationAsset,
      recipient:decision.recipient,creditedAtomic:decision.destinationAmount.toString()});
    const observation=Object.freeze({fromChain:'monero',toChain:'ergo',fromAddress:'rosen-monero-output:v2:'+digest('rosen-monero/credit-origin/v2',backing),
      toAddress:decision.recipient,amount:decision.amount.toString(),bridgeFee:cfg.bridgeFee,networkFee:cfg.networkFee,
      sourceChainTokenId:'XMR',targetChainTokenId:cfg.destinationAsset,sourceTxId:candidate.txId,sourceBlockId:candidate.sourceBlockId,
      requestId:Buffer.from(blake2b(candidate.txId,undefined,32)).toString('hex'),rawData:''});
    return Object.freeze({status:'accepted',observation,backing,decision});
  }
  async function verify(candidate,signal){try{
    const result=await inspect(candidate,signal);return result.status==='accepted'?{status:'accepted',observation:result.observation}:result;
  }catch{return {status:'pending'};}}
  return Object.freeze({scope,inspect,verify});
}
