const fields=['txId','txBytes','outputKey','outputIndex','amountAtomic','feeAtomic'];
function exact(value,names){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==names.length||
    names.some(name=>!Object.hasOwn(value,name)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,name),'value')))throw Error('Prepared deposit schema');
}
function capture(frame){
  exact(frame,['type','id','genesis','vaultAddress','deposit']);exact(frame.deposit,fields);
  const d=frame.deposit;
  if(frame.type!=='deposit-prepared'||frame.id!==1||!/^[0-9a-f]{64}$/.test(frame.genesis)||typeof frame.vaultAddress!=='string'||!frame.vaultAddress||
    !['txId','outputKey'].every(k=>typeof d[k]==='string'&&/^[0-9a-f]{64}$/.test(d[k]))||
    typeof d.txBytes!=='string'||!/^(?:[0-9a-f]{2}){1,9408}$/.test(d.txBytes)||
    !Number.isInteger(d.outputIndex)||d.outputIndex<0||d.outputIndex>1||
    !['amountAtomic','feeAtomic'].every(k=>typeof d[k]==='string'&&/^[1-9][0-9]{0,19}$/.test(d[k])&&BigInt(d[k])<=0xffffffffffffffffn))throw Error('Prepared deposit profile');
  return Object.freeze({...frame,deposit:Object.freeze({...d})});
}

/** Fixture orchestration only; registration as a live vault remains with its issuer. */
export async function fundPreparedDeposit(actor,directory,groupKey,beforeSubmit){
  if(typeof beforeSubmit!=='function'||typeof groupKey!=='string'||!/^[0-9a-f]{64}$/.test(groupKey))throw Error('Prepared deposit callback');
  await actor.send({type:'prepare-deposit',runtimeDirectory:directory});
  const prepared=capture(await actor.next(180000,'deposit-preparation'));
  await beforeSubmit(Object.freeze({vault:Object.freeze({groupKey,genesis:prepared.genesis,vaultAddress:prepared.vaultAddress}),deposit:prepared.deposit}));
  await actor.send({type:'submit-deposit',txId:prepared.deposit.txId});
  const funded=await actor.next(180000,'deposit-submission');
  if(funded?.type!=='funded'||funded.id!==1||funded.genesis!==prepared.genesis||funded.vaultAddress!==prepared.vaultAddress||funded.source?.kind!=='deposit'||
    fields.some(field=>funded.source.deposit?.[field]!==prepared.deposit[field]))throw Error('Prepared deposit changed');
  return funded;
}
