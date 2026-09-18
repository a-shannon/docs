const U64_MAX=18446744073709551615n;
const amountKeys=['depositAtomic','outstandingUserAtomic','pendingPayoutAtomic','issuedDepositFeeTokenAtomic','issuedReturnFeeTokenAtomic','retainedReturnFeeAtomic','selectedReserveAtomic','accountedBackingAtomic','paidRecipientAtomic','paidMinerFeeAtomic','pendingMinerFeeAtomic','chargedBridgeFeeAtomic','chargedNetworkFeeAtomic','feeCoverageVarianceAtomic','selectedResidualAtomic','feeBackingRequirementAtomic'];
const hex=value=>typeof value==='string' && /^[0-9a-f]{64}$/.test(value);
const fail=label=>{throw Error(`economic:${label}`);};
const requireValue=(value,label)=>{if(!value)fail(label);};

function closed(value,keys,label){
  requireValue(value!==null && typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype,label+':object');
  const actual=Reflect.ownKeys(value);
  requireValue(actual.length===keys.length && actual.every(key=>typeof key==='string') && keys.every(key=>actual.includes(key)),label+':schema');
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);requireValue(descriptor?.enumerable===true && Object.hasOwn(descriptor,'value'),label+':property');}
  return value;
}
function array(value,label,min,max){
  requireValue(Array.isArray(value) && Object.getPrototypeOf(value)===Array.prototype && value.length>=min && value.length<=max,label+':array');
  const keys=Reflect.ownKeys(value);
  requireValue(keys.length===value.length+1 && keys.includes('length') && keys.every(key=>key==='length'||(/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<value.length)),label+':array-schema');
  for(let index=0;index<value.length;index++){const descriptor=Object.getOwnPropertyDescriptor(value,String(index));requireValue(descriptor?.enumerable===true&&Object.hasOwn(descriptor,'value'),label+':array-property');}
  return value;
}
function id(value,label){requireValue(hex(value),label);return value;}
function operationId(value,depositTx,label){
  requireValue(typeof value==='string' && value===`monero:deposit:mainnet:${depositTx}`,label);return value;
}
function atomic(value,label,positive=false){
  requireValue(typeof value==='string' && /^(0|[1-9][0-9]{0,19})$/.test(value),label+':decimal');
  const parsed=BigInt(value);requireValue(parsed<=U64_MAX&&(!positive||parsed>0n),label+':range');return parsed;
}
function outputIndex(value,label){requireValue(typeof value==='number'&&Number.isSafeInteger(value)&&!Object.is(value,-0)&&value>=0&&value<=0xffffffff,label);return value;}
function remember(values,value,label){requireValue(!values.has(value),label);values.add(value);}
function text(value){return value.toString();}

function validateDeposit(value){
  closed(value,['txId','outputIndex','publicKey','amountAtomic'],'deposit');
  return {txId:id(value.txId,'deposit:tx'),outputIndex:outputIndex(value.outputIndex,'deposit:index'),publicKey:id(value.publicKey,'deposit:key'),amount:atomic(value.amountAtomic,'deposit:amount',true)};
}
function validateCredit(value,deposit){
  if(value===null)return null;
  closed(value,['txId','boxId','depositId','recipientAtomic','bridgeFeeAtomic','networkFeeAtomic','issuedFeeTokenAtomic'],'credit');
  const credit={txId:id(value.txId,'credit:tx'),boxId:id(value.boxId,'credit:box'),recipient:atomic(value.recipientAtomic,'credit:recipient',true),bridgeFee:atomic(value.bridgeFeeAtomic,'credit:bridge-fee'),networkFee:atomic(value.networkFeeAtomic,'credit:network-fee'),issuedFee:atomic(value.issuedFeeTokenAtomic,'credit:issued-fee')};
  operationId(value.depositId,deposit.txId,'credit:deposit-id');
  requireValue(deposit.amount===credit.recipient+credit.bridgeFee+credit.networkFee,'credit:conservation');
  requireValue(credit.issuedFee===credit.bridgeFee+credit.networkFee,'credit:issued-fee');return credit;
}
function validateRedemption(value,credit){
  if(value===null)return null;
  requireValue(credit!==null,'redemption:credit');closed(value,['txId','creditTxId','creditBoxId','amountAtomic','bridgeFeeAtomic','networkFeeAtomic'],'redemption');
  const redemption={txId:id(value.txId,'redemption:tx'),amount:atomic(value.amountAtomic,'redemption:amount',true),bridgeFee:atomic(value.bridgeFeeAtomic,'redemption:bridge-fee'),networkFee:atomic(value.networkFeeAtomic,'redemption:network-fee')};
  requireValue(value.creditTxId===credit.txId&&value.creditBoxId===credit.boxId,'redemption:credit-join');requireValue(redemption.amount===credit.recipient,'redemption:amount');
  redemption.payout=redemption.amount-redemption.bridgeFee-redemption.networkFee;requireValue(redemption.payout>0n,'redemption:payout');return redemption;
}
function validateWithdrawal(value,deposit,redemption,assetId){
  if(value===null)return null;
  requireValue(redemption!==null,'withdrawal:redemption');closed(value,['reservationId','proposalId','redemptionTxId','inputs','recipientAtomic','minerFeeAtomic','changeAtomic','changePublicKey','settlement'],'withdrawal');
  const withdrawal={reservationId:id(value.reservationId,'withdrawal:reservation'),proposalId:id(value.proposalId,'withdrawal:proposal'),recipient:atomic(value.recipientAtomic,'withdrawal:recipient'),minerFee:atomic(value.minerFeeAtomic,'withdrawal:miner-fee'),change:atomic(value.changeAtomic,'withdrawal:change'),changePublicKey:id(value.changePublicKey,'withdrawal:change-key')};
  requireValue(value.redemptionTxId===redemption.txId,'withdrawal:redemption-join');array(value.inputs,'withdrawal:inputs',2,2);
  withdrawal.inputs=value.inputs.map((input,index)=>{closed(input,['txId','outputIndex','publicKey','amountAtomic'],`input:${index}`);return {txId:id(input.txId,`input:${index}:tx`),outputIndex:outputIndex(input.outputIndex,`input:${index}:index`),publicKey:id(input.publicKey,`input:${index}:key`),amount:atomic(input.amountAtomic,`input:${index}:amount`,true)};});
  const matched=withdrawal.inputs.filter(input=>input.txId===deposit.txId&&input.outputIndex===deposit.outputIndex&&input.publicKey===deposit.publicKey&&input.amount===deposit.amount);
  requireValue(matched.length===1,'withdrawal:deposit-input');withdrawal.reserve=withdrawal.inputs.find(input=>input!==matched[0]);
  requireValue(withdrawal.recipient===redemption.payout,'withdrawal:payout');withdrawal.input=withdrawal.inputs.reduce((sum,input)=>sum+input.amount,0n);requireValue(withdrawal.input<=U64_MAX,'withdrawal:input-range');requireValue(withdrawal.input===withdrawal.recipient+withdrawal.minerFee+withdrawal.change,'withdrawal:conservation');
  if(value.settlement===null){withdrawal.settlement=null;return withdrawal;}
  const rewarded=Object.getOwnPropertyDescriptor(value.settlement??{},'rewardState')?.value==='completed';
  closed(value.settlement,['txId','proposalId','reservationId','inputAtomic','recipientAtomic','minerFeeAtomic','changeAtomic','changePublicKey','rewardState',...(rewarded?['reward']:[])],'settlement');
  const settlement={txId:id(value.settlement.txId,'settlement:tx'),input:atomic(value.settlement.inputAtomic,'settlement:input'),recipient:atomic(value.settlement.recipientAtomic,'settlement:recipient'),minerFee:atomic(value.settlement.minerFeeAtomic,'settlement:miner-fee'),change:atomic(value.settlement.changeAtomic,'settlement:change'),changePublicKey:id(value.settlement.changePublicKey,'settlement:change-key')};
  requireValue(value.settlement.proposalId===withdrawal.proposalId&&value.settlement.reservationId===withdrawal.reservationId,'settlement:join');
  requireValue(settlement.input===withdrawal.input&&settlement.recipient===withdrawal.recipient&&settlement.minerFee===withdrawal.minerFee&&settlement.change===withdrawal.change&&settlement.changePublicKey===withdrawal.changePublicKey,'settlement:binding');
  requireValue(rewarded||value.settlement.rewardState==='pending-reward','settlement:reward-state');
  if(rewarded){
    const reward=closed(value.settlement.reward,['txId','paymentTxId','redemptionTxId','assetId','distributedFeeTokenAtomic'],'reward');
    id(reward.txId,'reward:tx');requireValue(reward.paymentTxId===settlement.txId&&reward.redemptionTxId===redemption.txId&&reward.assetId===assetId,'reward:join');
    const distributed=atomic(reward.distributedFeeTokenAtomic,'reward:distributed');
    requireValue(distributed===redemption.bridgeFee+redemption.networkFee,'reward:fees');
    settlement.reward={txId:reward.txId,distributed};
  }
  withdrawal.settlement=settlement;return withdrawal;
}

function rowFor(operation,deposit,credit,redemption,withdrawal){
  const settled=withdrawal?.settlement!==null&&withdrawal!==null;
  const state=settled?'settled':withdrawal?'reserved':redemption?'redeemed':credit?'credited':'deposited';
  const D=deposit.amount,U=credit?.recipient??0n,P=redemption?.payout??0n,fd=credit?.issuedFee??0n,fr=redemption?(redemption.bridgeFee+redemption.networkFee):0n,R=withdrawal?.reserve.amount??0n,C=withdrawal?.change??0n,F=withdrawal?.minerFee??0n;
  const issuedReturn=withdrawal?.settlement?.reward?.distributed??0n;
  const data={depositAtomic:D,outstandingUserAtomic:credit?(redemption?0n:U):D,pendingPayoutAtomic:redemption&&!settled?P:0n,issuedDepositFeeTokenAtomic:fd,issuedReturnFeeTokenAtomic:issuedReturn,retainedReturnFeeAtomic:fr-issuedReturn,selectedReserveAtomic:R,accountedBackingAtomic:settled?C:D+R,paidRecipientAtomic:settled?withdrawal.recipient:0n,paidMinerFeeAtomic:settled?F:0n,pendingMinerFeeAtomic:withdrawal&&!settled?F:0n,chargedBridgeFeeAtomic:(credit?.bridgeFee??0n)+(redemption?.bridgeFee??0n),chargedNetworkFeeAtomic:(credit?.networkFee??0n)+(redemption?.networkFee??0n),feeCoverageVarianceAtomic:((credit?.networkFee??0n)+(redemption?.networkFee??0n))-(settled?F:0n),feeBackingRequirementAtomic:fd+fr};
  data.selectedResidualAtomic=data.accountedBackingAtomic-data.outstandingUserAtomic-data.pendingPayoutAtomic-data.feeBackingRequirementAtomic;
  return {operationId:operation.operationId,state,...Object.fromEntries(amountKeys.map(key=>[key,text(data[key])]))};
}

/** Reconciles bounded, producer-authenticated credit, redemption and settlement facts only. */
export function reconcileEconomicOperations(operations){
  array(operations,'operations',1,64);
  const seen={operationIds:new Set(),vaultSpends:new Set(),deposits:new Set(),depositKeys:new Set(),creditTx:new Set(),creditBox:new Set(),redemptionTx:new Set(),reservation:new Set(),proposal:new Set(),finalTx:new Set(),inputs:new Set(),inputKeys:new Set(),inputTxOuts:new Set(),changes:new Set()};
  const rows=[],deposits=[],reserves=[],changes=[],credits=[],redemptions=[],settlements=[],selectedInputs=[],rewards=new Set();let sharedGenesis=null,sharedAsset=null;
  for(const operation of operations){
    closed(operation,['operationId','genesis','vaultSpend','assetId','deposit','credit','redemption','withdrawal'],'operation');
    const deposit=validateDeposit(operation.deposit);operationId(operation.operationId,deposit.txId,'operation:id');const genesis=id(operation.genesis,'operation:genesis'),vaultSpend=id(operation.vaultSpend,'operation:vault-spend'),asset=id(operation.assetId,'operation:asset');
    if(sharedGenesis===null){sharedGenesis=genesis;sharedAsset=asset;}else requireValue(genesis===sharedGenesis&&asset===sharedAsset,'operation:scope');
    remember(seen.operationIds,operation.operationId,'duplicate:operation');remember(seen.vaultSpends,`${genesis}:${vaultSpend}`,'duplicate:vault-spend');remember(seen.deposits,`${deposit.txId}:${deposit.outputIndex}`,'duplicate:deposit');remember(seen.depositKeys,deposit.publicKey,'duplicate:deposit-key');deposits.push({operationId:operation.operationId,txId:deposit.txId,outputIndex:deposit.outputIndex,publicKey:deposit.publicKey});
    const credit=validateCredit(operation.credit,deposit);if(credit){remember(seen.creditTx,credit.txId,'duplicate:credit-tx');remember(seen.creditBox,credit.boxId,'duplicate:credit-box');credits.push(credit.txId);}
    const redemption=validateRedemption(operation.redemption,credit);if(redemption){remember(seen.redemptionTx,redemption.txId,'duplicate:redemption-tx');redemptions.push(redemption.txId);}
    const withdrawal=validateWithdrawal(operation.withdrawal,deposit,redemption,asset);
    if(withdrawal){
      remember(seen.reservation,withdrawal.reservationId,'duplicate:reservation');remember(seen.proposal,withdrawal.proposalId,'duplicate:proposal');
      const localInputs=new Set();for(const input of withdrawal.inputs){const source=`${genesis}:${input.txId}:${input.outputIndex}:${input.publicKey}`,txOut=`${genesis}:${input.txId}:${input.outputIndex}`;requireValue(!localInputs.has(source),'withdrawal:duplicate-input');localInputs.add(source);remember(seen.inputs,source,'duplicate:selected-input');remember(seen.inputKeys,input.publicKey,'duplicate:selected-input-key');remember(seen.inputTxOuts,txOut,'duplicate:selected-input-occurrence');requireValue(!seen.changes.has(input.publicKey),'alias:input-change');selectedInputs.push(input);}
      requireValue(!seen.changes.has(withdrawal.changePublicKey)&&!seen.inputKeys.has(withdrawal.changePublicKey),'alias:change');remember(seen.changes,withdrawal.changePublicKey,'duplicate:change');
      reserves.push({operationId:operation.operationId,...withdrawal.reserve});changes.push({operationId:operation.operationId,publicKey:withdrawal.changePublicKey});
      if(withdrawal.settlement){remember(seen.finalTx,withdrawal.settlement.txId,'duplicate:settlement-tx');settlements.push(withdrawal.settlement.txId);}
      if(withdrawal.settlement?.reward)remember(rewards,withdrawal.settlement.reward.txId,'duplicate:reward-tx');
    }
    rows.push(rowFor(operation,deposit,credit,redemption,withdrawal));
  }
  for(const reserve of reserves)for(const deposit of deposits)if(reserve.operationId!==deposit.operationId&&(reserve.publicKey===deposit.publicKey||(reserve.txId===deposit.txId&&reserve.outputIndex===deposit.outputIndex)))fail('alias:reserve-deposit');
  for(const change of changes)for(const deposit of deposits)if(change.operationId!==deposit.operationId&&change.publicKey===deposit.publicKey)fail('alias:change-deposit');
  for(const txId of settlements)if(deposits.some(deposit=>deposit.txId===txId)||selectedInputs.some(input=>input.txId===txId))fail('alias:settlement-source');
  for(const txId of redemptions)if(credits.includes(txId))fail('alias:redemption-credit');
  for(const txId of rewards)if(credits.includes(txId)||redemptions.includes(txId))fail('alias:reward-source');
  const totals=Object.fromEntries(amountKeys.map(key=>[key,rows.reduce((sum,row)=>sum+BigInt(row[key]),0n).toString()]));
  return {scope:'selected-input-reconciliation-v1',operations:rows,totals:{...totals,operationCount:rows.length,settledCount:rows.filter(row=>row.state==='settled').length}};
}
