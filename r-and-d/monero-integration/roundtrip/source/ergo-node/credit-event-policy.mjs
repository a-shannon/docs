import assert from 'node:assert/strict';

/** Compare the decoded trigger with the guard's independently verified source event. */
export function verifyCreditEvent(event,expected){
  assert(event,'Trigger event');
  for(const key of ['sourceTxId','fromChain','toChain','fromAddress','toAddress','amount','bridgeFee','networkFee','sourceChainTokenId','targetChainTokenId','sourceBlockId']){
    assert.equal(event[key],expected[key],'Trigger '+key);
  }
  assert.equal(event.sourceChainHeight,expected.height,'Trigger sourceChainHeight');
  assert.equal(event.eventId,expected.requestId,'Trigger eventId');
  assert.equal(event.WIDsCount,2,'Trigger WIDsCount');
}
