import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { blake2b } from 'blakejs';
import { decimal, hex } from './codec';
import type { VerifiedAgreementSnapshot } from '../guard-service/src/agreement/txAgreement';

export interface WithdrawalAuthorityProfile {
  readonly epoch: string;
  readonly publicKeys: readonly string[];
  readonly requiredSign: number;
  readonly nativeParticipants: readonly number[];
  readonly nativeThreshold: number;
  readonly nativeSelected: readonly number[];
}
export interface ApprovedNativeSummary {
  readonly status: 'approved-retained-native';
  readonly requestDigest: string;
  readonly txDataHash: string;
  readonly descriptorDigest: string;
  readonly bindingDigest: string;
}
export function ownData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('authority:plain-data');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !d || !('value' in d) || !d.enumerable) throw Error('authority:own-data');
    result[key] = d.value;
  }
  return result;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 16) throw Error('authority:list');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) throw Error('authority:list-properties');
  const copy: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !('value' in d) || !d.enumerable) throw Error('authority:list-data');
    copy.push(d.value);
  }
  return copy;
}
export function captureAuthority(value: unknown): Readonly<WithdrawalAuthorityProfile> {
  const x = ownData(value);
  const keys = ['epoch', 'publicKeys', 'requiredSign', 'nativeParticipants', 'nativeThreshold', 'nativeSelected'];
  if (Object.keys(x).length !== keys.length || keys.some(k => !Object.hasOwn(x, k))) throw Error('authority:profile-schema');
  const publicKeys = list(x.publicKeys), participants = list(x.nativeParticipants), selected = list(x.nativeSelected);
  if (typeof x.epoch !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(x.epoch) || publicKeys.length !== 4 || publicKeys.some(k => typeof k !== 'string' || !/^(?:[0-9a-f]{66}|[0-9a-f]{130})$/.test(k)) || new Set(publicKeys).size !== 4 || !Number.isSafeInteger(x.requiredSign) || (x.requiredSign as number) < 1 || (x.requiredSign as number) > 4 || x.nativeThreshold !== 2 || participants.join(',') !== '1,2,3,4' || participants.some(k => typeof k !== 'number') || selected.join(',') !== '1,2' || selected.some(k => typeof k !== 'number')) throw Error('authority:profile');
  return Object.freeze({ epoch: x.epoch, publicKeys: Object.freeze(publicKeys as string[]), requiredSign: x.requiredSign as number, nativeParticipants: Object.freeze(participants as number[]), nativeThreshold: 2, nativeSelected: Object.freeze(selected as number[]) });
}
export interface PrivateCandidateSemantics {
  readonly bytes: Buffer;
  readonly recipient: string;
  readonly payment: bigint;
  readonly input: bigint;
  readonly change: bigint;
  readonly fee: bigint;
  readonly ceiling: bigint;
  readonly count: number;
  readonly spend: string;
  readonly view: string;
}
export function nativeCandidateIdentity(s: PrivateCandidateSemantics): string {
  const address = Buffer.from(s.recipient, 'utf8'), length = Buffer.alloc(4), amounts = Buffer.alloc(48);
  length.writeUInt32LE(address.length);
  [s.payment, s.input, s.change, s.fee, s.ceiling, BigInt(s.count)].forEach((v, i) => amounts.writeBigUInt64LE(decimal(v.toString()), i * 8));
  return createHash('sha256').update('W1h/private-issued-candidate/v1\0', 'utf8').update(s.bytes).update('W1h/private-native-semantics/v1\0', 'utf8').update(length).update(address).update(amounts).update(hex(s.spend, 32, 32)).update(hex(s.view, 32, 32)).digest('hex');
}
export interface NativeApprovalDescriptor {
  readonly bytesHex: string;
  readonly digest: string;
  readonly modelContext: readonly string[];
  readonly candidateIdentity: string;
  readonly threshold: number;
  readonly participants: readonly number[];
  readonly selected: readonly number[];
  readonly originalShares: readonly Readonly<{ participant: number; share: string }>[];
  readonly groupKey: string;
}
function ids(value: string): number[] {
  if (!/^[1-9][0-9]*(?:,[1-9][0-9]*)*$/.test(value)) throw Error('authority:descriptor-ids');
  const result = value.split(',').map(Number);
  if (result.length > 16 || result.some((v, i) => !Number.isSafeInteger(v) || (i > 0 && v <= result[i - 1]))) throw Error('authority:descriptor-ids');
  return result;
}
export function decodeApprovalDescriptor(value: string, s: PrivateCandidateSemantics, profile: Readonly<WithdrawalAuthorityProfile>, expectedGenesis = '11'.repeat(32)): Readonly<NativeApprovalDescriptor> {
  hex(expectedGenesis, 32, 32);
  const bytes = hex(value, 4096);
  if (bytes.some(b => b !== 10 && (b < 33 || b > 126)) || bytes.at(-1) !== 10) throw Error('authority:descriptor-ascii');
  const rows = bytes.toString('ascii').slice(0, -1).split('\n');
  if (rows.some(r => !r) || rows[0] !== 'WMAD1' || rows.length < 12) throw Error('authority:descriptor-schema');
  const context = rows.slice(1, 6); context.forEach(v => hex(v, 32, 32)); hex(rows[6], 32, 32);
  const threshold = Number(decimal(rows[7])), participants = ids(rows[8]), selected = ids(rows[9]);
  if (rows.length !== 11 + participants.length || threshold !== profile.nativeThreshold || participants.join(',') !== profile.nativeParticipants.join(',') || selected.join(',') !== profile.nativeSelected.join(',') || context[0] !== expectedGenesis || context[4] !== s.bytes.subarray(7, 39).toString('hex') || rows[6] !== nativeCandidateIdentity(s)) throw Error('authority:descriptor-binding');
  const shares = participants.map((participant, i) => {
    const parts = rows[10 + i].split(':');
    if (parts.length !== 2 || parts[0] !== participant.toString()) throw Error('authority:descriptor-share');
    hex(parts[1], 32, 32); return Object.freeze({ participant, share: parts[1] });
  });
  const groupKey = rows.at(-1)!; hex(groupKey, 32, 32);
  if (groupKey !== s.spend) throw Error('authority:descriptor-group');
  return Object.freeze({ bytesHex: value, digest: createHash('sha256').update('W1hd/native-approval-descriptor/v1\0', 'utf8').update(bytes).digest('hex'), modelContext: Object.freeze(context), candidateIdentity: rows[6], threshold, participants: Object.freeze(participants), selected: Object.freeze(selected), originalShares: Object.freeze(shares), groupKey });
}
function equalObject(a: Record<string, unknown>, b: Record<string, unknown>) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length || keys.some(k => !Object.hasOwn(b, k) || a[k] !== b[k])) throw Error('authority:provenance');
}
/** Compares immutable observations; no DB reread and no authorization mint. */
export function bindVerifiedAgreement(verified: Readonly<VerifiedAgreementSnapshot>, canonicalRequest: string, json: string, id: string, profile: Readonly<WithdrawalAuthorityProfile>) {
  const original = JSON.parse(canonicalRequest) as Record<string, unknown>;
  const source = ownData(original.source), originalProfile = ownData(original.profile), originalEvent = ownData(source.event), observed = ownData(verified.provenance.event);
  for (const k of ['height', 'sourceChainHeight', 'WIDsCount']) {
    if (typeof observed[k] !== 'number' || !Number.isSafeInteger(observed[k]) || (observed[k] as number) < 0) throw Error('authority:provenance-number');
    observed[k] = String(observed[k]);
  }
  equalObject(originalEvent, observed);
  if (source.triggerTransactionId !== verified.provenance.triggerTransactionId || source.triggerBoxId !== verified.provenance.triggerBoxId || JSON.stringify(source.wids) !== JSON.stringify(verified.provenance.wids) || originalProfile.epoch !== profile.epoch || verified.provenance.txJson !== json || verified.provenance.eventId !== original.eventId || verified.provenance.activeTransactionIds.some(v => v !== id)) throw Error('authority:provenance');
  const fees = ownData(originalProfile.fees), observedFees = ownData(verified.provenance.feeConfig);
  for (const key of Object.keys(observedFees)) {
    if (typeof observedFees[key] !== 'bigint') throw Error('authority:provenance-fee');
    observedFees[key] = String(observedFees[key]);
  }
  equalObject(fees, observedFees);
  const c = verified.certificate, txDataHash = Buffer.from(blake2b(json, undefined, 32)).toString('hex');
  if (c.txJson !== json || c.txId !== id || c.txDataHash !== txDataHash || c.requiredSign !== profile.requiredSign || JSON.stringify(c.publicKeys) !== JSON.stringify(profile.publicKeys) || c.protocolVersion !== '1.0.0') throw Error('authority:certificate-binding');
  return txDataHash;
}
