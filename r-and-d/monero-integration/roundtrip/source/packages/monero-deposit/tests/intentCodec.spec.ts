import {
  decodeIntent,
  encodeIntent,
  intentHash,
  MAX_U64,
} from '../lib/intentCodec';
import type { DepositIntent } from '../lib/intentCodec';
import { multiFixture } from './fixtures';
import corpus from './fixtures/legacy-v1.json';

// Extracted from the historical Python fixture; hash independently computed by
// CPython json.dumps(sort_keys=True, separators=(',', ':')) + hashlib.sha256.
const HISTORICAL_BYTES = corpus.vectors[0].json;
const bytes = (s: string) => new TextEncoder().encode(s);

describe('intent codec', () => {
  it('reports duplicate decoded keys before normalization', () => {
    const raw = HISTORICAL_BYTES.replace(
      '"amount":',
      '"amou\\u006et":"1","amount":',
    );
    expect(() => decodeIntent(bytes(raw))).toThrow('json:duplicate');
  });

  it('rejects unknown keys on encode as well as decode', () => {
    const intent = decodeIntent(bytes(HISTORICAL_BYTES));
    expect(() =>
      encodeIntent({ ...intent, unknown: 'x' } as unknown as DepositIntent),
    ).toThrow('schema:keys');
  });

  it.each([
    ['negative', '-1'],
    ['fraction', '1.0'],
    ['boolean', true],
    ['empty', ''],
  ])('rejects %s atomic amounts', (_name, amount) => {
    const raw = HISTORICAL_BYTES.replace(
      '"amount":"1000000000000"',
      `"amount":${JSON.stringify(amount)}`,
    );
    expect(() => decodeIntent(bytes(raw))).toThrow();
  });

  it.each([
    [
      'unknown output key',
      (intent: DepositIntent) => {
        if (intent.version === 2)
          Object.assign(intent.outputs[0], { extra: 'x' });
      },
      'schema:keys',
    ],
    [
      'duplicate economic key',
      (intent: DepositIntent) => {
        if (intent.version === 2)
          intent.outputs[1].output_public_key =
            intent.outputs[0].output_public_key;
      },
      'outputs:duplicate-key',
    ],
    [
      'duplicate index',
      (intent: DepositIntent) => {
        if (intent.version === 2) intent.outputs[1].output_index = 0n;
      },
      'outputs:order',
    ],
    [
      'out of order',
      (intent: DepositIntent) => {
        if (intent.version === 2)
          intent.outputs = [...intent.outputs].reverse();
      },
      'outputs:order',
    ],
    [
      'aggregate mismatch',
      (intent: DepositIntent) => {
        intent.amount = '1';
      },
      'outputs:amount',
    ],
    [
      'zero output',
      (intent: DepositIntent) => {
        if (intent.version === 2) intent.outputs[0].amount = '0';
      },
      'outputs:zero',
    ],
    [
      'empty output set',
      (intent: DepositIntent) => {
        if (intent.version === 2) intent.outputs = [];
      },
      'outputs:count',
    ],
  ] as const)('rejects V2 %s', (_name, mutate, code) => {
    const f = multiFixture();
    mutate(f.intent);
    expect(() => encodeIntent(f.intent)).toThrow(code);
  });

  it('preserves the historical V1 bytes and SHA-256', () => {
    const intent = decodeIntent(bytes(HISTORICAL_BYTES));
    expect(intent.expiry_height).toBe(120n);
    expect(new TextDecoder().decode(encodeIntent(intent))).toBe(
      HISTORICAL_BYTES,
    );
    expect(intentHash(bytes(HISTORICAL_BYTES))).toBe(
      'f43016f4bd64705e65894cfe77431dc69a2b612e49a8301a5a798823cf3a02cd',
    );
  });

  it.each([9007199254740993n, MAX_U64])(
    'preserves numeric V1 height %s without Number rounding',
    (height) => {
      const raw = bytes(
        HISTORICAL_BYTES.replace(
          '"expiry_height":120',
          `"expiry_height":${height}`,
        ),
      );
      const parsed = decodeIntent(raw);
      expect(parsed.expiry_height).toBe(height);
      expect(encodeIntent(parsed)).toEqual(raw);
    },
  );

  it.each([
    [
      'duplicate',
      HISTORICAL_BYTES.replace('"amount":', '"amount":"1","amount":'),
    ],
    [
      'escaped duplicate',
      HISTORICAL_BYTES.replace('"amount":', '"amou\\u006et":"1","amount":'),
    ],
    ['whitespace', ` ${HISTORICAL_BYTES}`],
    [
      'unknown member',
      HISTORICAL_BYTES.replace('"version":1', '"version":1,"x":"x"'),
    ],
    ['unknown version', HISTORICAL_BYTES.replace('"version":1', '"version":3')],
    [
      'decimal version',
      HISTORICAL_BYTES.replace('"version":1', '"version":1.0'),
    ],
    [
      'negative height',
      HISTORICAL_BYTES.replace('"expiry_height":120', '"expiry_height":-1'),
    ],
    [
      'height overflow',
      HISTORICAL_BYTES.replace(
        '"expiry_height":120',
        `"expiry_height":${MAX_U64 + 1n}`,
      ),
    ],
    [
      'amount overflow',
      HISTORICAL_BYTES.replace(
        '"amount":"1000000000000"',
        `"amount":"${MAX_U64 + 1n}"`,
      ),
    ],
    [
      'leading zero',
      HISTORICAL_BYTES.replace('"amount":"1000000000000"', '"amount":"01"'),
    ],
    [
      'numeric amount',
      HISTORICAL_BYTES.replace(
        '"amount":"1000000000000"',
        '"amount":1000000000000',
      ),
    ],
    [
      'uppercase txid',
      HISTORICAL_BYTES.replace('a'.repeat(64), 'A'.repeat(64)),
    ],
    ['unicode', HISTORICAL_BYTES.replace('synthetic-recipient', 'récepteur')],
    ['trailing value', `${HISTORICAL_BYTES}{}`],
    ['empty', ''],
    ['oversize', ' '.repeat(4097)],
  ])('rejects %s', (_name, raw) => {
    expect(() => decodeIntent(bytes(raw))).toThrow();
  });

  it('rejects a UTF-8 BOM and invalid UTF-8', () => {
    expect(() =>
      decodeIntent(
        Uint8Array.from([239, 187, 191, ...bytes(HISTORICAL_BYTES)]),
      ),
    ).toThrow();
    expect(() => decodeIntent(Uint8Array.from([255]))).toThrow();
  });

  it('versions the multi-output extension and canonical decimal heights/indices', () => {
    const legacy = decodeIntent(bytes(HISTORICAL_BYTES));
    const intent: DepositIntent = {
      ...legacy,
      version: 2,
      domain: 'rosen-monero-deposit',
      outputs: [
        {
          output_index: 0n,
          output_public_key: 'c'.repeat(64),
          amount: '400000000000',
        },
        {
          output_index: 3n,
          output_public_key: 'd'.repeat(64),
          amount: '600000000000',
        },
      ],
    };
    const raw = encodeIntent(intent);
    expect(new TextDecoder().decode(raw)).toContain('"expiry_height":"120"');
    expect(new TextDecoder().decode(raw)).toContain('"output_index":"3"');
    expect(decodeIntent(raw)).toEqual(intent);
    expect(intentHash(raw)).not.toBe(intentHash(bytes(HISTORICAL_BYTES)));
  });
});
