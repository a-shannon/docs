import { createHash } from 'node:crypto';
import type { CapturedMoneroPayout } from '../guard-service/src/withdrawal/moneroWithdrawalNativeProjection';
import { canonicalUint, publicHex, validateConstructionReceipt } from '../guard-service/src/withdrawal/moneroWithdrawalSelection';
import { hex } from './codec';

/** Absolute local phase time; checking never relies on timer dispatch. */
export class AbsolutePhaseDeadline {
  #until: number | undefined;
  #last = -Infinity;
  constructor(private readonly now: () => number) {}
  private read() {
    const value = this.now();
    if (!Number.isFinite(value) || value < this.#last) throw Error('retained:monotonic-clock');
    this.#last = value;
    return value;
  }
  start() {
    this.check();
    const until = this.read() + 180000;
    if (!Number.isFinite(until)) throw Error('retained:monotonic-clock');
    this.#until = until;
  }
  check() {
    if (this.#until !== undefined && this.read() >= this.#until) throw Error('retained:phase-expired');
  }
  clear() { this.#until = undefined; }
}

export class RetainedFramer {
  #chunks: Buffer[] = [];
  #size = 0;
  #lines = 0;
  #done = false;
  constructor(private readonly lines: number, private readonly limit: number) {}
  push(raw: Buffer): string[] | undefined {
    if (this.#done || !raw.length || this.#size + raw.length > this.limit) throw Error('retained:phase-data');
    for (const byte of raw) {
      if (byte === 10) this.#lines++;
      else if (byte < 33 || byte > 126) throw Error('retained:ascii');
    }
    this.#chunks.push(Buffer.from(raw)); this.#size += raw.length;
    if (this.#lines > this.lines) throw Error('retained:trailing');
    if (this.#lines !== this.lines) return;
    if (raw[raw.length - 1] !== 10) throw Error('retained:trailing');
    this.#done = true;
    const rows = Buffer.concat(this.#chunks).toString('ascii').slice(0, -1).split('\n');
    this.#chunks = [];
    if (rows.some(row => !row.length)) throw Error('retained:empty');
    return rows;
  }
}

export function positive(value: string): string {
  if (canonicalUint(value, 'retained') === '0') throw Error('retained:positive');
  return value;
}

export function retainedRequest(p: CapturedMoneroPayout, challenge: string) {
  [challenge, p.eventId, p.instructionDigest, p.requestDigest].forEach(x => publicHex(x, 'request'));
  if (p.network !== 'testnet' || !/^[1-9A-HJ-NP-Za-km-z]{1,256}$/.test(p.address)) throw Error('retained:profile');
  positive(p.amount); canonicalUint(p.ceiling, 'request:ceiling');
  const fields = [challenge, p.eventId, p.instructionDigest, p.requestDigest, p.network, p.address, p.amount, p.ceiling];
  const bytes = Buffer.from(['WMNI1', ...fields, ''].join('\n'), 'ascii');
  if (bytes.length > 2048) throw Error('retained:request-size');
  return Object.freeze({ fields: Object.freeze(fields), hex: bytes.toString('hex') });
}

export function retainedReceipt(value: string, p: CapturedMoneroPayout, fields: readonly string[], count: number) {
  const bytes = hex(value, 2048);
  const framer = new RetainedFramer(13, 2048);
  const rows = framer.push(bytes);
  if (!rows || rows[0] !== 'WMNR1' || fields.some((field, i) => rows[i + 1] !== field)) throw Error('retained:receipt-binding');
  const inputCount = Number(canonicalUint(rows[10], 'receipt:count'));
  return validateConstructionReceipt({ status: rows[11], signing: rows[12], eventId: p.eventId, instructionDigest: p.instructionDigest, requestDigest: p.requestDigest, network: p.network, address: p.address, amount: p.amount, maxMinerFeeAtomic: p.ceiling, necessaryFeeAtomic: rows[9], inputCount }, p, count);
}

export const digest = (value: string) => createHash('sha256').update(value, 'ascii').digest('hex');
