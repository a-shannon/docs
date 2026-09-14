import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileEconomicOperations} from './economicReconciliation.mjs';

const h=n=>n.toString(16).padStart(64,'0').slice(-64);
const amounts=['depositAtomic','outstandingUserAtomic','pendingPayoutAtomic','issuedDepositFeeTokenAtomic','retainedReturnFeeAtomic','selectedReserveAtomic','accountedBackingAtomic','paidRecipientAtomic','paidMinerFeeAtomic','pendingMinerFeeAtomic','chargedBridgeFeeAtomic','chargedNetworkFeeAtomic','feeCoverageVarianceAtomic','selectedResidualAtomic','feeBackingRequirementAtomic'];

function operation(stage='settled',offset=0){
  const depositTx=h(20+offset),id=`monero:deposit:mainnet:${depositTx}`,depositKey=h(30+offset),creditTx=h(40+offset),creditBox=h(50+offset),redemptionTx=h(60+offset);
  const reserveTx=h(70+offset),reserveKey=h(80+offset),reservationId=h(90+offset),proposalId=h(100+offset),changeKey=h(110+offset),finalTx=h(120+offset);
  const value={operationId:id,genesis:h(1),vaultSpend:h(2+offset),assetId:h(3),deposit:{txId:depositTx,outputIndex:7,publicKey:depositKey,amountAtomic:'1000'},credit:null,redemption:null,withdrawal:null};
  if(stage!=='deposited')value.credit={txId:creditTx,boxId:creditBox,depositId:id,recipientAtomic:'880',bridgeFeeAtomic:'80',networkFeeAtomic:'40',issuedFeeTokenAtomic:'120'};
  if(['redeemed','reserved','settled'].includes(stage))value.redemption={txId:redemptionTx,creditTxId:creditTx,creditBoxId:creditBox,amountAtomic:'880',bridgeFeeAtomic:'50',networkFeeAtomic:'30'};
  if(['reserved','settled'].includes(stage))value.withdrawal={reservationId,proposalId,redemptionTxId:redemptionTx,inputs:[{txId:reserveTx,outputIndex:8,publicKey:reserveKey,amountAtomic:'200'},{txId:depositTx,outputIndex:7,publicKey:depositKey,amountAtomic:'1000'}],recipientAtomic:'800',minerFeeAtomic:'20',changeAtomic:'380',changePublicKey:changeKey,settlement:null};
  if(stage==='settled')value.withdrawal.settlement={txId:finalTx,proposalId,reservationId,inputAtomic:'1200',recipientAtomic:'800',minerFeeAtomic:'20',changeAtomic:'380',changePublicKey:changeKey,rewardState:'pending-reward'};
  return value;
}
const clone=value=>structuredClone(value);
const reject=(mutate,expected=/economic:/,label='')=>{const value=operation();mutate(value);assert.throws(()=>reconcileEconomicOperations([value]),typeof expected==='string'?/economic:/:expected,label||String(expected));};
const rejectExact=(mutate,message,stage='settled')=>{const value=operation(stage);mutate(value);assert.throws(()=>reconcileEconomicOperations([value]),error=>error instanceof Error&&error.message===message);};

test('reconciles every lifecycle state using decimal-string BigInt arithmetic',()=>{
  const settled=operation('settled'),deposited=operation('deposited',1),credited=operation('credited',2),redeemed=operation('redeemed',3),reserved=operation('reserved',4);
  credited.deposit.amountAtomic='2000';credited.credit.recipientAtomic='1700';credited.credit.bridgeFeeAtomic='200';credited.credit.networkFeeAtomic='100';credited.credit.issuedFeeTokenAtomic='300';
  reserved.deposit.amountAtomic='1500';reserved.credit.recipientAtomic='1300';reserved.credit.bridgeFeeAtomic='120';reserved.credit.networkFeeAtomic='80';reserved.credit.issuedFeeTokenAtomic='200';reserved.redemption.amountAtomic='1300';reserved.redemption.bridgeFeeAtomic='60';reserved.redemption.networkFeeAtomic='40';reserved.withdrawal.inputs[0].amountAtomic='500';reserved.withdrawal.inputs[1].amountAtomic='1500';reserved.withdrawal.recipientAtomic='1200';reserved.withdrawal.minerFeeAtomic='25';reserved.withdrawal.changeAtomic='775';
  const result=reconcileEconomicOperations([settled,deposited,credited,redeemed,reserved]);
  assert.equal(result.scope,'selected-input-reconciliation-v1');
  assert.deepEqual(result.operations.map(row=>row.state),['settled','deposited','credited','redeemed','reserved']);
  for(const row of result.operations)for(const key of amounts)assert.match(row[key],/^-?(?:0|[1-9][0-9]*)$/);
  assert.deepEqual(result.operations[0],{operationId:settled.operationId,state:'settled',depositAtomic:'1000',outstandingUserAtomic:'0',pendingPayoutAtomic:'0',issuedDepositFeeTokenAtomic:'120',retainedReturnFeeAtomic:'80',selectedReserveAtomic:'200',accountedBackingAtomic:'380',paidRecipientAtomic:'800',paidMinerFeeAtomic:'20',pendingMinerFeeAtomic:'0',chargedBridgeFeeAtomic:'130',chargedNetworkFeeAtomic:'70',feeCoverageVarianceAtomic:'50',selectedResidualAtomic:'180',feeBackingRequirementAtomic:'200'});
  assert.deepEqual(result.operations[1],{operationId:deposited.operationId,state:'deposited',depositAtomic:'1000',outstandingUserAtomic:'1000',pendingPayoutAtomic:'0',issuedDepositFeeTokenAtomic:'0',retainedReturnFeeAtomic:'0',selectedReserveAtomic:'0',accountedBackingAtomic:'1000',paidRecipientAtomic:'0',paidMinerFeeAtomic:'0',pendingMinerFeeAtomic:'0',chargedBridgeFeeAtomic:'0',chargedNetworkFeeAtomic:'0',feeCoverageVarianceAtomic:'0',selectedResidualAtomic:'0',feeBackingRequirementAtomic:'0'});
  assert.deepEqual(result.operations[2],{operationId:credited.operationId,state:'credited',depositAtomic:'2000',outstandingUserAtomic:'1700',pendingPayoutAtomic:'0',issuedDepositFeeTokenAtomic:'300',retainedReturnFeeAtomic:'0',selectedReserveAtomic:'0',accountedBackingAtomic:'2000',paidRecipientAtomic:'0',paidMinerFeeAtomic:'0',pendingMinerFeeAtomic:'0',chargedBridgeFeeAtomic:'200',chargedNetworkFeeAtomic:'100',feeCoverageVarianceAtomic:'100',selectedResidualAtomic:'0',feeBackingRequirementAtomic:'300'});
  assert.deepEqual(result.operations[3],{operationId:redeemed.operationId,state:'redeemed',depositAtomic:'1000',outstandingUserAtomic:'0',pendingPayoutAtomic:'800',issuedDepositFeeTokenAtomic:'120',retainedReturnFeeAtomic:'80',selectedReserveAtomic:'0',accountedBackingAtomic:'1000',paidRecipientAtomic:'0',paidMinerFeeAtomic:'0',pendingMinerFeeAtomic:'0',chargedBridgeFeeAtomic:'130',chargedNetworkFeeAtomic:'70',feeCoverageVarianceAtomic:'70',selectedResidualAtomic:'0',feeBackingRequirementAtomic:'200'});
  assert.deepEqual(result.operations[4],{operationId:reserved.operationId,state:'reserved',depositAtomic:'1500',outstandingUserAtomic:'0',pendingPayoutAtomic:'1200',issuedDepositFeeTokenAtomic:'200',retainedReturnFeeAtomic:'100',selectedReserveAtomic:'500',accountedBackingAtomic:'2000',paidRecipientAtomic:'0',paidMinerFeeAtomic:'0',pendingMinerFeeAtomic:'25',chargedBridgeFeeAtomic:'180',chargedNetworkFeeAtomic:'120',feeCoverageVarianceAtomic:'120',selectedResidualAtomic:'500',feeBackingRequirementAtomic:'300'});
  assert.equal(result.totals.operationCount,5);assert.equal(result.totals.settledCount,1);
  for(const key of amounts)assert.equal(result.totals[key],result.operations.reduce((sum,row)=>sum+BigInt(row[key]),0n).toString());
});

test('keeps exact values above Number safe range and permits total sums above u64',()=>{
  const first=operation('credited'),second=operation('credited',1),limit='18446744073709551615';
  for(const row of [first,second]){row.deposit.amountAtomic=limit;row.credit.recipientAtomic='18446744073709551600';row.credit.bridgeFeeAtomic='10';row.credit.networkFeeAtomic='5';row.credit.issuedFeeTokenAtomic='15';}
  const result=reconcileEconomicOperations([first,second]);
  assert.equal(result.operations[0].depositAtomic,limit);assert.equal(result.totals.depositAtomic,'36893488147419103230');
});

test('rejects every independent stage identity and arithmetic join mutation',()=>{
  rejectExact(v=>v.credit.depositId=`monero:deposit:mainnet:${h(250)}`,'economic:credit:deposit-id');
  rejectExact(v=>v.operationId=`monero:deposit:mainnet:${h(250)}`,'economic:operation:id');
  rejectExact(v=>v.credit.txId=h(251),'economic:redemption:credit-join');
  rejectExact(v=>v.credit.issuedFeeTokenAtomic='121','economic:credit:issued-fee');
  rejectExact(v=>v.redemption.creditTxId=h(252),'economic:redemption:credit-join');
  rejectExact(v=>v.redemption.creditBoxId=h(253),'economic:redemption:credit-join');
  rejectExact(v=>v.redemption.amountAtomic='879','economic:redemption:amount');
  rejectExact(v=>v.withdrawal.redemptionTxId=h(254),'economic:withdrawal:redemption-join');
  rejectExact(v=>v.withdrawal.inputs[1].amountAtomic='999','economic:withdrawal:deposit-input');
  rejectExact(v=>v.withdrawal.recipientAtomic='801','economic:withdrawal:payout');
  rejectExact(v=>v.withdrawal.settlement.proposalId=h(255),'economic:settlement:join');
  rejectExact(v=>v.withdrawal.settlement.inputAtomic='1199','economic:settlement:binding');
  rejectExact(v=>v.withdrawal.settlement.changePublicKey=h(256),'economic:settlement:binding');
});

test('rejects each decisive credit, withdrawal and final-settlement arithmetic mutation',()=>{
  const creditCases=[
    [v=>v.deposit.amountAtomic='1001','economic:credit:conservation'],
    [v=>v.credit.recipientAtomic='881','economic:credit:conservation'],
    [v=>{v.credit.bridgeFeeAtomic='81';v.credit.issuedFeeTokenAtomic='121';},'economic:credit:conservation'],
    [v=>{v.credit.networkFeeAtomic='41';v.credit.issuedFeeTokenAtomic='121';},'economic:credit:conservation'],
  ];
  for(const [mutate,expected] of creditCases)rejectExact(mutate,expected,'credited');
  const reservedCases=[
    [v=>v.withdrawal.minerFeeAtomic='21','economic:withdrawal:conservation'],
    [v=>v.withdrawal.changeAtomic='381','economic:withdrawal:conservation'],
    [v=>v.withdrawal.inputs[0].amountAtomic='201','economic:withdrawal:conservation'],
  ];
  for(const [mutate,expected] of reservedCases)rejectExact(mutate,expected,'reserved');
  const finalCases=[
    [v=>v.withdrawal.settlement.recipientAtomic='801','economic:settlement:binding'],
    [v=>v.withdrawal.settlement.minerFeeAtomic='21','economic:settlement:binding'],
    [v=>v.withdrawal.settlement.changeAtomic='381','economic:settlement:binding'],
  ];
  for(const [mutate,expected] of finalCases)rejectExact(mutate,expected);
});

test('rejects coordinated final fee and change substitution that preserves the settlement input total',()=>{
  reject(v=>{v.withdrawal.settlement.minerFeeAtomic='21';v.withdrawal.settlement.changeAtomic='379';},/settlement:binding/);
});

test('rejects malformed schemas, accessors, noncanonical numerics and invalid stage order',()=>{
  reject(v=>delete v.assetId,'top-level missing field');
  reject(v=>v.deposit.extra=true,'nested extra field');
  reject(v=>Object.defineProperty(v.credit,'amount',{enumerable:true,get(){throw Error('must not invoke');}}),'accessor');
  reject(v=>v.deposit.amountAtomic='01000','leading zero');
  reject(v=>v.credit.recipientAtomic='+880','sign');
  reject(v=>v.credit.networkFeeAtomic='4e1','exponent');
  reject(v=>v.deposit.amountAtomic=1000,'unsafe numeric atomic');
  reject(v=>v.deposit.amountAtomic='18446744073709551616','u64 overflow');
  reject(v=>v.deposit.outputIndex=4294967296,'output index overflow');
  reject(v=>v.withdrawal.settlement=undefined,'missing settlement stage');
  reject(v=>v.redemption=null,'reservation without redemption');
  reject(v=>v.credit=null,'redemption without credit');
  reject(v=>v.withdrawal.settlement.rewardState='rewarded','unsupported reward state');
});

test('rejects duplicate claims, cross-wires, selected input reuse and change aliases',()=>{
  const left=operation('settled'),right=operation('settled',1);
  const cases=[
    [rows=>{rows[1].deposit.txId=rows[0].deposit.txId;rows[1].operationId=rows[0].operationId;rows[1].credit.depositId=rows[0].operationId;rows[1].withdrawal.inputs[1].txId=rows[0].deposit.txId;},/duplicate:operation/],
    [rows=>rows[1].deposit.publicKey=rows[0].deposit.publicKey,/duplicate:deposit-key/],
    [rows=>rows[1].credit.txId=rows[0].credit.txId,/duplicate:credit-tx/],
    [rows=>rows[1].credit.boxId=rows[0].credit.boxId,/duplicate:credit-box/],
    [rows=>rows[1].redemption.txId=rows[0].redemption.txId,/duplicate:redemption-tx/],
    [rows=>{rows[1].withdrawal.reservationId=rows[0].withdrawal.reservationId;rows[1].withdrawal.settlement.reservationId=rows[0].withdrawal.reservationId;},/duplicate:reservation/],
    [rows=>{rows[1].withdrawal.proposalId=rows[0].withdrawal.proposalId;rows[1].withdrawal.settlement.proposalId=rows[0].withdrawal.proposalId;},/duplicate:proposal/],
    [rows=>rows[1].withdrawal.settlement.txId=rows[0].withdrawal.settlement.txId,/duplicate:settlement-tx/],
    [rows=>rows[1].withdrawal.inputs[0]=clone(rows[0].withdrawal.inputs[0]),/duplicate:selected-input/],
    [rows=>{rows[1].withdrawal.changePublicKey=rows[0].withdrawal.changePublicKey;rows[1].withdrawal.settlement.changePublicKey=rows[0].withdrawal.changePublicKey;},/alias:change/],
    [rows=>rows[1].genesis=h(200),/operation:scope/],
    [rows=>rows[1].vaultSpend=rows[0].vaultSpend,/duplicate:vault-spend/],
    [rows=>rows[1].assetId=h(201),/operation:scope/],
  ];
  for(const [mutate,expected] of cases){const rows=[clone(left),clone(right)];mutate(rows);assert.throws(()=>reconcileEconomicOperations(rows),expected);}
});

test('rejects each identity field when its canonical identity shape is malformed',()=>{
  const bad='A'.repeat(64),cases=[
    [v=>v.operationId='not-a-deposit-id',/operation:id/],[v=>v.genesis=bad,/operation:genesis/],[v=>v.vaultSpend=bad,/operation:vault-spend/],[v=>v.assetId=bad,/operation:asset/],
    [v=>v.deposit.txId=bad,/deposit:tx/],[v=>v.deposit.publicKey=bad,/deposit:key/],
    [v=>v.credit.txId=bad,/credit:tx/],[v=>v.credit.boxId=bad,/credit:box/],[v=>v.credit.depositId='not-a-deposit-id',/credit:deposit-id/],
    [v=>v.redemption.txId=bad,/redemption:tx/],[v=>v.redemption.creditTxId=bad,/redemption:credit-join/],[v=>v.redemption.creditBoxId=bad,/redemption:credit-join/],
    [v=>v.withdrawal.reservationId=bad,/withdrawal:reservation/],[v=>v.withdrawal.proposalId=bad,/withdrawal:proposal/],[v=>v.withdrawal.redemptionTxId=bad,/withdrawal:redemption-join/],
    [v=>v.withdrawal.inputs[0].txId=bad,/input:0:tx/],[v=>v.withdrawal.inputs[0].publicKey=bad,/input:0:key/],[v=>v.withdrawal.inputs[1].txId=bad,/input:1:tx/],[v=>v.withdrawal.inputs[1].publicKey=bad,/input:1:key/],[v=>v.withdrawal.changePublicKey=bad,/withdrawal:change-key/],
    [v=>v.withdrawal.settlement.txId=bad,/settlement:tx/],[v=>v.withdrawal.settlement.proposalId=bad,/settlement:join/],[v=>v.withdrawal.settlement.reservationId=bad,/settlement:join/],[v=>v.withdrawal.settlement.changePublicKey=bad,/settlement:change-key/],
  ];
  for(const [mutate,expected] of cases)reject(mutate,expected);
});

test('rejects each atomic amount and output index outside its canonical bounded representation',()=>{
  const cases=[
    [v=>v.deposit.amountAtomic='01',/deposit:amount:decimal/],[v=>v.credit.recipientAtomic='01',/credit:recipient:decimal/],[v=>v.credit.bridgeFeeAtomic='01',/credit:bridge-fee:decimal/],[v=>v.credit.networkFeeAtomic='01',/credit:network-fee:decimal/],[v=>v.credit.issuedFeeTokenAtomic='01',/credit:issued-fee:decimal/],
    [v=>v.redemption.amountAtomic='01',/redemption:amount:decimal/],[v=>v.redemption.bridgeFeeAtomic='01',/redemption:bridge-fee:decimal/],[v=>v.redemption.networkFeeAtomic='01',/redemption:network-fee:decimal/],
    [v=>v.withdrawal.inputs[0].amountAtomic='01',/input:0:amount:decimal/],[v=>v.withdrawal.inputs[1].amountAtomic='01',/input:1:amount:decimal/],[v=>v.withdrawal.recipientAtomic='01',/withdrawal:recipient:decimal/],[v=>v.withdrawal.minerFeeAtomic='01',/withdrawal:miner-fee:decimal/],[v=>v.withdrawal.changeAtomic='01',/withdrawal:change:decimal/],
    [v=>v.withdrawal.settlement.inputAtomic='01',/settlement:input:decimal/],[v=>v.withdrawal.settlement.recipientAtomic='01',/settlement:recipient:decimal/],[v=>v.withdrawal.settlement.minerFeeAtomic='01',/settlement:miner-fee:decimal/],[v=>v.withdrawal.settlement.changeAtomic='01',/settlement:change:decimal/],
    [v=>v.deposit.outputIndex=-1,/deposit:index/],[v=>v.withdrawal.inputs[0].outputIndex=-1,/input:0:index/],[v=>v.withdrawal.inputs[1].outputIndex=-1,/input:1:index/],
  ];
  for(const [mutate,expected] of cases)reject(mutate,expected);
  reject(v=>v.deposit.amountAtomic='123456789012345678901',/deposit:amount:decimal/);
  reject(v=>v.deposit.amountAtomic=1000,/deposit:amount:decimal/);
});

test('rejects closed-shape violations without invoking accessors and rejects malformed arrays',()=>{
  const shapeCases=[
    [v=>v.extra=true,/operation:schema/],[v=>v.deposit.extra=true,/deposit:schema/],[v=>v.credit.extra=true,/credit:schema/],[v=>v.redemption.extra=true,/redemption:schema/],[v=>v.withdrawal.extra=true,/withdrawal:schema/],[v=>v.withdrawal.inputs[0].extra=true,/input:0:schema/],[v=>v.withdrawal.settlement.extra=true,/settlement:schema/],[v=>v.credit[Symbol('extra')]=true,/credit:schema/],[v=>v.withdrawal.inputs.extra=true,/withdrawal:inputs:array-schema/],
  ];
  for(const [mutate,expected] of shapeCases)reject(mutate,expected);
  let calls=0;reject(v=>Object.defineProperty(v.credit,'recipientAtomic',{enumerable:true,get(){calls++;return '880';}}),/credit:property/);assert.equal(calls,0);
  reject(v=>v.withdrawal.inputs=[],/withdrawal:inputs:array/);
  assert.throws(()=>reconcileEconomicOperations({}),/operations:array/);
});

test('rejects a selected-input sum above u64 and aliases against a later credited deposit',()=>{
  const value=operation('reserved'),max='18446744073709551615';value.deposit.amountAtomic=max;value.credit.recipientAtomic=max;value.credit.bridgeFeeAtomic='0';value.credit.networkFeeAtomic='0';value.credit.issuedFeeTokenAtomic='0';value.redemption.amountAtomic=max;value.redemption.bridgeFeeAtomic='0';value.redemption.networkFeeAtomic='0';value.withdrawal.inputs[0].amountAtomic=max;value.withdrawal.inputs[1].amountAtomic=max;value.withdrawal.recipientAtomic=max;value.withdrawal.minerFeeAtomic='0';value.withdrawal.changeAtomic='0';
  assert.throws(()=>reconcileEconomicOperations([value]),/withdrawal:input-range/);
  const settled=operation('settled'),credited=operation('credited',1);settled.withdrawal.inputs[0].publicKey=credited.deposit.publicKey;
  assert.throws(()=>reconcileEconomicOperations([settled,credited]),/alias:reserve-deposit/);
  const changed=operation('settled'),later=operation('credited',1);changed.withdrawal.changePublicKey=later.deposit.publicKey;changed.withdrawal.settlement.changePublicKey=later.deposit.publicKey;
  assert.throws(()=>reconcileEconomicOperations([changed,later]),/alias:change-deposit/);
});

test('rejects settlement and redemption transaction IDs that alias cross-role creators',()=>{
  const ownDeposit=operation('settled');ownDeposit.withdrawal.settlement.txId=ownDeposit.deposit.txId;
  assert.throws(()=>reconcileEconomicOperations([ownDeposit]),/alias:settlement-source/);
  const ownReserve=operation('settled');ownReserve.withdrawal.settlement.txId=ownReserve.withdrawal.inputs[0].txId;
  assert.throws(()=>reconcileEconomicOperations([ownReserve]),/alias:settlement-source/);
  const earlyFinal=operation('settled'),laterDeposit=operation('credited',1);earlyFinal.withdrawal.settlement.txId=laterDeposit.deposit.txId;
  assert.throws(()=>reconcileEconomicOperations([earlyFinal,laterDeposit]),/alias:settlement-source/);
  const firstFinal=operation('settled'),otherReserve=operation('reserved',1);firstFinal.withdrawal.settlement.txId=otherReserve.withdrawal.inputs[0].txId;
  assert.throws(()=>reconcileEconomicOperations([firstFinal,otherReserve]),/alias:settlement-source/);
  const ownCredit=operation('settled');ownCredit.redemption.txId=ownCredit.credit.txId;ownCredit.withdrawal.redemptionTxId=ownCredit.credit.txId;
  assert.throws(()=>reconcileEconomicOperations([ownCredit]),/alias:redemption-credit/);
  const firstRedemption=operation('settled'),otherCredit=operation('credited',1);firstRedemption.redemption.txId=otherCredit.credit.txId;firstRedemption.withdrawal.redemptionTxId=otherCredit.credit.txId;
  assert.throws(()=>reconcileEconomicOperations([firstRedemption,otherCredit]),/alias:redemption-credit/);
});

test('shows a negative residual rather than masking a valid arithmetic deficit',()=>{
  const value=operation('settled');value.withdrawal.inputs[0].amountAtomic='10';value.withdrawal.changeAtomic='190';value.withdrawal.settlement.inputAtomic='1010';value.withdrawal.settlement.changeAtomic='190';
  const result=reconcileEconomicOperations([value]);
  assert.equal(result.operations[0].selectedReserveAtomic,'10');assert.equal(result.operations[0].selectedResidualAtomic,'-10');
});
