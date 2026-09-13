import EventOrder from '../guard-service/src/event/eventOrder';
import {captureUnapprovedMoneroPayoutRequest} from '../guard-service/src/withdrawal/moneroWithdrawalNativeProjection';
import {fixture,recipient} from './projectionFixture';
import {setFixtureChain} from './resolver';
it('executes actual EventOrder and recaptures the same atomic payout',async()=>{
  const called=vi.spyOn(EventOrder,'createEventPaymentOrder');
  const {request}=await fixture();const captured=await captureUnapprovedMoneroPayoutRequest(request);
  expect(called).toHaveBeenCalledTimes(2);expect(captured.amount).toBe('1000000000');
  expect(captured.address).toBe(recipient);expect(captured.network).toBe('testnet');
  expect(captured.ceiling).toBe('100000');expect(captured.request).toEqual(request);
  setFixtureChain(undefined);called.mockRestore();
});
