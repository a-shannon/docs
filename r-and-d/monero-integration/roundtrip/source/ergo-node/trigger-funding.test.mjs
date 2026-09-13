import test from 'node:test';
import assert from 'node:assert/strict';
import {selectTriggerFunding} from './deposit-credit.mjs';
const box=(id,script,erg,token,amount)=>({boxId:id,ergoTree:script,value:erg,assets:[{tokenId:token,amount}]});
test('selects actual funding proposition rather than another contract with RWT',()=>{
  const foreign=box('foreign','permit',10000000,'RWT',1000),owned=box('owned','wallet',10000000,'RWT',100);
  assert.equal(selectTriggerFunding([foreign,owned],'wallet','RWT',4100000n,10n),owned);
});
test('requires the exact token and sufficient amount',()=>{
  assert.equal(selectTriggerFunding([box('a','wallet',10000000,'OTHER',1000),box('b','wallet',10000000,'RWT',9)],'wallet','RWT',4100000n,10n),undefined);
});
test('requires fee and change headroom, accepting the exact lower boundary',()=>{
  const low=box('low','wallet',4099999,'RWT',1000),exact=box('exact','wallet',4100000,'RWT',10);
  assert.equal(selectTriggerFunding([low],'wallet','RWT',4100000n,10n),undefined);
  assert.equal(selectTriggerFunding([low,exact],'wallet','RWT',4100000n,10n),exact);
});
