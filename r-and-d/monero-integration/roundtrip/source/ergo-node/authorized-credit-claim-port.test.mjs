import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('openAuthorizedCredit rejects a caller-supplied claim reader before source access',
  {skip:!process.env.ROUNDTRIP_CONFIG},async()=>{
    const {openAuthorizedCredit}=await import('./authorized-credit.mjs');
    const directory=mkdtempSync(join(tmpdir(),'monero-credit-claim-port-'));
    let lookedUp=false;
    await assert.rejects(openAuthorizedCredit({directory,freshAdmission:{readers:[],candidate:{}},
      readClaim:()=>{lookedUp=true;return {status:'assigned'};}}),/Credit claim override forbidden/);
    assert.equal(lookedUp,false);
  });
