import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MoneroCreditAssignment,canonicalAssignment,assignmentConfigDigest} from '../guard-service/src/db/moneroCreditAssignment.mjs';

/** Pure V2 configuration derivation, shared by provisioning and fresh verification. */
export function freshCreditConfigurations({deployment:d,scope,genesis}){
  const policyDigest=createHash('sha256').update(canonicalAssignment({profile:'local-four-guard-backed-credit-v2',scope,genesis,
    guardBoxId:d.guard.boxId,tokens:d.tokens,contracts:Object.fromEntries(Object.entries(d.contracts).map(([name,c])=>[name,c.tree]))})).digest('hex');
  const custodyDomain='local-monero-genesis:'+genesis,activationId='ergo-guard:'+d.guard.boxId,backingPolicy='single-deposit-v2';
  return d.guardPublicKeys.map(guardKey=>({custodyDomain,guardKey,committeeKeys:[...d.guardPublicKeys],quorum:3,maxFaults:1,
    activationId,policyEpoch:'1',policyDigest,backingPolicy}));
}

/** Initial provisioning is explicit. A participant restart can only reopen retained custody. */
export function openGuardCustody({directory,index,configuration,contributionPackageSha256,create=false}){
  assert(path.isAbsolute(directory??''),'Absolute guard directory required');
  assert(Number.isInteger(index)&&index>=0&&index<4,'Guard custody index');
  assert.equal(typeof create,'boolean');assignmentConfigDigest(configuration);
  assert.equal(configuration.guardKey,configuration.committeeKeys[index],'Guard custody index binding');
  assert.match(contributionPackageSha256,/^[0-9a-f]{64}$/);
  const custody=path.join(directory,'custody'),manifest=path.join(custody,'bootstrap.json'),database=path.join(custody,'ledger.sqlite');
  const bootstrap=canonicalAssignment({version:1,index,configuration,contributionPackageSha256});
  let ledger;
  if(create){
    assert(!fs.existsSync(custody),'Guard custody already exists');
    fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(custody);
    const fd=fs.openSync(manifest,'wx');try{fs.writeFileSync(fd,bootstrap);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    ledger=MoneroCreditAssignment.create(database,configuration);
  }else{
    assert(fs.existsSync(custody),'Missing retained guard custody');
    const stat=fs.lstatSync(custody);assert(stat.isDirectory()&&!stat.isSymbolicLink(),'Guard custody directory');
    assert(fs.existsSync(manifest),'Missing retained guard bootstrap');
    assert(fs.existsSync(database),'Missing retained guard ledger');
    for(const file of [manifest,database]){const stat=fs.lstatSync(file);assert(stat.isFile()&&!stat.isSymbolicLink(),'Guard custody regular file');}
    assert.equal(fs.readFileSync(manifest,'utf8'),bootstrap,'Guard bootstrap drift');
    ledger=MoneroCreditAssignment.open(database,configuration);
  }
  return {ledger,bootstrap,manifest,database,custody};
}
