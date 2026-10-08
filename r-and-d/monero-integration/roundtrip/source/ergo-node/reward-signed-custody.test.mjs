import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createECDH,createHash} from 'node:crypto';
import {aggregateRewardStates,observeRewardSigned,publishCreateOnlyRecord,retainRewardSigned} from './reward-signed-custody.mjs';
import {canonicalAssignment,committeeConfigDigest} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {freshCreditConfigurations,openGuardCustody} from './credit-custody.mjs';

const h=n=>n.toString(16).padStart(64,'0');
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'reward-signed-custody-')),database=path.join(directory,'guard.sqlite');fs.writeFileSync(database,'custody');
  const assignment={binding:{creditTransactionDigest:h(1)},domain:'rosen-monero-reward-assignment-v1',creditAssignmentDigest:h(2),settlement:{reservationId:h(3)},
    paymentTxId:h(4),paymentByteDigest:h(5),rewardTransactionId:h(6),rewardPolicyDigest:h(7)};
  return {database,custodyDigest:h(8),assignment,snapshotDigest:h(1),txId:h(6),signedHex:'deadbeef'};}

test('retains exact public signed bytes beside one custody and reopens idempotently',()=>{const f=fixture(),first=retainRewardSigned(f);
  assert.equal(first.status,'retained');assert.equal(retainRewardSigned(structuredClone(f)).status,'existing');
  const record=observeRewardSigned(f);assert.equal(record.signedHex,f.signedHex);assert.equal(record.txId,f.txId);assert.equal(record.custodyDigest,f.custodyDigest);
  for(const change of [v=>v.custodyDigest=h(9),v=>v.assignment.paymentTxId=h(9)]){
    const altered=structuredClone(f);change(altered);assert.throws(()=>observeRewardSigned(altered));}
  assert.throws(()=>retainRewardSigned({...f,signedHex:'00'}),/retained conflict/);
});

test('torn or replaced signed custody never becomes recovery authority',()=>{const f=fixture();retainRewardSigned(f);
  const file=`${f.database}.reward-${f.txId}.signed.json`;fs.writeFileSync(file,'{');assert.throws(()=>observeRewardSigned(f));
  const other=fixture();retainRewardSigned(other);const target=`${other.database}.reward-${other.txId}.signed.json`;fs.unlinkSync(target);fs.mkdirSync(target);
  assert.throws(()=>observeRewardSigned(other),/record file/);
});

test('committee exposes only a three-guard identical signed quorum',()=>{const f=fixture();retainRewardSigned(f);const signed=observeRewardSigned(f),row={status:'assigned',assignment:f.assignment,signed};
  assert.equal(aggregateRewardStates([row,row,row,{status:'assigned',assignment:f.assignment}]).signed.signedHex,f.signedHex);
  assert.equal(aggregateRewardStates([row,row,{status:'assigned',assignment:f.assignment},{status:'assigned',assignment:f.assignment}]).signed,undefined);
  const changed=structuredClone(row);changed.signed.signedHex='00';changed.signed.signedDigest=hash(Buffer.from('00','hex'));
  assert.equal(aggregateRewardStates([row,row,changed,changed]).signed,undefined);
  changed.signed.signedDigest=h(10);assert.throws(()=>aggregateRewardStates([row,row,changed,changed]));
  const assignment=structuredClone(f.assignment);assignment.paymentTxId=h(11);assert.throws(()=>aggregateRewardStates([row,row,row,{status:'assigned',assignment}]));
});

test('create-only publication never replaces a concurrently published final record',()=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),'reward-create-only-')),
    final=path.join(directory,'final.json'),same=path.join(directory,'same.pending'),conflict=path.join(directory,'conflict.pending'),fresh=path.join(directory,'fresh.pending');
  fs.writeFileSync(final,'exact');fs.writeFileSync(same,'exact');assert.equal(publishCreateOnlyRecord(same,final,'exact'),'existing');assert.equal(fs.existsSync(same),false);
  fs.writeFileSync(conflict,'other');assert.throws(()=>publishCreateOnlyRecord(conflict,final,'other'),/existing conflict/);
  assert.equal(fs.readFileSync(final,'utf8'),'exact');assert.equal(fs.readFileSync(conflict,'utf8'),'other');
  const created=path.join(directory,'created.json');fs.writeFileSync(fresh,'fresh');assert.equal(publishCreateOnlyRecord(fresh,created,'fresh'),'published');
  assert.equal(fs.readFileSync(created,'utf8'),'fresh');assert.equal(fs.existsSync(fresh),false);
});

test('real guard custody binds signed recovery to its retained ledger database',()=>{const keys=[1,2,3,4].map(n=>{const key=createECDH('secp256k1');key.setPrivateKey(Buffer.from(h(n),'hex'));return key.getPublicKey('hex','compressed');}),
    deployment={guardPublicKeys:keys,guard:{boxId:h(20)},tokens:{Asset:h(21),RWT:h(22)},contracts:{Lock:{tree:'abcd'},GuardSign:{tree:'1234'}}},
    genesis=h(23),configuration=freshCreditConfigurations({deployment,scope:{network:'mainnet',vault:'fixed-vault'},genesis})[0],
    args={directory:fs.mkdtempSync(path.join(os.tmpdir(),'reward-real-custody-')),index:0,configuration,contributionPackageSha256:h(24)};
  const opened=openGuardCustody({...args,create:true}),request={binding:{obligationId:'retained',creditTransactionDigest:h(25),sourceIntentDigest:h(26),triggerBoxId:h(27),
    policyDigest:configuration.policyDigest,committeeDigest:committeeConfigDigest(configuration)},outputs:[{sourceNetwork:'mainnet',publicKey:h(28)}],
    backing:{version:2,genesis,committeeDigest:h(29),vaultSpend:h(30),vaultAddress:'vault',intentHash:h(26),txId:h(31),blockHash:h(32),blockHeight:90,
      outputIndex:0,globalIndex:105,outputKey:h(28),keyImage:h(33),amountAtomic:'1000',destinationNetwork:'ergo-testnet',destinationAsset:h(21),recipient:'recipient',creditedAtomic:'880'}},
    settlement={reservationId:h(34),reservationHash:h(35),requestDigest:h(36),selectionDigest:h(37),bindingDigest:h(38),expectationDigest:h(39)},
    assignment={binding:{creditTransactionDigest:h(25)},domain:'rosen-monero-reward-assignment-v1',creditAssignmentDigest:hash(canonicalAssignment(request)),settlement,
      paymentTxId:h(40),paymentByteDigest:h(41),rewardTransactionId:h(42),rewardPolicyDigest:h(43)};
  opened.ledger.assign(request);opened.ledger.reserveSettlement(request,settlement);opened.ledger.reserveReward(request,settlement,assignment);
  retainRewardSigned({database:opened.database,custodyDigest:opened.ledger.configDigest,assignment,snapshotDigest:h(25),txId:h(42),signedHex:'deadbeef'});opened.ledger.close();
  const reopened=openGuardCustody(args);try{reopened.ledger.assertReward(request,settlement,assignment);
    assert.equal(observeRewardSigned({database:reopened.database,custodyDigest:reopened.ledger.configDigest,assignment}).signedHex,'deadbeef');
    assert.throws(()=>observeRewardSigned({database:reopened.custody,custodyDigest:reopened.ledger.configDigest,assignment}),/custody database/);
  }finally{reopened.ledger.close();}
});
