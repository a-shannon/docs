import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {config} from '../tools/config.mjs';
import {LocalMonero} from './localMonero';
import {runCeremony} from './participantHarness.mjs';
import {openRpcTimingProxy} from './rpcTiming.mjs';

const depositFields=['txId','txBytes','outputKey','outputIndex','amountAtomic','feeAtomic'];
type Fixture={node:LocalMonero;actor:any;prepared:any;submissions:()=>number;proof:Record<string,unknown>};
async function header(node:LocalMonero,height:number){
  const response=await node.rpc('get_block_header_by_height',{height});
  expect(response.status).toBe('OK');expect(response.block_header.height).toBe(height);
  expect(response.block_header.orphan_status).toBe(false);return response.block_header;
}
async function withPrepared(name:string,check:(fixture:Fixture)=>Promise<void>){
  const runtime=mkdtempSync(join(config.runtimeDirectory,`${name}-`));
  const priorPort=process.env.MONERO_LOCAL_RPC_PORT;
  let node:LocalMonero|undefined,proxy:any,ceremony:any,submissions=0;
  try{
    node=await LocalMonero.start(runtime);
    const originalGenesis=(await header(node,0)).hash;
    proxy=await openRpcTimingProxy({targetPort:node.port,maxEvents:16384,onEvent:(event:any)=>{
      if(event.method==='send_raw_transaction')submissions++;
    }});
    process.env.MONERO_LOCAL_RPC_PORT=String(proxy.port);
    ceremony=await runCeremony({binary:config.nativeBinary,sha256:config.nativeSha256,keepAlive:true});
    const actor=ceremony.actors[0];expect(actor.readySeen).toBe(1);expect(actor.closed).toBe(false);
    await actor.send({type:'prepare-deposit',runtimeDirectory:join(runtime,'donor')});
    const prepared=await actor.next(180000,'deposit-preparation');
    expect(Object.keys(prepared).sort()).toEqual(['deposit','genesis','id','type','vaultAddress']);
    expect(prepared.type).toBe('deposit-prepared');expect(prepared.id).toBe(1);
    expect(prepared.genesis).toBe(originalGenesis);
    expect(Object.keys(prepared.deposit).sort()).toEqual([...depositFields].sort());
    expect(prepared.deposit.txId).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.deposit.outputKey).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.deposit.txBytes).toMatch(/^(?:[0-9a-f]{2})+$/);
    expect(prepared.deposit.amountAtomic).toBe('500000240');
    expect(submissions).toBe(0);
    const absent=await node.transaction(prepared.deposit.txId);
    expect(absent.status).toBe('OK');expect(absent.missed_tx).toEqual([prepared.deposit.txId]);
    expect(absent.txs===undefined?[]:absent.txs).toEqual([]);
    const proof:Record<string,unknown>={case:name,genesis:originalGenesis,groupKey:ceremony.ready[0].groupKey,
      txId:prepared.deposit.txId,txBytesSha256:createHash('sha256').update(Buffer.from(prepared.deposit.txBytes,'hex')).digest('hex')};
    await check({node,actor,prepared,submissions:()=>submissions,proof});
    expect((await header(node,0)).hash).toBe(originalGenesis);
    await node.isolated();
    writeFileSync(join(runtime,'result.json'),JSON.stringify({...proof,submissions},null,2),{flag:'wx'});
  }finally{
    try{await ceremony?.close();}finally{
      try{await proxy?.close();}finally{
        if(priorPort===undefined)delete process.env.MONERO_LOCAL_RPC_PORT;else process.env.MONERO_LOCAL_RPC_PORT=priorPort;
        await node?.stop();
      }
    }
  }
}
async function retired(actor:any,exitCode:number,txId:string){
  await expect(actor.next(10000,'deposit-retirement')).rejects.toThrow(/Participant.*closed/);
  expect(actor.closed).toBe(true);expect(actor.child.exitCode).toBe(exitCode);expect(actor.queue).toEqual([]);
  await expect(actor.send({type:'submit-deposit',txId})).rejects.toThrow('Participant unavailable');
}

it('consumes a prepared deposit on a different well-formed transaction ID before submission',async()=>{
  await withPrepared('wrong-id',async({actor,prepared,submissions,proof})=>{
    const correct=prepared.deposit.txId,wrong=(correct[0]==='0'?'1':'0')+correct.slice(1);
    expect(wrong).toMatch(/^[0-9a-f]{64}$/);expect(wrong).not.toBe(correct);
    await actor.send({type:'submit-deposit',txId:wrong});await retired(actor,1,correct);
    expect(submissions()).toBe(0);proof.retired=true;
  });
});
for(const kind of ['configure','inspect-source'])it(`retires a pending actor on ${kind} before any submission`,async()=>{
  await withPrepared(kind,async({actor,prepared,submissions,proof})=>{
    // Preserve the valid pending request's exact field set and ID, changing only
    // its command. This reaches the pending kind predicate, not a schema error.
    const request={type:kind,txId:prepared.deposit.txId};
    expect(Object.keys(request).sort()).toEqual(['txId','type']);
    await actor.send(request);await retired(actor,1,prepared.deposit.txId);
    expect(submissions()).toBe(0);proof.retired=true;proof.singleChangedField='type';
  });
});
it('explicit stop retires a prepared actor without submitting its cached transaction',async()=>{
  await withPrepared('stop',async({actor,prepared,submissions,proof})=>{
    await actor.send({type:'stop'});await retired(actor,0,prepared.deposit.txId);expect(submissions()).toBe(0);proof.retired=true;
  });
});
it('allows canonical extension, preserves the prepared transaction and rejects a repeated submit',async()=>{
  await withPrepared('extension-replay',async({node,actor,prepared,submissions,proof})=>{
    const before=await node.isolated(),anchor=await header(node,before.height-1);
    await node.mine(1,prepared.vaultAddress);
    expect((await node.isolated()).height).toBe(before.height+1);
    expect((await header(node,before.height-1)).hash).toBe(anchor.hash);
    expect(submissions()).toBe(0);
    const request={type:'submit-deposit',txId:prepared.deposit.txId};
    await actor.send(request);const funded=await actor.next(180000,'deposit-submission');
    expect(funded.type).toBe('funded');expect(funded.id).toBe(1);
    expect(funded.genesis).toBe(prepared.genesis);expect(funded.vaultAddress).toBe(prepared.vaultAddress);
    expect(funded.source.kind).toBe('deposit');expect(funded.source.blockHashes).toHaveLength(18);
    expect(funded.source.ringIndices).toHaveLength(16);expect(funded.source.outputIds).toHaveLength(2);
    for(const field of depositFields)expect(funded.source.deposit[field]).toEqual(prepared.deposit[field]);
    const deposit=funded.source.deposit,row=(await node.transaction(deposit.txId)).txs[0];
    expect(row.in_pool).toBe(false);expect(row.as_hex).toBe(prepared.deposit.txBytes);
    expect(row.block_height).toBe(deposit.blockHeight);expect(row.output_indices[deposit.outputIndex]).toBe(deposit.chainIndex);
    expect((await header(node,deposit.blockHeight)).hash).toBe(deposit.blockHash);
    expect(submissions()).toBe(1);
    await actor.send(request);await retired(actor,1,prepared.deposit.txId);expect(submissions()).toBe(1);
    Object.assign(proof,{anchorHeight:before.height-1,anchorHash:anchor.hash,blockHeight:deposit.blockHeight,
      blockHash:deposit.blockHash,chainIndex:deposit.chainIndex,exactPayload:true,replayRetired:true});
  });
});
it('rejects replacement of the retained tip at unchanged genesis and height before submission',async()=>{
  await withPrepared('tip-replacement',async({node,actor,prepared,submissions,proof})=>{
    const before=await node.isolated(),anchor=await header(node,before.height-1),parent=await header(node,before.height-2);
    const removed=await node.call('/pop_blocks',{nblocks:1});expect(removed.status).toBe('OK');
    expect((await node.isolated()).height).toBe(before.height-1);
    // The retained tip was mined to the scalar-one donor. The original DKG
    // vault is distinct and yields a different miner output in its replacement.
    await node.mine(1,prepared.vaultAddress);
    const after=await node.isolated(),replacement=await header(node,after.height-1);
    expect(after.height).toBe(before.height);expect(replacement.hash).not.toBe(anchor.hash);
    expect((await header(node,before.height-2)).hash).toBe(parent.hash);
    expect((await header(node,0)).hash).toBe(prepared.genesis);expect(submissions()).toBe(0);
    await actor.send({type:'submit-deposit',txId:prepared.deposit.txId});await retired(actor,1,prepared.deposit.txId);
    expect(submissions()).toBe(0);
    Object.assign(proof,{heightBefore:before.height,heightAfter:after.height,anchorHash:anchor.hash,
      replacementHash:replacement.hash,parentUnchanged:true,genesisUnchanged:true,retired:true});
  });
});
