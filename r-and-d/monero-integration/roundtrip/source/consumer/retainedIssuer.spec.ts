import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbsolutePhaseDeadline, RetainedFramer, positive, retainedRequest, retainedReceipt } from './retainedCodec';
import type { CapturedMoneroPayout } from '../guard-service/src/withdrawal/moneroWithdrawalNativeProjection';

test('retained phase accepts chunked exact LF framing', () => {
  const f = new RetainedFramer(2, 20);
  assert.equal(f.push(Buffer.from('TAG\n')), undefined);
  assert.deepEqual(f.push(Buffer.from('value\n')), ['TAG', 'value']);
  assert.throws(() => f.push(Buffer.from('again\n')));
});
for (const [name, bytes] of [
  ['CR', 'TAG\r\nvalue\n'], ['space', 'TAG\nva lue\n'],
  ['empty', 'TAG\n\n'], ['trailing LF', 'TAG\nvalue\n\n'],
  ['trailing byte', 'TAG\nvalue\nx'], ['high bit', 'TAG\nvalué\n'],
] as const) {
  test(`retained phase rejects ${name}`, () => assert.throws(() => new RetainedFramer(2, 50).push(Buffer.from(bytes))));
}
test('phase bound applies before buffering', () => assert.throws(() => new RetainedFramer(2, 8).push(Buffer.from('TAG\nvalue\n'))));
test('positive canonical u64 rejects zero, alternate spelling, overflow', () => {
  assert.equal(positive('18446744073709551615'), '18446744073709551615');
  for (const value of ['0', '01', '+1', '18446744073709551616']) assert.throws(() => positive(value));
});
const p = { eventId: '1'.repeat(64), instructionDigest: '2'.repeat(64), requestDigest: '3'.repeat(64), network: 'testnet', address: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', amount: '17', ceiling: '9' } as CapturedMoneroPayout;
test('absolute phase deadline expires with no timer dispatch and cannot be reset', () => {
  let now = 7;
  const d = new AbsolutePhaseDeadline(() => now);
  d.start(); now = 180006; d.check(); now = 180007;
  assert.throws(() => d.check(), /phase-expired/);
  assert.throws(() => d.start(), /phase-expired/);
});
test('phase replacement starts at reception and held owner has no continuing phase lease', () => {
  let now = 0;
  const d = new AbsolutePhaseDeadline(() => now);
  d.start(); now = 5; d.start(); now = 180004; d.check(); now = 180005;
  assert.throws(() => d.check(), /phase-expired/);
  d.clear(); now = 10000000; assert.doesNotThrow(() => d.check());
});
test('nonfinite and backwards monotonic clocks cannot extend a phase', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => new AbsolutePhaseDeadline(() => value).start(), /monotonic-clock/);
  }
  let now = 10;
  const d = new AbsolutePhaseDeadline(() => now);
  d.start(); now = 11; d.check(); now = 10;
  assert.throws(() => d.check(), /monotonic-clock/);
  assert.throws(() => d.start(), /monotonic-clock/);
});
test('request and receipt codec binds every exact request field and count', () => {
  const request = retainedRequest(p, '4'.repeat(64));
  const rows = ['WMNR1', ...request.fields, '3', '2', 'unapproved-native-intent', 'prohibited'];
  const encode = (r: readonly string[]) => Buffer.from([...r, ''].join('\n'), 'ascii').toString('hex');
  assert.equal(retainedReceipt(encode(rows), p, request.fields, 2).necessaryFeeAtomic, '3');
  for (let i = 1; i <= 8; i++) {
    const changed = [...rows]; changed[i] = 'substitution';
    assert.throws(() => retainedReceipt(encode(changed), p, request.fields, 2));
  }
  assert.throws(() => retainedReceipt(encode(rows), p, request.fields, 1));
  const high = [...rows]; high[9] = '10';
  assert.throws(() => retainedReceipt(encode(high), p, request.fields, 2));
});
