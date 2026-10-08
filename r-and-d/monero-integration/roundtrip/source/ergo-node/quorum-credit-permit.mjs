import assert from 'node:assert/strict';
import {canonicalAssignment} from '../guard-service/src/db/moneroCreditAssignment.mjs';

const all=[0,1,2,3];
function key(snapshot,indices){
  assert(snapshot&&/^[0-9a-f]{64}$/.test(snapshot.digest)&&/^[0-9a-f]{64}$/.test(snapshot.txId),'quorum credit snapshot');
  assert(Array.isArray(indices)&&indices.length===3&&new Set(indices).size===3&&
    indices.every(index=>all.includes(index)),'quorum credit indices');
  return canonicalAssignment({digest:snapshot.digest,txId:snapshot.txId,indices});
}

/** A one-use local coordination permit; the four Guard ledgers remain authoritative. */
export function createQuorumCreditPermit(){
  let held,authorizing=false,generation=0;
  return {
    get authorizing(){return authorizing;},
    clear(){held=undefined;generation++;},
    async authorize(request,snapshot,indices,readAll){
      assert(!authorizing,'quorum credit authorization in progress');
      const signKey=key(snapshot,indices);
      assert(request?.binding?.creditTransactionDigest===snapshot.digest,'quorum credit digest');
      assert.equal(typeof readAll,'function');
      const exact=structuredClone(request),omitted=all.find(index=>!indices.includes(index));
      this.clear();const started=generation;authorizing=true;
      try{
        await readAll(exact);
        assert.equal(generation,started,'quorum credit authorization cancelled');
        held={signKey,requestKey:canonicalAssignment(exact),omitted};
      }finally{authorizing=false;}
    },
    preserveOnlyForKill(index){if(held&&index!==held.omitted)this.clear();},
    consume(snapshot,indices){
      assert(!authorizing,'quorum credit authorization in progress');
      const signKey=key(snapshot,indices);
      assert(held,'quorum credit authorization missing');
      assert.equal(signKey,held.signKey,'quorum credit authorization mismatch');
      held=undefined;generation++;
    }
  };
}
