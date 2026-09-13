import { createHash } from 'node:crypto';

export const MAX_U64 = (1n << 64n) - 1n;
export const MAX_INTENT_BYTES = 4096;
export const MAX_OUTPUTS = 16;

export interface IntentFields {
  domain: string;
  source_network: string;
  vault_epoch: string;
  vault_address: string;
  destination_network: string;
  destination_asset: string;
  bridge_fee: string;
  network_fee: string;
  txid: string;
  to_address: string;
  amount: string;
  expiry_height: bigint;
}

export interface IntentOutput {
  output_index: bigint;
  output_public_key: string;
  amount: string;
}

export type DepositIntent = IntentFields &
  ({ version: 1 } | { version: 2; outputs: readonly IntentOutput[] });

export class IntentCodecError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

type Json = string | bigint | Json[] | { [key: string]: Json };
const FIELDS = [
  'domain',
  'version',
  'source_network',
  'vault_epoch',
  'vault_address',
  'destination_network',
  'destination_asset',
  'bridge_fee',
  'network_fee',
  'txid',
  'to_address',
  'amount',
  'expiry_height',
];

function requireValue(ok: boolean, code: string): asserts ok {
  if (!ok) throw new IntentCodecError(code);
}

export function uint64(value: unknown, name: string): bigint {
  requireValue(
    typeof value === 'bigint' && value >= 0n && value <= MAX_U64,
    `${name}:uint64`,
  );
  return value;
}

export function atomic(value: unknown, name: string): bigint {
  requireValue(
    typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value),
    `${name}:decimal`,
  );
  return uint64(BigInt(value), name);
}

export function hex32(value: unknown, name: string): string {
  requireValue(
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    `${name}:hex32`,
  );
  return value;
}

function ascii(value: unknown, name: string): asserts value is string {
  requireValue(
    typeof value === 'string' && /^[\x20-\x7e]{1,512}$/.test(value),
    `${name}:ascii`,
  );
}

function object(value: unknown): asserts value is Record<string, unknown> {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'schema:object',
  );
}

function keys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  requireValue(
    actual.length === sorted.length &&
      actual.every((key, index) => key === sorted[index]),
    'schema:keys',
  );
}

function canonical(value: Json): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

// A bounded JSON reader retains integer lexemes as bigint and checks duplicate
// decoded member names before constructing an object. JSON.parse alone loses both.
function parse(raw: string): Json {
  let offset = 0;
  function string(): string {
    const match = /^"(?:[^"\\]|\\.)*"/.exec(raw.slice(offset));
    requireValue(match !== null, 'json:string');
    offset += match[0].length;
    try {
      return JSON.parse(match[0]) as string;
    } catch {
      throw new IntentCodecError('json:string');
    }
  }
  function value(depth: number): Json {
    requireValue(depth <= 4, 'json:depth');
    const char = raw[offset];
    if (char === '"') return string();
    if (char === '{') {
      offset++;
      const result: Record<string, Json> = Object.create(null);
      const seen = new Set<string>();
      if (raw[offset] !== '}') {
        while (true) {
          const key = string();
          requireValue(!seen.has(key), 'json:duplicate');
          seen.add(key);
          requireValue(raw[offset++] === ':', 'json:syntax');
          result[key] = value(depth + 1);
          if (raw[offset] !== ',') break;
          offset++;
        }
      }
      requireValue(raw[offset++] === '}', 'json:syntax');
      return result;
    }
    if (char === '[') {
      offset++;
      const result: Json[] = [];
      if (raw[offset] !== ']') {
        while (true) {
          requireValue(result.length < MAX_OUTPUTS, 'outputs:count');
          result.push(value(depth + 1));
          if (raw[offset] !== ',') break;
          offset++;
        }
      }
      requireValue(raw[offset++] === ']', 'json:syntax');
      return result;
    }
    const match = /^(0|[1-9][0-9]*)/.exec(raw.slice(offset));
    requireValue(match !== null && match[0].length <= 20, 'json:integer');
    offset += match[0].length;
    return BigInt(match[0]);
  }
  const result = value(0);
  requireValue(offset === raw.length, 'json:trailing');
  return result;
}

function fromWire(wire: unknown): DepositIntent {
  object(wire);
  requireValue(wire.version === 1n || wire.version === 2n, 'schema:version');
  const version = wire.version === 1n ? 1 : 2;
  keys(wire, version === 1 ? FIELDS : [...FIELDS, 'outputs']);
  for (const name of FIELDS) {
    if (name !== 'version' && name !== 'expiry_height') ascii(wire[name], name);
  }
  const expiry =
    version === 1
      ? uint64(wire.expiry_height, 'expiry_height')
      : atomic(wire.expiry_height, 'expiry_height');
  const amount = atomic(wire.amount, 'amount');
  atomic(wire.bridge_fee, 'bridge_fee');
  atomic(wire.network_fee, 'network_fee');
  hex32(wire.txid, 'txid');
  const base = { ...wire, version, expiry_height: expiry } as IntentFields & {
    version: 1 | 2;
  };
  if (version === 1) return Object.freeze({ ...base, version: 1 });
  requireValue(
    Array.isArray(wire.outputs) &&
      wire.outputs.length > 0 &&
      wire.outputs.length <= MAX_OUTPUTS,
    'outputs:count',
  );
  let previous = -1n;
  let total = 0n;
  const seen = new Set<string>();
  const outputs = wire.outputs.map((item) => {
    object(item);
    keys(item, ['output_index', 'output_public_key', 'amount']);
    const index = atomic(item.output_index, 'output_index');
    requireValue(index > previous, 'outputs:order');
    previous = index;
    const key = hex32(item.output_public_key, 'output_public_key');
    requireValue(!seen.has(key), 'outputs:duplicate-key');
    seen.add(key);
    const value = atomic(item.amount, 'output_amount');
    requireValue(value > 0n, 'outputs:zero');
    total = uint64(total + value, 'outputs:sum');
    return Object.freeze({
      output_index: index,
      output_public_key: key,
      amount: item.amount as string,
    });
  });
  requireValue(total === amount, 'outputs:amount');
  return Object.freeze({
    ...base,
    version: 2,
    outputs: Object.freeze(outputs),
  });
}

export function encodeIntent(intent: DepositIntent): Uint8Array {
  object(intent);
  requireValue(intent.version === 1 || intent.version === 2, 'schema:version');
  uint64(intent.expiry_height, 'expiry_height');
  const wire: Record<string, Json> = {
    ...intent,
    version: BigInt(intent.version),
    expiry_height:
      intent.version === 1
        ? intent.expiry_height
        : intent.expiry_height.toString(),
  } as unknown as Record<string, Json>;
  if (intent.version === 2) {
    requireValue(Array.isArray(intent.outputs), 'outputs:count');
    wire.outputs = intent.outputs.map((item) => ({
      ...item,
      output_index: uint64(item.output_index, 'output_index').toString(),
    }));
  }
  fromWire(wire);
  const encoded = new TextEncoder().encode(canonical(wire));
  requireValue(encoded.length <= MAX_INTENT_BYTES, 'intent:size');
  return encoded;
}

export function decodeIntent(bytes: Uint8Array): DepositIntent {
  requireValue(
    bytes instanceof Uint8Array &&
      bytes.length > 0 &&
      bytes.length <= MAX_INTENT_BYTES,
    'intent:size',
  );
  requireValue(
    bytes.every((byte) => byte >= 32 && byte < 127),
    'intent:ascii',
  );
  const raw = new TextDecoder().decode(bytes);
  const wire = parse(raw);
  const intent = fromWire(wire);
  requireValue(canonical(wire) === raw, 'intent:canonical');
  return intent;
}

export function intentHash(bytes: Uint8Array): string {
  decodeIntent(bytes);
  return createHash('sha256').update(bytes).digest('hex');
}
