import assert from 'node:assert/strict';

/** Returns funding requests; the composition owns minting, signing and submission. */
export function watcherSetupRequests({deployment,watchers,wasm}){
  assert.equal(watchers.length,2);assert.equal(new Set(watchers.map(w=>w.WID)).size,2);
  const t=deployment.tokens,c=deployment.contracts;
  const registers=values=>wasm.Constant.from_i64_str_array(values.map(String)).encode_to_base16();
  const requests=[
    {address:deployment.fundingAddress,value:10000000,assets:[{tokenId:t.RepoConfigNFT,amount:1}],registers:{R4:registers([10,0,1,1])}},
    {address:deployment.fundingAddress,value:10000000,assets:[{tokenId:t.RWTRepoNFT,amount:1},{tokenId:t.RWT,amount:100}],registers:{R4:registers([0]),R5:wasm.Constant.from_i64(wasm.I64.from_str('2')).encode_to_base16()}}
  ];
  for(const watcher of watchers){
    assert.match(watcher.WID,/^[0-9a-f]{64}$/);assert(watcher.address);
    requests.push({address:c.Permit.address,value:1000000,assets:[{tokenId:t.RWT,amount:100}],registers:{R4:wasm.Constant.from_byte_array(Buffer.from(watcher.WID,'hex')).encode_to_base16(),R5:wasm.Constant.from_coll_coll_byte([Buffer.from('00','hex')]).encode_to_base16()}},
      {address:watcher.address,value:20000000,assets:[{tokenId:watcher.WID,amount:1}]},
      {address:watcher.address,value:10000000,assets:[]});
  }
  return {requests,requiredRWTCount:'10',requiredCommitments:2,repoConfiguration:['10','0','1','1'],watcherCount:2};
}
