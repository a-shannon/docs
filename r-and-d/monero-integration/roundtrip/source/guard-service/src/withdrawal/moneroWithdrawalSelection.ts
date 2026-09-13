import type {
  CapturedMoneroPayout,
  UnapprovedNativeIntentCheck,
} from './moneroWithdrawalNativeProjection';

export const MAX_SELECTION_BYTES = 65536;
export const SELECTION_FRAME_BYTES = 147456;
const MAX_U64 = (1n << 64n) - 1n;

export function canonicalUint(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
    BigInt(value) > MAX_U64
  )
    throw Error(`${label}:uint64`);
  return value;
}

export function publicHex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw Error(`${label}:hex`);
  return value;
}

export function ownData(
  value: unknown,
  keys: readonly string[],
  label: string,
) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw Error(`${label}:shape`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw Error(`${label}:shape`);
  if (Reflect.ownKeys(value).length !== keys.length)
    throw Error(`${label}:shape`);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      throw Error(`${label}:shape`);
    result[key] = descriptor.value;
  }
  return result;
}

function decodeInput(lines: readonly string[]) {
  const txid = publicHex(lines[0], 'selection:txid');
  const outputIndex = canonicalUint(lines[1], 'selection:output-index');
  const globalIndex = canonicalUint(lines[2], 'selection:global-index');
  const publicKey = publicHex(lines[3], 'selection:key');
  const amount = canonicalUint(lines[4], 'selection:amount');
  const commitment = publicHex(lines[5], 'selection:commitment');
  if (amount === '0' || lines[6] !== '16') throw Error('selection:input');
  const real = BigInt(canonicalUint(lines[7], 'selection:real-index'));
  if (real > 15n) throw Error('selection:real-index');
  const offsets = lines[8].split(',');
  if (offsets.length !== 16) throw Error('selection:offset-count');
  let absolute = 0n;
  for (let index = 0; index < 16; ++index) {
    const offset = BigInt(canonicalUint(offsets[index], 'selection:offset'));
    if (index > 0 && offset === 0n) throw Error('selection:offset-order');
    absolute += offset;
    if (absolute > MAX_U64) throw Error('selection:offset-overflow');
    if (index === Number(real) && absolute.toString() !== globalIndex)
      throw Error('selection:real-position');
    const member = lines[9 + index].split(':');
    if (member.length !== 2) throw Error('selection:member');
    publicHex(member[0], 'selection:member-key');
    publicHex(member[1], 'selection:member-commitment');
    if (
      index === Number(real) &&
      (member[0] !== publicKey || member[1] !== commitment)
    )
      throw Error('selection:real-member');
  }
  return Object.freeze({
    txid,
    outputIndex,
    globalIndex,
    publicKey,
    amount,
    commitment,
  });
}

/** Public syntax/identity checks. Native code owns point and Scanner validation. */
export function decodeNativeSelection(raw: string) {
  if (
    typeof raw !== 'string' ||
    raw.length > MAX_SELECTION_BYTES ||
    !/^[\x21-\x7e\n]+$/.test(raw)
  )
    throw Error('selection:framing');
  const lines = raw.split('\n');
  const legacy = lines[0] === 'WMNS1';
  if (!legacy && lines[0] !== 'WMNS2') throw Error('selection:framing');
  const count = legacy ? 1 : Number(canonicalUint(lines[4], 'selection:count'));
  if (count < 1 || count > 16) throw Error('selection:count');
  const start = legacy ? 4 : 5;
  const feeIndex = start + 25 * count;
  if (lines.length !== feeIndex + 3 || lines[feeIndex + 2] !== '')
    throw Error('selection:framing');
  const network = lines[1];
  if (!['mainnet', 'testnet', 'stagenet'].includes(network))
    throw Error('selection:network');
  const vaultSpend = publicHex(lines[2], 'selection:vault-spend');
  const vaultView = publicHex(lines[3], 'selection:vault-view');
  const inputs = Object.freeze(
    Array.from({ length: count }, (_, index) =>
      decodeInput(lines.slice(start + index * 25, start + (index + 1) * 25)),
    ),
  );
  const keys = new Set<string>();
  const positions = new Set<string>();
  const globals = new Set<string>();
  for (const input of inputs) {
    const position = `${input.txid}:${input.outputIndex}`;
    if (
      keys.has(input.publicKey) ||
      positions.has(position) ||
      globals.has(input.globalIndex)
    )
      throw Error('selection:duplicate-input');
    keys.add(input.publicKey);
    positions.add(position);
    globals.add(input.globalIndex);
  }
  for (const index of [feeIndex, feeIndex + 1])
    if (canonicalUint(lines[index], 'selection:fee') === '0')
      throw Error('selection:fee');
  return Object.freeze({ bytes: raw, network, vaultSpend, vaultView, inputs });
}

/** A public construction result, never approval or a retained native handle. */
export function validateConstructionReceipt(
  raw: unknown,
  projection: CapturedMoneroPayout,
  expectedInputCount: number,
): UnapprovedNativeIntentCheck {
  if (
    !Number.isInteger(expectedInputCount) ||
    expectedInputCount < 1 ||
    expectedInputCount > 16
  )
    throw Error('receipt:expected-input-count');
  const expected = {
    status: 'unapproved-native-intent',
    signing: 'prohibited',
    eventId: projection.eventId,
    instructionDigest: projection.instructionDigest,
    requestDigest: projection.requestDigest,
    network: projection.network,
    address: projection.address,
    amount: projection.amount,
    maxMinerFeeAtomic: projection.ceiling,
    inputCount: expectedInputCount,
  };
  const captured = ownData(
    raw,
    [...Object.keys(expected), 'necessaryFeeAtomic'],
    'receipt',
  );
  for (const [key, value] of Object.entries(expected))
    if (captured[key] !== value) throw Error(`receipt:binding:${key}`);
  const fee = canonicalUint(captured.necessaryFeeAtomic, 'receipt:fee');
  if (fee === '0' || BigInt(fee) > BigInt(projection.ceiling))
    throw Error('receipt:fee-ceiling');
  return Object.freeze({
    ...expected,
    status: 'unapproved-native-intent',
    signing: 'prohibited',
    necessaryFeeAtomic: fee,
  });
}
