import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {retainCreditRecord} from './credit-recovery.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const id=(value,label)=>assert(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),label);
const assignmentDigest=assignment=>hash(canonicalAssignment(assignment));
const filename=(database,txId)=>{assert(path.isAbsolute(database),'Reward signed custody database path');id(txId,'Reward signed transaction ID');
  const stat=fs.lstatSync(database);assert(stat.isFile()&&!stat.isSymbolicLink(),'Reward signed custody database');return `${database}.reward-${txId}.signed.json`;};
const evidence=record=>Object.freeze(Object.fromEntries(['assignmentDigest','signedDigest','signedHex','snapshotDigest','txId'].map(key=>[key,record[key]])));

/** Publish a same-volume retained file without ever replacing existing custody. */
export function publishCreateOnlyRecord(pending,file,body,cap=4_000_000){
  assert(path.isAbsolute(pending)&&path.isAbsolute(file)&&path.dirname(pending)===path.dirname(file),'Reward create-only record path');
  assert(Number.isSafeInteger(cap)&&cap>0&&cap<=8_000_000,'Reward create-only record cap');const expected=Buffer.from(body);
  assert(expected.length>0&&expected.length<=cap,'Reward create-only record size');
  let status='published';
  try{fs.linkSync(pending,file);}catch(error){
    if(error?.code!=='EEXIST')throw error;status='existing';const stat=fs.lstatSync(file);
    assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===expected.length,'Reward create-only existing file');
    assert.deepEqual(fs.readFileSync(file),expected,'Reward create-only existing conflict');
  }
  fs.unlinkSync(pending);const stat=fs.lstatSync(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===expected.length,'Reward create-only published file');
  assert.deepEqual(fs.readFileSync(file),expected,'Reward create-only published bytes');return status;
}

function recordBytes({custodyDigest,assignment,snapshotDigest,txId,signedHex}){
  id(custodyDigest,'Reward signed custody digest');id(snapshotDigest,'Reward signed snapshot digest');id(txId,'Reward signed transaction ID');
  assert.equal(assignment?.binding?.creditTransactionDigest,snapshotDigest,'Reward signed assignment snapshot');
  assert.equal(assignment?.rewardTransactionId,txId,'Reward signed assignment transaction');
  assert(typeof signedHex==='string'&&/^(?:[0-9a-f]{2})+$/.test(signedHex)&&signedHex.length<=2_000_000,'Reward signed bytes');
  const record={version:1,domain:'rosen-monero-reward-signed-custody-v1',custodyDigest,assignmentDigest:assignmentDigest(assignment),
    snapshotDigest,txId,signedDigest:hash(Buffer.from(signedHex,'hex')),signedHex};
  return {record,text:JSON.stringify(record)};
}
function readExact(file){const stat=fs.lstatSync(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=2_100_000,'Reward signed record file');
  const text=fs.readFileSync(file,'utf8');assert.equal(Buffer.byteLength(text),stat.size,'Reward signed record drift');return text;}
function checkedRecord(text,expected){const value=JSON.parse(text);assert(value&&Object.keys(value).sort().join(',')==='assignmentDigest,custodyDigest,domain,signedDigest,signedHex,snapshotDigest,txId,version','Reward signed record schema');
  assert.equal(value.version,1);assert.equal(value.domain,'rosen-monero-reward-signed-custody-v1');
  const created=recordBytes({...expected,signedHex:value.signedHex});assert.equal(created.text,text,'Reward signed record conflict');return Object.freeze(value);}

/** Retain public final transaction bytes only; no signing shares, nonces or private transcript. */
export function retainRewardSigned({database,custodyDigest,assignment,snapshotDigest,txId,signedHex}){
  const file=filename(database,txId),created=recordBytes({custodyDigest,assignment,snapshotDigest,txId,signedHex});
  if(fs.existsSync(file)){assert.equal(readExact(file),created.text,'Reward signed retained conflict');return Object.freeze({status:'existing',record:Object.freeze(created.record)});}
  const pending=`${file}.pending-${randomUUID()}`;retainCreditRecord(pending,created.text);
  const status=publishCreateOnlyRecord(pending,file,created.text,2_100_000);assert.equal(readExact(file),created.text,'Reward signed retained publish');
  return Object.freeze({status:status==='published'?'retained':'existing',record:Object.freeze(created.record)});
}
export function observeRewardSigned({database,custodyDigest,assignment}){
  const txId=assignment?.rewardTransactionId;id(txId,'Reward signed transaction ID');const file=filename(database,txId);
  if(!fs.existsSync(file))return undefined;
  return checkedRecord(readExact(file),{custodyDigest,assignment,snapshotDigest:assignment.binding.creditTransactionDigest,txId});
}

/** Assignments require unanimity; a signed recovery result requires the signing quorum. */
export function aggregateRewardStates(rows,quorum=3){
  assert(Array.isArray(rows)&&rows.length===4&&Number.isSafeInteger(quorum)&&quorum===3,'Reward signed committee shape');
  assert(rows.every(row=>row&&['assigned','unassigned'].includes(row.status)),'Reward signed committee state');
  assert.equal(new Set(rows.map(row=>row.status)).size,1,'Guard reward status disagreement');
  if(rows[0].status==='unassigned'){assert(rows.every(row=>row.signed===undefined),'Unassigned guard retained signed reward');return Object.freeze({status:'unassigned'});}
  const assignments=rows.map(row=>canonicalAssignment(row.assignment));assert.equal(new Set(assignments).size,1,'Guard reward assignment disagreement');
  const groups=new Map();
  for(const row of rows){if(row.signed===undefined)continue;const item=evidence(row.signed);
    assert.equal(item.assignmentDigest,assignmentDigest(row.assignment),'Guard signed reward assignment');
    assert.equal(item.snapshotDigest,row.assignment.binding.creditTransactionDigest,'Guard signed reward snapshot');
    assert.equal(item.txId,row.assignment.rewardTransactionId,'Guard signed reward transaction');
    id(item.signedDigest,'Guard signed reward digest');assert(typeof item.signedHex==='string'&&/^(?:[0-9a-f]{2})+$/.test(item.signedHex)&&item.signedHex.length<=2_000_000,'Guard signed reward encoding');
    assert.equal(hash(Buffer.from(item.signedHex,'hex')),item.signedDigest,'Guard signed reward bytes');
    const key=canonicalAssignment(item),group=groups.get(key)??{count:0,item};group.count++;groups.set(key,group);}
  const recovered=[...groups.values()].filter(group=>group.count>=quorum);assert(recovered.length<=1,'Guard signed reward quorum disagreement');
  return Object.freeze({status:'assigned',assignment:structuredClone(rows[0].assignment),...(recovered.length?{signed:recovered[0].item}:{})});
}
