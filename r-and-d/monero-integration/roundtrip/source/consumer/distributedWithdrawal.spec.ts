import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {launchDistributedNative,MoneroChain} from './adapter';
import {openParticipantVault} from './participantSigning.mjs';
import {recoverDistributedWithdrawal} from './distributedIssuer';
import {LocalMonero} from './localMonero';
import {terms} from './projectionFixture';
import {configureFixtureTokens} from './fixturePorts';
import {buildUnapprovedMoneroPayout} from '../guard-service/src/withdrawal/moneroWithdrawalOrder';
import {getTxDataHash,verify} from './integration';
import {setupAgreement,state,closeAgreementDatabase} from './agreementPorts';
import {FixtureAgreement,votes} from './agreementFixture';
import {setFixtureChain} from './resolver';
import {trace} from './trace';

const runtime=config.runtimeDirectory;
const binary=config.nativeBinary;
const sha256=process.env.PARTICIPANT_SHA256!;
let node:LocalMonero|undefined,closeVault:undefined|(()=>Promise<void>);
beforeEach(async()=>{node=await LocalMonero.start(runtime);process.env.MONERO_LOCAL_RPC_PORT=String(node.port);});
afterEach(async()=>{try{await closeVault?.();await closeAgreementDatabase();}finally{setFixtureChain(undefined);delete process.env.MONERO_LOCAL_RPC_PORT;await node?.stop();node=undefined;closeVault=undefined;}});

it('runs genuine Rosen agreement through separate original holders, recovery and node inclusion',async()=>{
  const data=terms();data.profile.maxMinerFeeAtomic='1000000000000';await configureFixtureTokens(data.profile.tokens);
  const chain=await MoneroChain.create();setFixtureChain(chain);
  const request=await buildUnapprovedMoneroPayout(data.source,data.profile);await setupAgreement(request.eventId);
  const vault=await openParticipantVault({binary,sha256,runtime});closeVault=vault.close;
  const timestamp=Math.floor(Date.now()/1000),database=join(mkdtempSync(join(runtime,'distributed-reservation-')),'custody.sqlite');
  const authority={epoch:'1',publicKeys:state.keys,requiredSign:3,nativeParticipants:[1,2,3,4],nativeThreshold:2,nativeSelected:[1,2]};
  const owner=await launchDistributedNative(vault,request,{database,clock:()=>1000n,leaseDuration:1000000n,authority},timestamp);
  expect(await verify(owner.transaction)).toBe(true);
  const proposalId=owner.transaction.txId;
  const balance=await chain.getTransactionAssets(owner.transaction),order=chain.extractTransactionOrder(owner.transaction);
  const agreement=new FixtureAgreement();await agreement.prepare();
  const signatures=await votes(owner.transaction,timestamp);
  await agreement.approve(owner.transaction,[...signatures.slice(0,3),''],timestamp);
  const receipt=agreement.takeVerifiedAgreement(getTxDataHash(owner.transaction));expect(receipt).toBeDefined();
  await owner.approve(receipt);expect(owner.counts().shares).toBe(0);
  const final=await owner.sign();expect(owner.counts().shares).toBe(2);expect(final.txId).not.toBe(proposalId);
  const recovered=await recoverDistributedWithdrawal(database,final.reservationId,binary,sha256);
  expect(recovered.byteDigest).toBe(final.byteDigest);expect(Buffer.from(recovered.txBytes)).toEqual(Buffer.from(final.txBytes));
  expect((await node!.submit(recovered.txBytes)).status).toBe('OK');
  expect((await node!.transaction(final.txId)).txs[0].in_pool).toBe(true);
  await node!.mine(2,vault.vaultAddress);
  const confirmed=(await node!.transaction(final.txId)).txs[0];expect(confirmed.in_pool).toBe(false);expect(confirmed.tx_hash).toBe(final.txId);
  await expect(owner.sign()).rejects.toThrow('sign-used');
  trace('distributed-node-confirmed',{participants:4,selected:[1,2],walletShares:owner.counts().shares,proposalId,finalTxId:final.txId,
    byteDigest:final.byteDigest,blockHeight:confirmed.block_height,recipientAtomic:String(order[0].assets.nativeToken),
    feeAtomic:String(balance.inputAssets.nativeToken-balance.outputAssets.nativeToken),identicalRecovery:true});
});
