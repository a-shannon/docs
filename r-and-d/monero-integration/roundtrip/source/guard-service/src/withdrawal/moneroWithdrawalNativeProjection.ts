import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import {
  buildUnapprovedMoneroPayout,
  WITHDRAWAL_LIMITS,
  type UnapprovedMoneroPayoutRequest,
} from './moneroWithdrawalOrder';

const MAX_UINT64 = (1n << 64n) - 1n;
const WIRE_BYTES = 2048;
const REQUEST_KEYS = [
  'schema',
  'approval',
  'eventId',
  'instructionDigest',
  'requestDigest',
  'canonicalRequest',
] as const;

export interface NativeIntentCommand {
  readonly file: string;
  readonly args: readonly string[];
}

/** A construction check; no live intent handle, approval or signing capability. */
export interface UnapprovedNativeIntentCheck {
  readonly status: 'unapproved-native-intent';
  readonly signing: 'prohibited';
  readonly eventId: string;
  readonly instructionDigest: string;
  readonly requestDigest: string;
  readonly network: string;
  readonly address: string;
  readonly amount: string;
  readonly maxMinerFeeAtomic: string;
  readonly necessaryFeeAtomic: string;
  readonly inputCount: number;
}

function fail(code: string): never {
  throw new Error(code);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return fail(code);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return fail(code);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      return fail(code);
    result[key] = descriptor.value;
  }
  return result;
}

function exact(value: unknown, keys: readonly string[], code: string) {
  const result = record(value, code);
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result, key))
  )
    return fail(code);
  return result;
}

function uint(value: unknown, code: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 20 ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > MAX_UINT64
  )
    return fail(code);
  return value;
}

function restoreInteger(value: unknown): number {
  const result = Number(uint(value, 'request:integer'));
  if (!Number.isSafeInteger(result)) fail('request:integer');
  return result;
}

function captureCommand(value: NativeIntentCommand) {
  const command = exact(value, ['file', 'args'], 'command:schema');
  if (
    typeof command.file !== 'string' ||
    !command.file.length ||
    command.file.includes('\0') ||
    !Array.isArray(command.args) ||
    command.args.length > 16
  )
    return fail('command:schema');
  const args = command.args;
  if (Reflect.ownKeys(args).length !== args.length + 1)
    return fail('command:args');
  const copy = Array.from({ length: args.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(args, String(index));
    if (
      !entry ||
      !('value' in entry) ||
      typeof entry.value !== 'string' ||
      entry.value.length > 4096 ||
      entry.value.includes('\0')
    )
      return fail('command:args');
    return entry.value as string;
  });
  return { file: command.file, args: copy };
}

/** Exact W1a reconstruction; this does not authenticate the source event. */
export async function captureUnapprovedMoneroPayoutRequest(value: unknown) {
  const raw = exact(value, REQUEST_KEYS, 'request:schema');
  for (const key of REQUEST_KEYS) {
    if (typeof raw[key] !== 'string') fail('request:schema');
  }
  const request = raw as unknown as UnapprovedMoneroPayoutRequest;
  if (
    Buffer.byteLength(request.canonicalRequest, 'utf8') >
    WITHDRAWAL_LIMITS.requestBytes
  )
    fail('request:bytes');
  let document: Record<string, unknown>;
  try {
    document = record(JSON.parse(request.canonicalRequest), 'request:json');
  } catch {
    return fail('request:json');
  }
  // W1a renders number fields as decimal strings; restore only those fields.
  const source = record(document.source, 'request:source');
  const event = record(source.event, 'request:event');
  for (const key of ['height', 'sourceChainHeight', 'WIDsCount'])
    event[key] = restoreInteger(event[key]);
  source.event = event;
  const profile = record(document.profile, 'request:profile');
  for (const key of ['sourceDecimals', 'destinationDecimals'])
    profile[key] = restoreInteger(profile[key]);
  if (!Array.isArray(profile.tokens) || profile.tokens.length !== 1)
    fail('request:tokens');
  const row = record(profile.tokens[0], 'request:token');
  for (const chain of ['ergo', 'monero']) {
    const token = record(row[chain], 'request:token');
    token.decimals = restoreInteger(token.decimals);
    row[chain] = token;
  }
  profile.tokens = [row];
  const regenerated = await buildUnapprovedMoneroPayout(source, profile);
  for (const key of REQUEST_KEYS) {
    if (request[key] !== regenerated[key]) fail(`request:binding:${key}`);
  }
  // Derived from the regenerated document, never from separately supplied fields.
  const checked = JSON.parse(regenerated.canonicalRequest);
  return Object.freeze({
    request: regenerated,
    eventId: regenerated.eventId,
    instructionDigest: regenerated.instructionDigest,
    requestDigest: regenerated.requestDigest,
    sourceNetwork: checked.profile.sourceNetwork as string,
    network: checked.profile.destinationNetwork as string,
    address: checked.order[0].address as string,
    amount: uint(checked.netAtomicAmount, 'request:amount'),
    ceiling: uint(checked.maxMinerFeeAtomic, 'request:ceiling'),
  });
}

export type CapturedMoneroPayout = Awaited<
  ReturnType<typeof captureUnapprovedMoneroPayoutRequest>
>;

/**
 * The configured executable is trusted local code. Its receipt has no standalone
 * authentication. A synchronous owned pipe keeps this check tied to the captured
 * W1a request; the child drops its private intent when the check ends.
 */
export async function checkUnapprovedMoneroNativeIntent(
  requestValue: unknown,
  nativeCommand: NativeIntentCommand,
): Promise<UnapprovedNativeIntentCheck> {
  const command = captureCommand(nativeCommand);
  const projection = await captureUnapprovedMoneroPayoutRequest(requestValue);
  const challenge = randomBytes(32).toString('hex');
  const fields = [
    challenge,
    projection.eventId,
    projection.instructionDigest,
    projection.requestDigest,
    projection.network,
    projection.address,
    projection.amount,
    projection.ceiling,
  ];
  if (fields.slice(0, 4).some((value) => !/^[0-9a-f]{64}$/.test(value)))
    fail('request:identity');
  if (!['mainnet', 'testnet', 'stagenet'].includes(projection.network))
    fail('request:network');
  if (!/^[1-9A-HJ-NP-Za-km-z]{1,256}$/.test(projection.address))
    fail('request:address');
  if (projection.amount === '0') fail('request:amount');
  const input = Buffer.from(['WMNI1', ...fields, ''].join('\n'), 'ascii');
  if (input.length > WIRE_BYTES) fail('request:wire-size');
  const child = spawnSync(command.file, command.args, {
    input,
    encoding: 'buffer',
    shell: false,
    windowsHide: true,
    timeout: 30000,
    maxBuffer: WIRE_BYTES,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.error || child.signal || child.status !== 0) fail('native:process');
  const output = child.stdout;
  if (
    !Buffer.isBuffer(output) ||
    output.length > WIRE_BYTES ||
    output.some((byte) => byte !== 10 && (byte < 33 || byte > 126))
  )
    fail('native:framing');
  const lines = output.toString('ascii').split('\n');
  if (lines.length !== 14 || lines[13] !== '' || lines[0] !== 'WMNR1')
    fail('native:framing');
  for (let index = 0; index < fields.length; ++index) {
    if (lines[index + 1] !== fields[index]) fail(`native:binding:${index + 1}`);
  }
  const fee = uint(lines[9], 'native:fee');
  if (fee === '0' || BigInt(fee) > BigInt(projection.ceiling))
    fail('native:fee-ceiling');
  const inputCount = uint(lines[10], 'native:inputs');
  if (BigInt(inputCount) < 1n || BigInt(inputCount) > 16n)
    fail('native:inputs');
  if (lines[11] !== 'unapproved-native-intent' || lines[12] !== 'prohibited')
    fail('native:status');
  return Object.freeze({
    status: 'unapproved-native-intent',
    signing: 'prohibited',
    eventId: projection.eventId,
    instructionDigest: projection.instructionDigest,
    requestDigest: projection.requestDigest,
    network: projection.network,
    address: projection.address,
    amount: projection.amount,
    maxMinerFeeAtomic: projection.ceiling,
    necessaryFeeAtomic: fee,
    inputCount: Number(inputCount),
  });
}
