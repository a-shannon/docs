import assert from 'node:assert/strict';
import test from 'node:test';
import {createECDH} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MoneroCreditAssignment,committeeConfigDigest} from '../guard-service/src/db/moneroCreditAssignment.mjs';
import {freshCreditConfigurations} from './credit-custody.mjs';
import {assertExactCreditClaim,createInProcessClaimReader} from './fresh-credit-source.mjs';

const h=n=>n.toString(16).padStart(64,'0');
const keys=[1,2,3,4].map(n=>{const key=createECDH('secp256k1');key.setPrivateKey(Buffer.from(h(n),'hex'));
  return key.getPublicKey('hex','compressed');});
const deployment={guardPublicKeys:keys,guard:{boxId:h(20)},tokens:{Asset:h(7)},contracts:{Lock:{tree:'abcd'}}};
const scope=h(21),genesis=h(1),obligationId='monero:deposit:mainnet:'+h(4);
const freshAdmission={candidate:{scope},readers:[0,1,2,3].map(()=>({scope,genesis}))};

function request(config){return {binding:{obligationId,creditTransactionDigest:h(11),sourceIntentDigest:h(12),
  triggerBoxId:h(13),policyDigest:config.policyDigest,committeeDigest:committeeConfigDigest(config)},
  outputs:[{sourceNetwork:'mainnet',publicKey:h(14)}],backing:{version:2,genesis,committeeDigest:h(2),vaultSpend:h(3),
    vaultAddress:'configured-vault',intentHash:h(12),txId:h(4),blockHash:h(5),blockHeight:4097,
    outputIndex:1,globalIndex:5000,outputKey:h(14),keyImage:h(6),amountAtomic:'1000',
    destinationNetwork:'ergo-testnet',destinationAsset:h(7),recipient:'configured-recipient',creditedAtomic:'880'}};}

test('in-process V2 reads four separate retained SQLite claims without creating custody',()=>{
  const directory=mkdtempSync(join(tmpdir(),'monero-in-process-claims-')),
    configs=freshCreditConfigurations({deployment,scope,genesis}),read=createInProcessClaimReader({directory,deployment,freshAdmission});
  assert.deepEqual(read(obligationId,0),{status:'missing'});
  const guardDirectory=join(directory,'guards');mkdirSync(guardDirectory);
  writeFileSync(join(guardDirectory,'committee-bootstrap.json'),'configured committee');
  const ledgers=[];
  try{
    for(let i=0;i<3;i++)ledgers.push(MoneroCreditAssignment.create(join(guardDirectory,`guard-${i}.sqlite`),configs[i]));
    assert.throws(()=>read(obligationId,0),/incomplete/);
    ledgers.push(MoneroCreditAssignment.create(join(guardDirectory,'guard-3.sqlite'),configs[3]));
    const before=ledgers.map(ledger=>ledger.checkpoint());
    for(let i=0;i<4;i++)assert.deepEqual(read(obligationId,i),{status:'missing'});
    assert.deepEqual(ledgers.map(ledger=>ledger.checkpoint()),before,'lookups never assign');
    const assigned=request(configs[0]);
    for(let i=0;i<3;i++)assert.equal(ledgers[i].assign(assigned).status,'assigned');
    for(let i=0;i<3;i++)assert.deepEqual(read(obligationId,i),{status:'assigned',request:assigned});
    assert.deepEqual(read(obligationId,3),{status:'missing'},'fourth guard cannot borrow another claim');
    const exact=(index,assignment=assigned)=>assertExactCreditClaim({readClaim:read,index,
      decision:{status:'retained',depositId:obligationId},assignment});
    for(let i=0;i<3;i++)assert.doesNotThrow(()=>exact(i));
    assert.throws(()=>exact(3),/retained claim missing/);
    for(const field of ['creditTransactionDigest','triggerBoxId','policyDigest']){
      const changed=structuredClone(assigned);changed.binding[field]=h(99);
      assert.throws(()=>exact(0,changed),/retained claim mismatch/,field);
    }
    assert.equal(ledgers[2].invalidate(obligationId,'source-invalidated').status,'invalidated');
    assert.throws(()=>exact(2),/claim invalidated/);
    assert.throws(()=>createInProcessClaimReader({directory,deployment:{...deployment,guard:{boxId:h(99)}},freshAdmission})(obligationId,0),/config-drift/);
  }finally{ledgers.forEach(ledger=>ledger.close());}
  renameSync(join(guardDirectory,'guard-3.sqlite'),join(guardDirectory,'guard-3.missing'));
  assert.throws(()=>read(obligationId,0),/incomplete/,'a lost file after restart is never new custody');
});

test('in-process V2 refuses a missing custody directory after a candidate was retained',()=>{
  const directory=mkdtempSync(join(tmpdir(),'monero-in-process-missing-'));
  writeFileSync(join(directory,'candidate.json'),'retained candidate');
  const read=createInProcessClaimReader({directory,deployment,freshAdmission});
  assert.throws(()=>read(obligationId,0),/custody missing/);
});
