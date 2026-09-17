import {createHash} from 'node:crypto';

const registered=new WeakMap();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=label=>{throw Error('source:'+label);};
const requireValue=(condition,label)=>{if(!condition)fail(label);};
function fields(value,expected,label){
  requireValue(value && Object.getPrototypeOf(value)===Object.prototype,label+':object');
  requireValue(Reflect.ownKeys(value).length===expected.length,label+':schema');
  for(const key of expected){const d=Object.getOwnPropertyDescriptor(value,key);requireValue(d?.enumerable && Object.hasOwn(d,'value'),label+':schema');}
}
function dataEntries(value){
  const keys=Reflect.ownKeys(value);
  requireValue(keys.every(key=>typeof key==='string'),'data:symbol');
  return keys.sort().map(key=>{const d=Object.getOwnPropertyDescriptor(value,key);requireValue(d?.enumerable && Object.hasOwn(d,'value'),'data:property');return [key,d.value];});
}
/** Typed, bounded capture: objects, bigint, numbers and bytes cannot alias each other. */
function canonicalData(value){
  const active=new Set();let count=0;
  function visit(item,depth){
    requireValue(++count<=50000 && depth<=24,'data:bound');
    if(item===null)return ['null'];
    if(typeof item==='string')return ['string',item];
    if(typeof item==='boolean')return ['boolean',item];
    if(typeof item==='bigint')return ['bigint',item.toString()];
    if(typeof item==='number'){requireValue(Number.isSafeInteger(item) && !Object.is(item,-0),'data:number');return ['number',item];}
    requireValue(item && typeof item==='object' && !active.has(item),'data:value');active.add(item);
    try{
      if(item instanceof Uint8Array){
        requireValue((Object.getPrototypeOf(item)===Uint8Array.prototype || Buffer.isBuffer(item)) && item.buffer instanceof ArrayBuffer && item.byteLength<=1000000,'data:bytes');
        const entries=dataEntries(item);requireValue(entries.length===item.length && entries.every(([key])=>/^(0|[1-9][0-9]*)$/.test(key) && Number(key)<item.length),'data:bytes-properties');
        return ['bytes',Buffer.from(item).toString('hex')];
      }
      if(Array.isArray(item)){
        requireValue(Object.getPrototypeOf(item)===Array.prototype && item.length<=50000 && Reflect.ownKeys(item).length===item.length+1,'data:array');
        const rows=[];for(let i=0;i<item.length;i++){const d=Object.getOwnPropertyDescriptor(item,String(i));requireValue(d?.enumerable && Object.hasOwn(d,'value'),'data:array-property');rows.push(visit(d.value,depth+1));}return ['array',rows];
      }
      requireValue(Object.getPrototypeOf(item)===Object.prototype,'data:prototype');
      return ['object',dataEntries(item).map(([key,v])=>[key,visit(v,depth+1)])];
    }finally{active.delete(item);}
  }
  const result=JSON.stringify(visit(value,0));requireValue(result.length<=2000000,'data:size');return result;
}
function captureData(source){
  fields(source,['context','request','providers','decision','observation','deposit','current','publicScan','proofRequest'],'handle');
  fields(source.providers,['proof','receipt','addresses'],'providers');
  const callbacks=[source.current],identities={};
  for(const [name,method] of [['proof','verify'],['receipt','reconstruct'],['addresses','verify']]){
    const provider=source.providers[name];fields(provider,['identity',method],'provider:'+name);
    fields(provider.identity,['kind','id','sourcePin'],'identity:'+name);callbacks.push(provider[method]);identities[name]=provider.identity;
  }
  requireValue(callbacks.every(callback=>typeof callback==='function'),'callbacks');
  const metadata=Object.fromEntries(['context','request','decision','observation','deposit','publicScan','proofRequest'].map(key=>[key,source[key]]));
  metadata.providerIdentities=identities;
  return {digest:hash(canonicalData(metadata)),callbacks};
}
const equal=(a,b,label)=>requireValue(a===b,'binding:'+label);
const hex32=(value,label)=>{requireValue(typeof value==='string' && /^[0-9a-f]{64}$/.test(value),'hex:'+label);return value;};
const text=(value,label)=>{requireValue(typeof value==='string' && value.length>0 && value.length<=256 && !/[\u0000-\u001f]/.test(value),'text:'+label);return value;};
const uint=(value,label,positive=false)=>{requireValue(typeof value==='string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value)<=18446744073709551615n && (!positive || value!=='0'),'uint:'+label);return value;};
const bigint=(value,label,positive=false)=>{requireValue(typeof value==='bigint','bigint:'+label);return uint(value.toString(),label,positive);};
const number=(value,label)=>{requireValue(Number.isSafeInteger(value) && value>=0,'number:'+label);return uint(String(value),label);};
const plainCanonical=value=>JSON.stringify(value,(_,item)=>item && Object.getPrototypeOf(item)===Object.prototype?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function backingFor(source,authority){
  fields(authority,['genesis','vaultSpend'],'authority');hex32(authority.genesis,'genesis');hex32(authority.vaultSpend,'vaultSpend');
  const {decision:a,deposit:d,observation:o,publicScan:p,context:c,request:r,proofRequest:q}=source,k=c.configuration,s=c.snapshot;
  fields(r,['intentBytes','proof','receiptEvidence'],'request');fields(r.receiptEvidence,['txid'],'receipt-evidence');
  fields(q,['txHex','txId','vaultAddress','messageHex','proof'],'proof-request');
  equal(a.status,'accepted','status');equal(a.authority,'stateless-candidate','authority');equal(a.evidenceMode,'independent','evidence-mode');
  equal(k.version,2,'version');equal(k.domain,'rosen-monero-deposit','domain');requireValue(['mainnet','testnet','stagenet'].includes(k.sourceNetwork),'network');
  requireValue(Array.isArray(a.outputs) && a.outputs.length===1,'one-output');const output=a.outputs[0];
  equal(p.genesis,authority.genesis,'genesis');equal(o.genesis,authority.genesis,'holder-genesis');equal(p.groupPublicKey,authority.vaultSpend,'vault-spend');
  equal(p.source.kind,'deposit','source-kind');equal(canonicalData(p.source.deposit),canonicalData(d),'public-deposit');
  equal(canonicalData(o.snapshot),canonicalData(p.snapshot),'holder-snapshot');equal(p.keyImage,o.keyImage,'holder-image');
  equal(o.sourcePolicy,p.sourcePolicy,'source-policy');requireValue(o.sourcePolicy===undefined || o.sourcePolicy==='authenticated-backing-v1','source-policy');
  equal(o.type,'source-verified','holder-type');requireValue(o.id===1 || o.id===2,'holder-id');equal(o.spentStatus,0,'holder-unspent');equal(o.walletSigns,0,'holder-signs');
  requireValue(Number.isSafeInteger(o.historyOccurrences) && o.historyOccurrences>=1 && o.historyOccurrences<=0xffffffff,'holder-occurrences');
  for(const name of ['txId','blockHash','blockHeight','outputKey','outputIndex','chainIndex','amountAtomic'])equal(o[name],d[name],'holder:'+name);
  const index=number(d.outputIndex,'outputIndex'),global=number(d.chainIndex,'globalIndex'),height=number(d.blockHeight,'blockHeight');
  hex32(d.txId,'txid');hex32(d.blockHash,'blockHash');hex32(d.outputKey,'publicKey');hex32(o.keyImage,'keyImage');
  uint(d.amountAtomic,'amount',true);uint(d.feeAtomic,'source-fee');requireValue(typeof d.txBytes==='string' && /^(?:[0-9a-f]{2})+$/.test(d.txBytes),'transaction-bytes');
  requireValue(Array.isArray(p.source.outputIds) && p.source.outputIds.filter(id=>id.transaction===d.txId && id.index===d.outputIndex && id.chainIndex===d.chainIndex).length===1,'source-output-locator');
  equal(a.txid,d.txId,'decision-txid');equal(a.blockHash,d.blockHash,'decision-block');equal(bigint(a.blockHeight,'decision-height'),height,'decision-height');
  equal(a.sourceNetwork,k.sourceNetwork,'source-network');equal(a.vaultEpoch,k.vaultEpoch,'vault-epoch');equal(a.vaultAddress,k.vaultAddress,'vault-address');
  equal(a.destinationNetwork,k.destinationNetwork,'destination-network');equal(a.destinationAsset,k.destinationAsset,'destination-asset');
  equal(a.snapshotId,s.id,'snapshot-id');equal(s.network,k.sourceNetwork,'snapshot-network');equal(s.txid,d.txId,'snapshot-txid');equal(s.blockHash,d.blockHash,'snapshot-block');equal(bigint(s.blockHeight,'snapshot-height'),height,'snapshot-height');
  equal(bigint(s.chainHeight,'chain-height'),number(p.snapshot.height,'public-height'),'public-height');equal(a.checkedAtHeight,s.chainHeight,'checked-height');
  equal(s.id,hash(authority.genesis+p.snapshot.hash),'snapshot-id-derivation');hex32(p.snapshot.hash,'snapshot-hash');
  bigint(s.minConfirmations,'confirmations',true);bigint(a.expiresAtHeight,'expiry');requireValue(s.chainHeight-s.blockHeight>=s.minConfirmations && a.expiresAtHeight>=s.chainHeight,'snapshot-age');
  equal(bigint(output.outputIndex,'decision-output-index'),index,'output-index');equal(output.publicKey,d.outputKey,'output-key');equal(bigint(output.amount,'output-amount',true),d.amountAtomic,'output-amount');
  equal(bigint(a.amount,'amount',true),d.amountAtomic,'amount');equal(a.depositId,`monero:deposit:${k.sourceNetwork}:${d.txId}`,'deposit-id');
  equal(output.locator,`${a.depositId}:${index}`,'locator');equal(output.economicId,`monero:output-key:${k.sourceNetwork}:${d.outputKey}`,'economic-id');
  equal(bigint(a.bridgeFee,'bridge-fee'),c.feePolicy.bridgeFee,'bridge-fee');equal(bigint(a.networkFee,'network-fee'),c.feePolicy.networkFee,'network-fee');
  equal(c.feePolicy.sourceDecimals,12,'source-decimals');equal(c.feePolicy.destinationDecimals,12,'destination-decimals');equal(c.feePolicy.remainder,'reject','remainder-policy');
  equal(a.netAmount,a.amount-a.bridgeFee-a.networkFee,'net-amount');equal(a.destinationAmount,a.netAmount,'credited-amount');equal(a.retainedAtomicRemainder,0n,'remainder');bigint(a.destinationAmount,'credited-amount',true);
  requireValue(r.intentBytes instanceof Uint8Array && r.intentBytes.length>0 && r.intentBytes.length<=4096,'intent-bytes');
  const intentHex=Buffer.from(r.intentBytes).toString('hex');equal(a.intentBytesHex,intentHex,'decision-intent-bytes');equal(a.intentHash,hash(r.intentBytes),'intent-hash');
  const expected={version:2,domain:k.domain,source_network:k.sourceNetwork,vault_epoch:k.vaultEpoch,vault_address:k.vaultAddress,destination_network:k.destinationNetwork,destination_asset:k.destinationAsset,bridge_fee:c.feePolicy.bridgeFee,network_fee:c.feePolicy.networkFee,txid:d.txId,to_address:a.recipient,amount:d.amountAtomic,expiry_height:a.expiresAtHeight.toString(),outputs:[{output_index:index,output_public_key:d.outputKey,amount:d.amountAtomic}]};
  equal(intentHex,Buffer.from(plainCanonical(expected)).toString('hex'),'intent-fields');
  requireValue(typeof r.proof==='string' && /^OutProofV2[1-9A-HJ-NP-Za-km-z]+$/.test(r.proof) && (r.proof.length-10)>=132 && (r.proof.length-10)<=65536 && (r.proof.length-10)%132===0,'proof-encoding');
  equal(r.receiptEvidence.txid,d.txId,'receipt-txid');equal(q.txHex,d.txBytes,'proof-txbytes');equal(q.txId,d.txId,'proof-txid');equal(q.vaultAddress,k.vaultAddress,'proof-vault');equal(q.messageHex,intentHex,'proof-message');equal(q.proof,r.proof,'proof');
  const refs=[];for(const name of ['proof','receipt','addresses']){const identity=source.providers[name].identity;equal(identity.kind,'independent','provider-kind');text(identity.id,'provider-id');requireValue(/^[0-9a-f]{40}$/.test(identity.sourcePin),'provider-pin');equal(identity.sourcePin,k.nativeSourcePin,'native-pin');refs.push(`independent:${identity.id}@${identity.sourcePin}`);}
  equal(canonicalData(a.verifierReferences),canonicalData(refs),'verifier-references');
  return Object.freeze({version:1,genesis:authority.genesis,vaultSpend:authority.vaultSpend,vaultAddress:text(a.vaultAddress,'vaultAddress'),intentHash:hex32(a.intentHash,'intentHash'),txid:d.txId,outputIndex:index,globalIndex:global,publicKey:d.outputKey,keyImage:o.keyImage,amountAtomic:d.amountAtomic,destinationNetwork:text(a.destinationNetwork,'destinationNetwork'),destinationAsset:hex32(a.destinationAsset,'destinationAsset'),recipient:text(a.recipient,'recipient'),creditedAtomic:a.destinationAmount.toString()});
}
function freezeData(value,seen=new Set()){
  if(!value || typeof value!=='object' || value instanceof Uint8Array || seen.has(value))return;
  seen.add(value);for(const d of Object.values(Object.getOwnPropertyDescriptors(value)))if(Object.hasOwn(d,'value'))freezeData(d.value,seen);Object.freeze(value);
}
/** Trusted producer registration after native holder/proof/admission verification.
 * This local identity registry does not cryptographically authenticate its caller. */
export function registerAuthenticatedDepositSource(source,authority){
  if(registered.has(source))fail('registered');
  const captured=captureData(source),backing=backingFor(source,authority);
  freezeData(source);registered.set(source,{...captured,backing});return source;
}
export function captureAuthenticatedDepositSource(source){
  const expected=registered.get(source);if(!expected)fail('unregistered');
  const current=()=>{
    try{const actual=captureData(source);requireValue(actual.digest===expected.digest && actual.callbacks.every((callback,index)=>callback===expected.callbacks[index]),'changed');}
    catch{fail('changed');}
  };
  current();return Object.freeze({backing:expected.backing,current});
}

/**
 * Commit the exact single-output backing and full deposit intent into Rosen's
 * existing origin field. This is a descriptor, not a sendable Monero address.
 * Callers must freshly verify the proof, source and unspent state first; this
 * function binds those results without granting chain-verification authority.
 */
export function moneroCreditOrigin(source, candidate) {
  const {backing}=captureAuthenticatedDepositSource(source);
  const semanticDecision=value=>{
    requireValue(value && Object.getPrototypeOf(value)===Object.prototype,'agreement:candidate');
    // Reader names legitimately differ. Every other field, including the exact
    // output list, intent, source policy and checked snapshot, must agree with
    // this source's verified decision. Reject extra or missing semantic fields.
    return Object.fromEntries(dataEntries(value).filter(([name])=>name!=='verifierReferences'));
  };
  requireValue(
    canonicalData(semanticDecision(candidate))===canonicalData(semanticDecision(source.decision)),
    'agreement:candidate',
  );
  // The shared preimage excludes local reader identities and snapshot handles.
  // Immutable backing includes genesis, vault, txid, both output indices, key,
  // associated image, amount, intent hash and the credited destination/amount.
  const preimage=canonicalData({
    domain:'rosen-monero-credit-origin',
    version:1,
    sourceNetwork:candidate.sourceNetwork,
    backing,
  });
  return 'rosen-monero-output:v1:'+hash(preimage);
}
