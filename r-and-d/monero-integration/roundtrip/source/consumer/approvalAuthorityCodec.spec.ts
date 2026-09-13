import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blake2b } from 'blakejs';
import { bindVerifiedAgreement, captureAuthority, decodeApprovalDescriptor, nativeCandidateIdentity, ownData, type PrivateCandidateSemantics } from './approvalAuthority';
import type { VerifiedAgreementSnapshot } from '../guard-service/src/agreement/txAgreement';

const rawProfile = () => ({ epoch: '1', publicKeys: [1, 2, 3, 4].map(v => '02' + String(v).repeat(64)), requiredSign: 3, nativeParticipants: [1, 2, 3, 4], nativeThreshold: 2, nativeSelected: [1, 2] });
const profile = captureAuthority(rawProfile());
const bytes = Buffer.alloc(204, 0); Buffer.from('44'.repeat(32), 'hex').copy(bytes, 7);
const s: PrivateCandidateSemantics = { bytes, recipient: 'synthetic-testnet-receiver', payment: 17n, input: 27n, change: 5n, fee: 5n, ceiling: 9n, count: 2, spend: '55'.repeat(32), view: '66'.repeat(32) };
function descriptorRows() { return ['WMAD1', '11'.repeat(32), '22'.repeat(32), '33'.repeat(32), '77'.repeat(32), '44'.repeat(32), nativeCandidateIdentity(s), '2', '1,2,3,4', '1,2', ...[1, 2, 3, 4].map(v => `${v}:${String(v).repeat(64)}`), s.spend]; }
const encode = (rows: string[]) => Buffer.from(rows.join('\n') + '\n', 'ascii').toString('hex');
test('authority capture is immutable and distinguishes Rosen Q3 from native threshold2', () => {
  const raw = rawProfile(), captured = captureAuthority(raw); raw.publicKeys[0] = raw.publicKeys[1];
  assert.notEqual(captured.publicKeys[0], raw.publicKeys[0]); assert.equal(captured.requiredSign, 3); assert.equal(captured.nativeThreshold, 2);
  assert.ok(Object.isFrozen(captured)); assert.ok(Object.isFrozen(captured.publicKeys));
});
test('authority setup rejects accessors without evaluating them and sparse arrays', () => {
  let calls = 0; const raw = rawProfile(); Object.defineProperty(raw, 'epoch', { enumerable: true, get() { calls++; return '1'; } });
  assert.throws(() => captureAuthority(raw)); assert.equal(calls, 0);
  const sparse = rawProfile(); delete (sparse.nativeParticipants as (number | undefined)[])[1]; assert.throws(() => captureAuthority(sparse));
  assert.throws(() => ownData(Object.create({ database: 'inherited' })));
  assert.throws(() => captureAuthority(new Proxy(rawProfile(), {})));
  const proxied = rawProfile(); proxied.publicKeys = new Proxy(proxied.publicKeys, {}); assert.throws(() => captureAuthority(proxied));
});
test('owned descriptor binds all five contexts, exact roster and original group key', () => {
  const decoded = decodeApprovalDescriptor(encode(descriptorRows()), s, profile);
  assert.equal(decoded.modelContext[4], bytes.subarray(7, 39).toString('hex'));
  assert.equal(decoded.candidateIdentity, nativeCandidateIdentity(s)); assert.equal(decoded.groupKey, s.spend);
  assert.ok(Object.isFrozen(decoded)); assert.ok(Object.isFrozen(decoded.originalShares));
});
for (const [name, index, value] of [
  ['network model', 1, '12'.repeat(32)], ['owner', 5, '88'.repeat(32)], ['identity', 6, '99'.repeat(32)],
  ['threshold', 7, '3'], ['roster order', 8, '2,1,3,4'], ['selected', 9, '1,3'], ['share participant', 10, `2:${'1'.repeat(64)}`], ['group', 14, '77'.repeat(32)],
] as const) test(`descriptor refuses changed ${name}`, () => { const rows = descriptorRows(); rows[index] = value; assert.throws(() => decodeApprovalDescriptor(encode(rows), s, profile)); });
test('descriptor identity binds private native intent semantics', () => {
  for (const mutated of [{ ...s, payment: 18n }, { ...s, recipient: s.recipient + 'x' }, { ...s, fee: 6n }, { ...s, count: 1 }, { ...s, view: '77'.repeat(32) }]) assert.throws(() => decodeApprovalDescriptor(encode(descriptorRows()), mutated, profile));
  assert.throws(() => decodeApprovalDescriptor(encode(descriptorRows()) + '0a', s, profile));
});
const originalEvent = { height: '100', sourceChainHeight: '90', WIDsCount: '1', amount: '27', toAddress: s.recipient };
const fees = { bridgeFee: '1', networkFee: '2', rsnRatio: '0', rsnRatioDivisor: '100', feeRatio: '0', feeRatioDivisor: '10000' };
const canonicalRequest = JSON.stringify({ eventId: 'aa'.repeat(32), source: { event: originalEvent, triggerTransactionId: 'bb'.repeat(32), triggerBoxId: 'cc'.repeat(32), wids: ['01'.repeat(32)] }, profile: { epoch: '1', fees } });
const json = '{"synthetic":"codec-only"}', id = 'dd'.repeat(32);
function observed(): VerifiedAgreementSnapshot {
  return { certificate: { txJson: json, txId: id, txDataHash: Buffer.from(blake2b(json, undefined, 32)).toString('hex'), publicKeys: profile.publicKeys, requiredSign: 3, protocolVersion: '1.0.0', timestamp: 1, signatures: [] }, provenance: { event: { ...originalEvent, height: 100, sourceChainHeight: 90, WIDsCount: 1 }, eventId: 'aa'.repeat(32), triggerTransactionId: 'bb'.repeat(32), triggerBoxId: 'cc'.repeat(32), wids: ['01'.repeat(32)], feeConfig: Object.fromEntries(Object.entries(fees).map(([k, v]) => [k, BigInt(v)])), txJson: json, activeTransactionIds: [id], eventStatus: 'pending-payment' } } as unknown as VerifiedAgreementSnapshot;
}
test('provenance numeric normalization is limited to observed event integers and fee bigints', () => {
  assert.equal(bindVerifiedAgreement(observed(), canonicalRequest, json, id, profile), observed().certificate.txDataHash);
});
for (const field of ['event', 'triggerTransactionId', 'triggerBoxId', 'wids', 'feeConfig', 'activeTransactionIds', 'txJson'] as const) test(`same event ID cannot hide changed ${field}`, () => {
  const v = observed(); const p = v.provenance as unknown as Record<string, unknown>;
  if (field === 'event') p.event = { ...p.event as object, amount: '28' };
  else if (field === 'feeConfig') p.feeConfig = { ...p.feeConfig as object, networkFee: 3n };
  else if (field === 'wids' || field === 'activeTransactionIds') p[field] = ['ee'.repeat(32)];
  else p[field] = 'ee'.repeat(32);
  assert.throws(() => bindVerifiedAgreement(v, canonicalRequest, json, id, profile));
});
test('certificate binding refuses committee, quorum and candidate substitution', () => {
  for (const change of [{ requiredSign: 2 }, { publicKeys: [...profile.publicKeys].reverse() }, { txId: 'ee'.repeat(32) }, { txDataHash: 'ee'.repeat(32) }, { txJson: json + ' ' }, { protocolVersion: 'other' }]) {
    const v = observed(); (v as { certificate: object }).certificate = { ...v.certificate, ...change }; assert.throws(() => bindVerifiedAgreement(v, canonicalRequest, json, id, profile));
  }
});
