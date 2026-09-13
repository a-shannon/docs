import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {config} from '../tools/config.mjs';
const run=promisify(execFile);

/** Separate fakechain-only fixture; its input contains no source signing material. */
export async function injectPublicCopy({node,vault,deposit,mode}){
  assert(['raw','decodable'].includes(mode));
  assert(isAbsolute(config.collisionBinary)&&/^[0-9a-f]{64}$/.test(config.collisionSha256));
  assert.equal(createHash('sha256').update(readFileSync(config.collisionBinary)).digest('hex'),config.collisionSha256);
  await node.isolated();const directory=mkdtempSync(join(config.runtimeDirectory,'public-copy-')),input=join(directory,'input.json');
  writeFileSync(input,JSON.stringify({mode,txHex:deposit.txBytes,txid:deposit.txId,vaultSpend:vault.groupKey,outputIndex:deposit.outputIndex,port:node.port}),{flag:'wx'});
  const {stdout}=await run(config.collisionBinary,['copy-existing',input],{windowsHide:true,timeout:180000,maxBuffer:65536,encoding:'utf8'});
  const result=JSON.parse(stdout);assert.equal(result.operation,'copy-existing-public-deposit');assert.equal(result.mode,mode);
  assert.equal(result.genesis,vault.genesis);assert.equal(result.honestTx,deposit.txId);assert.equal(result.outputKey,deposit.outputKey);
  assert.equal(result.honestOutputIndex,deposit.outputIndex);assert.equal(result.honestChainIndex,deposit.chainIndex);
  assert.equal(result.honestDecodedAtomic,deposit.amountAtomic);assert.equal(result.rawOccurrences,2);
  assert.equal(result.copyDecodedOutputs,mode==='raw'?0:1);assert.equal(result.copySubmission.status,'OK');
  if(mode==='decodable')assert.equal(result.copyDecodedAtomic,deposit.amountAtomic);
  const current=await node.isolated(),copy=await node.transaction(result.copyTx),block=await node.rpc('get_block',{height:result.copyHeight});
  assert.equal(current.height,result.finalHeight);assert.equal(copy.txs.length,1);assert.equal(copy.txs[0].in_pool,false);
  assert.equal(copy.txs[0].block_height,result.copyHeight);assert.equal(block.block_header.hash,result.copyBlockHash);assert(block.tx_hashes.includes(result.copyTx));
  assert.equal((await node.rpc('get_block_header_by_height',{height:0})).block_header.hash,vault.genesis);
  writeFileSync(join(directory,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});return result;
}
