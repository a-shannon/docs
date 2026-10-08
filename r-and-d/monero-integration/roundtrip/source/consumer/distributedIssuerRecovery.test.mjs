import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,expect,vi} from 'vitest';

const harness=vi.hoisted(()=>({projection:null,selection:null,receipt:null,held:[],frames:new Map(),signs:0,prepares:0}));
globalThis.__distributedIssuerRecoveryHarness=harness;
vi.mock('./participantSigning.mjs',()=>({prepareParticipantSigning:vi.fn(async()=>{const held=harness.held.shift();if(!held)throw Error('test:held');return held;}),recoverParticipantFinal:vi.fn()}));
vi.mock('../guard-service/src/withdrawal/moneroWithdrawalNativeProjection.ts',()=>({captureUnapprovedMoneroPayoutRequest:vi.fn(async()=>harness.projection)}));
vi.mock('../guard-service/src/withdrawal/moneroWithdrawalSelection.ts',()=>({
  decodeNativeSelection:vi.fn(value=>{if(value!==harness.selection?.bytes)throw Error('test:selection');return harness.selection;}),
  validateConstructionReceipt:vi.fn(value=>Object.freeze({...value})),
}));
vi.mock('./retainedCodec.ts',()=>({
  retainedRequest:vi.fn((projection,challenge)=>Object.freeze({fields:Object.freeze([challenge,projection.eventId]),hex:'72657175657374'})),
  retainedReceipt:vi.fn(()=>harness.receipt),
  positive:vi.fn(value=>value),
}));
vi.mock('./codec.ts',()=>({
  frame:vi.fn(value=>{const result=harness.frames.get(value);if(!result)throw Error('test:frame');return result;}),
  canonical:vi.fn((eventId,candidate,id)=>JSON.stringify({eventId,network:'monero',txBytes:candidate,txId:id,txType:'payment'})),
  decimal:vi.fn(value=>BigInt(value)),U64:(1n<<64n)-1n,
  hex:(value,maxBytes,exact)=>{if(typeof value!=='string'||value.length>maxBytes*2||!/^(?:[0-9a-f]{2})+$/.test(value)||(exact!==undefined&&value.length!==exact*2))throw Error('Invalid hex');return Buffer.from(value,'hex');},
}));
vi.mock('./approvalAuthority.ts',()=>({captureAuthority:vi.fn(),decodeApprovalDescriptor:vi.fn(),bindVerifiedAgreement:vi.fn(),ownData:value=>({...value})}));
vi.mock('./backingClaim.mjs',()=>({revalidateBackingClaim:vi.fn(),assertBackingOccurrence:vi.fn(),assertBackingSelection:vi.fn(),reserveBackingSettlement:vi.fn(),assertBackingSettlement:vi.fn(),captureBackingClaim:vi.fn()}));
vi.mock('../guard-service/src/agreement/txAgreement.ts',()=>({consumeVerifiedAgreement:vi.fn(value=>value),assertVerifiedAgreementCurrent:vi.fn()}));

const [{beginDistributedSigning,reconcileCompletedReservation,openDistributedWithdrawal},{WithdrawalJournal},participant,authority]=await Promise.all([
  import('./distributedIssuer.ts'),import('./withdrawalJournal.ts'),import('./participantSigning.mjs'),import('./approvalAuthority.ts'),
]);

const h=value=>value.toString(16).padStart(64,'0');
const receipt=Object.freeze({status:'accepted',signing:'retained',eventId:h(1),instructionDigest:h(2),requestDigest:h(3),
  network:'testnet',address:'A1',amount:'80',maxMinerFeeAtomic:'20',necessaryFeeAtomic:'10',inputCount:2});
const expected=Object.freeze({reservationId:h(4),reservationHash:h(5),requestJson:JSON.stringify({eventId:h(1)}),selectionBytes:'selection',
  eventId:h(1),sourceNetwork:'testnet',network:'testnet',vaultSpend:h(6),vaultView:h(7),receipt});
const completed=()=>({...expected,state:'completed',owner:h(8),generation:'1',leaseUntil:'1000',receiptHash:h(9)});

test('post-commit acknowledgement loss accepts only the exact durable completion',async()=>{
  let reads=0;const registry={read:async id=>{reads++;expect(id).toBe(expected.reservationId);return completed();}};
  expect(await reconcileCompletedReservation({status:'indeterminate',reason:'ack-lost'},registry,expected)).toEqual(completed());
  expect(reads).toBe(1);
  expect(await reconcileCompletedReservation({status:'completed',reservation:completed()},registry,expected)).toEqual(completed());
  expect(reads).toBe(1);
  for(const mutate of [
    value=>value.requestJson='{}',value=>value.selectionBytes='other',value=>value.eventId=h(20),value=>value.sourceNetwork='mainnet',
    value=>value.network='mainnet',value=>value.vaultSpend=h(21),value=>value.vaultView=h(22),value=>value.receipt={...receipt,amount:'79'},
  ]){const changed=completed();mutate(changed);await expect(reconcileCompletedReservation({status:'completed',reservation:changed},registry,expected)).rejects.toThrow('distributed:reservation-recovery');}
  await expect(reconcileCompletedReservation({status:'indeterminate'}, {read:async()=>({...completed(),state:'claimed'})},expected)).rejects.toThrow('distributed:reservation-recovery');
});

class Journal{
  constructor(entry=null,losePrepareAck=false){this.entry=entry;this.marks=0;this.losePrepareAck=losePrepareAck;}
  async readIfPresent(){await Promise.resolve();return this.entry&&structuredClone(this.entry);}
  async prepare(anchor){if(this.entry)throw Error('journal:duplicate');this.entry={state:'prepared',anchor:structuredClone(anchor),final:null};
    if(this.losePrepareAck)throw Error('journal:ack-failed-after-commit');return structuredClone(this.entry);}
  async markSigning(){if(this.entry?.state!=='prepared')throw Error('journal:signing-used');this.entry={...this.entry,state:'signing'};this.marks++;return structuredClone(this.entry);}
}
const anchor=Object.freeze({reservation:{reservationId:h(4)},requestDigest:h(3),bindingDigest:h(10),expectationDigest:h(11)});

test('the journal CAS lets only one exact prepared owner enter native signing',async()=>{
  const journal=new Journal(),results=await Promise.allSettled([beginDistributedSigning(journal,anchor),beginDistributedSigning(journal,anchor)]);
  expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(journal.marks).toBe(1);expect(journal.entry.state).toBe('signing');
  const ackLost=new Journal(null,true);await expect(beginDistributedSigning(ackLost,anchor)).resolves.toBeTruthy();
  expect(ackLost.marks).toBe(1);expect(ackLost.entry.state).toBe('signing');
  await expect(beginDistributedSigning(new Journal({state:'prepared',anchor:{...anchor,bindingDigest:h(99)},final:null}),anchor)).rejects.toThrow('distributed:journal-anchor');
  await expect(beginDistributedSigning(new Journal({state:'signing',anchor,final:null}),anchor)).rejects.toThrow('distributed:journal-state');
});

test('the real open path reads a completed SQLite reservation and lets only one attempt sign',async()=>{
  harness.frames.clear();harness.held.length=0;harness.signs=0;harness.prepares=0;
  const timestamp=1700000000,eventId=h(101),instructionDigest=h(102),requestDigest=h(103),vaultSpend=h(104),vaultView=h(105);
  const projection={eventId,instructionDigest,requestDigest,sourceNetwork:'testnet',network:'testnet',address:'A1',amount:'80',ceiling:'20',
    request:{eventId,requestDigest,canonicalRequest:'request'}};
  const selection={bytes:'selection-v1',network:'testnet',vaultSpend,vaultView,inputs:[
    {publicKey:h(110),txid:h(111),outputIndex:'0',globalIndex:'10',amount:'40',commitment:h(112)},
    {publicKey:h(113),txid:h(114),outputIndex:'1',globalIndex:'11',amount:'60',commitment:h(115)},
  ]};
  harness.projection=projection;harness.selection=selection;harness.receipt=Object.freeze({status:'unapproved-native-intent',signing:'prohibited',
    eventId,instructionDigest,requestDigest,network:'testnet',address:'A1',amount:'80',maxMinerFeeAtomic:'20',necessaryFeeAtomic:'10',inputCount:2});
  const root=mkdtempSync(join(tmpdir(),'distributed-recovery-')),database=join(root,'custody.sqlite');
  const makeHeld=index=>{
    const directory=mkdtempSync(join(root,`attempt-${index}-`)),expectation=Buffer.from(`expectation-${index}`),expectationDigest=createHash('sha256').update(expectation).digest('hex');
    writeFileSync(join(directory,'expectation.private'),expectation);
    const candidate=`candidate-${index}`,id=h(120+index),binding=h(130+index),txDataHash=h(140+index),bytes=Buffer.alloc(135);
    Buffer.from(instructionDigest,'hex').copy(bytes,71);Buffer.from(requestDigest,'hex').copy(bytes,103);
    harness.frames.set(candidate,{bytes,eventId,id});
    const bytesHex=`0${index}0203`,byteDigest=createHash('sha256').update(Buffer.from(bytesHex,'hex')).digest('hex');
    return {candidate:{selection:selection.bytes,changeOutputKey:h(150+index),changeOutputIndex:0,candidate,receipt:'receipt',inputAtomic:'100',changeAtomic:'10',
      txJson:JSON.stringify({eventId,network:'monero',txBytes:candidate,txId:id,txType:'payment'}),descriptor:'descriptor',expectationDigest,binding,txDataHash},
      directories:[directory],counts:()=>({shares:harness.signs}),close:vi.fn(),sign:vi.fn(async(_certificate,current)=>{await current();harness.signs++;
        return {expectationDigest,binding,txId:h(160+index),byteDigest,bytesHex};})};
  };
  harness.held.push(makeHeld(1),makeHeld(2));
  vi.mocked(authority.captureAuthority).mockImplementation(value=>value);
  vi.mocked(authority.decodeApprovalDescriptor).mockReturnValue({digest:h(170)});
  vi.mocked(authority.bindVerifiedAgreement).mockImplementation(verified=>verified.txDataHash);
  let constructAckFaults=0,prepareAckFaults=0;
  const vault={genesis:h(180),groupKey:vaultSpend,vaultAddress:'vault'},setup={database,clock:()=>1000n,leaseDuration:1000n,
    authority:{epoch:'1',publicKeys:['02'+h(181),'02'+h(182),'02'+h(183),'02'+h(184)],requiredSign:3,
      nativeParticipants:[1,2,3,4],nativeThreshold:2,nativeSelected:[1,2]},
    fault:point=>{if(point==='construct-after-commit'){constructAckFaults++;throw Error('test:construct-ack-lost');}},
    journalFault:point=>{if(point==='prepared-after-commit'){prepareAckFaults++;throw Error('test:prepare-ack-lost');}}};
  const first=await openDistributedWithdrawal(vault,projection.request,setup,timestamp);
  const second=await openDistributedWithdrawal(vault,projection.request,{...setup,fault:undefined,journalFault:undefined},timestamp);
  expect(constructAckFaults).toBe(1);expect(participant.prepareParticipantSigning).toHaveBeenCalledTimes(2);
  await first.approve({certificate:{timestamp},txDataHash:h(141)});await second.approve({certificate:{timestamp},txDataHash:h(142)});
  await expect(first.sign()).resolves.toMatchObject({status:'completed-retained-withdrawal'});expect(prepareAckFaults).toBe(1);
  await expect(second.sign()).rejects.toThrow('distributed:journal-state');expect(harness.signs).toBe(1);
  const journal=await WithdrawalJournal.open(database);try{expect((await journal.read(first.reservationId)).state).toBe('completed');}finally{await journal.close();}
});
