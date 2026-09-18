import assert from 'node:assert/strict';
import {lstatSync} from 'node:fs';
import {MoneroCreditAssignment,committeeConfigDigest} from '../guard-service/src/db/moneroCreditAssignment.mjs';

/** Operator-bound local view of the actual guard custody, never a second ledger.
 * All four stores must be readable. Atomic guard assignment still decides races.
 * Watermarks detect observed regressions, not rollback of every retained store. */
export function openWatcherCreditView({entries,committeeKeys,remember}){
  entries=structuredClone(entries);committeeKeys=[...committeeKeys];
  assert.equal(entries.length,4);assert.equal(new Set(committeeKeys).size,4);
  assert.equal(new Set(entries.map(e=>e.file)).size,4,'Distinct credit custody required');
  assert.equal(typeof remember,'function');
  const readers=[];
  try{
    const common=committeeConfigDigest(entries[0].configuration);
    for(const [index,entry]of entries.entries()){
      assert.equal(entry.configuration.guardKey,committeeKeys[index],'Watcher credit roster');
      assert.deepEqual(entry.configuration.committeeKeys,committeeKeys,'Watcher credit committee');
      assert.equal(committeeConfigDigest(entry.configuration),common,'Watcher credit configuration');
      const reader=MoneroCreditAssignment.openReadOnly(entry.file,entry.configuration);readers.push(reader);
      // Check identity before trusting even a well-formed empty replacement.
      const {dev,ino}=lstatSync(entry.file);
      assert.deepEqual({dev,ino},entry.identity,'Watcher credit custody replaced');
    }
  }catch(error){readers.forEach(r=>r.close());throw error;}
  return {assertNew(backing){
    const rows=readers.map((reader,index)=>{
      const result=reader.inspectNovelty({sourceNetwork:'mainnet',backing});
      assert.deepEqual(result.identity,entries[index].identity,'Watcher credit custody replaced');
      return {guardKey:committeeKeys[index],...result};
    });
    remember(rows.map(({guardKey,identity,checkpoint})=>({guardKey,identity,checkpoint})));
    assert(rows.every(row=>row.status==='new'),'Watcher backing already claimed');
  },close(){readers.forEach(reader=>reader.close());}};
}
