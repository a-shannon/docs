import { createHash } from 'node:crypto';

import { TokenMap, type RosenTokens } from '@rosen-bridge/tokens';
import type { EventTrigger } from '@rosen-chains/abstract-chain';

import EventOrder from '../event/eventOrder';
import EventSerializer from '../event/eventSerializer';

export const WITHDRAWAL_LIMITS = Object.freeze({
  wids: 64,
  widBytes: 128,
  literalBytes: 128,
  addressBytes: 256,
  decimalDigits: 20,
  requestBytes: 32768,
});
const MAX_UINT64 = (1n << 64n) - 1n;
const SCHEMA = 'rosen-monero-unapproved-payout-v1';
const INSTRUCTION_DOMAIN = 'rosen-monero-withdrawal-instruction-v1';

export class MoneroWithdrawalOrderError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'MoneroWithdrawalOrderError';
  }
}

export interface UnapprovedMoneroPayoutRequest {
  readonly schema: typeof SCHEMA;
  readonly approval: 'unapproved';
  readonly eventId: string;
  readonly instructionDigest: string;
  readonly requestDigest: string;
  readonly canonicalRequest: string;
}

function fail(code: string): never {
  throw new MoneroWithdrawalOrderError(code);
}

/** Accept data properties only, and copy values before exposing any await. */
function record(value: unknown, keys: readonly string[], code: string) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return fail(code);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length ||
    keys.some((key) => !ownKeys.includes(key))
  )
    return fail(code);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = descriptors[key];
    if (!('value' in field) || !field.enumerable) return fail(code);
    result[key] = field.value;
  }
  return result;
}

function list(value: unknown, limit: number, code: string): unknown[] {
  if (!Array.isArray(value) || value.length > limit) return fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return fail(code);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return fail(code);
    return descriptor.value as unknown;
  });
}

function literal(value: unknown, limit: number, code: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > limit
  )
    return fail(code);
  return value;
}

function uint(value: unknown, code: string): bigint {
  if (
    typeof value !== 'string' ||
    value.length > WITHDRAWAL_LIMITS.decimalDigits ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  )
    return fail(code);
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64) return fail(code);
  return parsed;
}

function feeValue(value: unknown, code: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n || value > MAX_UINT64) return fail(code);
    return value;
  }
  return uint(value, code);
}

function safeInteger(value: unknown, code: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  )
    return fail(code);
  return value;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    typeof item === 'bigint' || typeof item === 'number'
      ? item.toString()
      : item,
  );
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function captureSource(value: unknown) {
  const source = record(
    value,
    ['event', 'triggerTransactionId', 'triggerBoxId', 'wids'],
    'source:schema',
  );
  const fields = [
    'height',
    'fromChain',
    'toChain',
    'fromAddress',
    'toAddress',
    'amount',
    'bridgeFee',
    'networkFee',
    'sourceChainTokenId',
    'targetChainTokenId',
    'sourceTxId',
    'sourceChainHeight',
    'sourceBlockId',
    'WIDsHash',
    'WIDsCount',
  ];
  const raw = record(source.event, fields, 'event:schema');
  const text = (key: string, limit: number = WITHDRAWAL_LIMITS.literalBytes) =>
    literal(raw[key], limit, `event:${key}`);
  const event: EventTrigger = {
    height: safeInteger(raw.height, 'event:height'),
    fromChain: text('fromChain'),
    toChain: text('toChain'),
    fromAddress: text('fromAddress', WITHDRAWAL_LIMITS.addressBytes),
    toAddress: text('toAddress', WITHDRAWAL_LIMITS.addressBytes),
    amount: uint(raw.amount, 'event:amount').toString(),
    bridgeFee: uint(raw.bridgeFee, 'event:bridgeFee').toString(),
    networkFee: uint(raw.networkFee, 'event:networkFee').toString(),
    sourceChainTokenId: text('sourceChainTokenId'),
    targetChainTokenId: text('targetChainTokenId'),
    sourceTxId: text('sourceTxId'),
    sourceChainHeight: safeInteger(
      raw.sourceChainHeight,
      'event:sourceChainHeight',
    ),
    sourceBlockId: text('sourceBlockId'),
    WIDsHash: text('WIDsHash'),
    WIDsCount: safeInteger(raw.WIDsCount, 'event:WIDsCount'),
  };
  if (event.fromChain !== 'ergo' || event.toChain !== 'monero')
    fail('event:chains');
  if (BigInt(event.amount) === 0n) fail('event:amount-positive');
  const wids = list(source.wids, WITHDRAWAL_LIMITS.wids, 'source:wids').map(
    (wid) => literal(wid, WITHDRAWAL_LIMITS.widBytes, 'source:wid'),
  );
  if (!wids.length || event.WIDsCount !== wids.length) fail('source:wid-count');
  return freeze({
    event,
    triggerTransactionId: literal(
      source.triggerTransactionId,
      WITHDRAWAL_LIMITS.literalBytes,
      'source:triggerTransactionId',
    ),
    triggerBoxId: literal(
      source.triggerBoxId,
      WITHDRAWAL_LIMITS.literalBytes,
      'source:triggerBoxId',
    ),
    wids,
  });
}

function captureProfile(value: unknown) {
  const raw = record(
    value,
    [
      'version',
      'sourceNetwork',
      'destinationNetwork',
      'epoch',
      'configurationId',
      'fees',
      'tokens',
      'sourceDecimals',
      'destinationDecimals',
      'minimumNativeTopUp',
      'maxMinerFeeAtomic',
    ],
    'profile:schema',
  );
  const feesRaw = record(
    raw.fees,
    [
      'bridgeFee',
      'networkFee',
      'rsnRatio',
      'rsnRatioDivisor',
      'feeRatio',
      'feeRatioDivisor',
    ],
    'profile:fees',
  );
  const fees = {
    bridgeFee: feeValue(feesRaw.bridgeFee, 'fees:bridgeFee'),
    networkFee: feeValue(feesRaw.networkFee, 'fees:networkFee'),
    rsnRatio: feeValue(feesRaw.rsnRatio, 'fees:rsnRatio'),
    rsnRatioDivisor: feeValue(feesRaw.rsnRatioDivisor, 'fees:rsnRatioDivisor'),
    feeRatio: feeValue(feesRaw.feeRatio, 'fees:feeRatio'),
    feeRatioDivisor: feeValue(feesRaw.feeRatioDivisor, 'fees:feeRatioDivisor'),
  };
  if (fees.feeRatioDivisor !== 10000n || fees.rsnRatioDivisor === 0n)
    fail('fees:divisor');
  const rows = list(raw.tokens, 1, 'profile:tokens');
  if (rows.length !== 1) fail('profile:tokens');
  const row = record(rows[0], ['ergo', 'monero'], 'profile:token-chains');
  const token = (chain: 'ergo' | 'monero') => {
    const rawToken = record(
      row[chain],
      ['tokenId', 'name', 'decimals', 'type', 'residency', 'extra'],
      'profile:token',
    );
    const extra = record(rawToken.extra, [], 'profile:token-extra');
    const text = (field: string) =>
      literal(
        rawToken[field],
        WITHDRAWAL_LIMITS.literalBytes,
        `token:${field}`,
      );
    return {
      tokenId: text('tokenId'),
      name: text('name'),
      decimals: safeInteger(rawToken.decimals, 'token:decimals'),
      type: text('type'),
      residency: text('residency'),
      extra: extra as Record<string, string | number | boolean>,
    };
  };
  const tokens: RosenTokens = [
    { ergo: token('ergo'), monero: token('monero') },
  ];
  if (raw.version !== '1') fail('profile:version');
  if (
    raw.sourceDecimals !== 12 ||
    raw.destinationDecimals !== 12 ||
    tokens[0].ergo.decimals !== 12 ||
    tokens[0].monero.decimals !== 12
  )
    fail('profile:units');
  if (
    tokens[0].ergo.type !== 'EIP-004' ||
    tokens[0].ergo.residency !== 'wrapped' ||
    tokens[0].monero.type !== 'native' ||
    tokens[0].monero.residency !== 'native' ||
    tokens[0].monero.tokenId !== 'XMR'
  )
    fail('profile:token-type');
  if (uint(raw.minimumNativeTopUp, 'profile:minimumNativeTopUp') !== 0n)
    fail('profile:top-up');
  return freeze({
    version: '1',
    sourceNetwork: literal(
      raw.sourceNetwork,
      WITHDRAWAL_LIMITS.literalBytes,
      'profile:sourceNetwork',
    ),
    destinationNetwork: literal(
      raw.destinationNetwork,
      WITHDRAWAL_LIMITS.literalBytes,
      'profile:destinationNetwork',
    ),
    epoch: uint(raw.epoch, 'profile:epoch').toString(),
    configurationId: literal(
      raw.configurationId,
      WITHDRAWAL_LIMITS.literalBytes,
      'profile:configurationId',
    ),
    fees,
    tokens,
    sourceDecimals: 12,
    destinationDecimals: 12,
    minimumNativeTopUp: '0',
    maxMinerFeeAtomic: uint(
      raw.maxMinerFeeAtomic,
      'profile:maxMinerFeeAtomic',
    ).toString(),
  });
}

/** Checks source/profile consistency only; neither source authenticity nor approval. */
export async function buildUnapprovedMoneroPayout(
  sourceValue: unknown,
  profileValue: unknown,
): Promise<UnapprovedMoneroPayoutRequest> {
  const source = captureSource(sourceValue);
  const profile = captureProfile(profileValue);
  const event = source.event;
  const gross = BigInt(event.amount);
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  const bridge = max(
    max(BigInt(event.bridgeFee), profile.fees.bridgeFee),
    (gross * profile.fees.feeRatio) / profile.fees.feeRatioDivisor,
  );
  const network = max(BigInt(event.networkFee), profile.fees.networkFee);
  if (bridge > MAX_UINT64 || bridge + network >= gross)
    fail('amount:nonpositive-net');
  const net = gross - bridge - network;
  if (
    profile.tokens[0].ergo.tokenId !== event.sourceChainTokenId ||
    profile.tokens[0].monero.tokenId !== event.targetChainTokenId
  )
    fail('profile:token-identity');

  const eventId = EventSerializer.getId(event);
  const instructionDigest = hash(
    canonical({ domain: INSTRUCTION_DOMAIN, source, profile }),
  );
  const privateMap = new TokenMap();
  await privateMap.updateConfigByJson(structuredClone(profile.tokens));
  const sourceMatches = privateMap.search('ergo', {
    tokenId: event.sourceChainTokenId,
  });
  const destinationMatches = privateMap.search('monero', {
    tokenId: event.targetChainTokenId,
  });
  if (
    sourceMatches.length !== 1 ||
    destinationMatches.length !== 1 ||
    sourceMatches[0] !== destinationMatches[0]
  )
    fail('mapping:identity');
  if (privateMap.getSignificantDecimals(event.targetChainTokenId) !== 12)
    fail('mapping:units');
  const unwrapped = privateMap.unwrapAmount(
    event.targetChainTokenId,
    net,
    'monero',
  );
  if (unwrapped.decimals !== 12 || unwrapped.amount !== net)
    fail('mapping:conversion');

  const producerSource = freeze(structuredClone(source));
  const producerFees = freeze(structuredClone(profile.fees));
  const returned = await EventOrder.createEventPaymentOrder(
    producerSource.event,
    producerSource.triggerTransactionId,
    producerFees,
    producerSource.wids,
  );
  const order = list(returned, 1, 'order:count');
  if (order.length !== 1) fail('order:count');
  const payment = record(order[0], ['address', 'assets'], 'order:payment');
  const address = literal(
    payment.address,
    WITHDRAWAL_LIMITS.addressBytes,
    'order:address',
  );
  if (address !== event.toAddress) fail('order:recipient');
  const assets = record(
    payment.assets,
    ['nativeToken', 'tokens'],
    'order:assets',
  );
  const nativeToken = assets.nativeToken;
  if (typeof nativeToken !== 'bigint' || nativeToken !== net)
    fail('order:amount');
  if (list(assets.tokens, 0, 'order:tokens').length !== 0) fail('order:tokens');
  const canonicalRequest = canonical({
    schema: SCHEMA,
    approval: 'unapproved',
    addressValidation: 'not-performed',
    eventId,
    instructionDigest,
    source,
    profile,
    gross,
    chargedBridgeFee: bridge,
    chargedNetworkFee: network,
    netAtomicAmount: net,
    maxMinerFeeAtomic: profile.maxMinerFeeAtomic,
    order: [{ address, assets: { nativeToken, tokens: [] } }],
  });
  if (
    Buffer.byteLength(canonicalRequest, 'utf8') > WITHDRAWAL_LIMITS.requestBytes
  )
    fail('request:bytes');
  return Object.freeze({
    schema: SCHEMA,
    approval: 'unapproved',
    eventId,
    instructionDigest,
    requestDigest: hash(canonicalRequest),
    canonicalRequest,
  });
}
