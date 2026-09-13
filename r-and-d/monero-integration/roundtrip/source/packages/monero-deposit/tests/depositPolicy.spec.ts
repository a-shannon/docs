import {
  depositIdentity,
  economicOutputIdentity,
  outputLocator,
  toRosenObservation,
  verifyDeposit,
} from '../lib/depositPolicy';
import { encodeIntent, MAX_U64 } from '../lib/intentCodec';
import { fixture, multiFixture, KEY, PROOF, TXID } from './fixtures';

type Fixture = ReturnType<typeof fixture>;
const call = (f: Fixture) =>
  verifyDeposit(
    encodeIntent(f.intent),
    PROOF,
    { payload: 'fixture' },
    f.config,
    f.fees,
    f.providers,
  );

describe('stateless deposit policy', () => {
  it('requires explicit V2 policy and retains truthful multiplicity only as a candidate', async () => {
    const f=multiFixture();f.receipt.outputs[0].keyOccurrences=2n;
    expect((await call(f)).status).toBe('rejected');
    f.config.outputHistoryPolicy='authenticated-backing-v1';
    const accepted=await call(f);
    expect(accepted.status).toBe('accepted');
    if(accepted.status==='accepted'){
      expect(accepted.authority).toBe('stateless-candidate');
      expect(accepted.outputHistoryPolicy).toBe('authenticated-backing-v1');
      expect(accepted.outputs[0].keyOccurrences).toBe(2n);
    }
    f.receipt.outputs[0].keyOccurrences=0n;expect((await call(f)).status).toBe('rejected');
    f.receipt.outputs[0].keyOccurrences=2n;f.native.good=false;expect((await call(f)).status).toBe('rejected');
    const legacy=fixture();legacy.config.outputHistoryPolicy='authenticated-backing-v1';
    expect(await call(legacy)).toEqual({status:'indeterminate',reason:'config:output-history-policy'});
    const unknown=fixture();(unknown.config as any).outputHistoryPolicy='unknown';
    expect(await call(unknown)).toEqual({status:'indeterminate',reason:'config:output-history-policy'});
    const ordinary=await call(fixture());expect(ordinary.status).toBe('accepted');
    if(ordinary.status==='accepted'){expect(ordinary).not.toHaveProperty('outputHistoryPolicy');expect(ordinary.outputs[0]).not.toHaveProperty('keyOccurrences');}
  });
  const providerFields = [
    [
      'proof',
      [
        'sourcePin',
        'network',
        'txid',
        'vaultAddress',
        'messageBytes',
        'proof',
        'snapshotId',
        'good',
        'received',
        'inPool',
        'confirmations',
      ],
    ],
    [
      'receipt',
      [
        'network',
        'txid',
        'vaultAddress',
        'blockHash',
        'blockHeight',
        'snapshotId',
        'inPool',
        'outputs',
      ],
    ],
    [
      'output',
      [
        'index',
        'publicKey',
        'amount',
        'owned',
        'maturity',
        'spent',
        'keyOccurrences',
      ],
    ],
    [
      'address',
      [
        'sourceNetwork',
        'vaultAddress',
        'destinationNetwork',
        'destinationAsset',
        'recipient',
      ],
    ],
  ] as const;
  it.each(
    providerFields.flatMap(([scope, fields]) =>
      fields.flatMap((field) =>
        ['absent', 'null'].map((shape) => ({ scope, field, shape })),
      ),
    ),
  )(
    'keeps $scope / $field / $shape evidence indeterminate',
    async ({ scope, field, shape }) => {
      const f = fixture();
      const alter = (value: object) => {
        if (shape === 'absent') Reflect.deleteProperty(value, field);
        else Object.assign(value, { [field]: null });
      };
      if (scope === 'address') {
        f.providers.addresses.verify = async (request) => {
          alter(request);
          return { status: 'verified', value: request };
        };
      } else
        alter(
          scope === 'proof'
            ? f.native
            : scope === 'receipt'
              ? f.receipt
              : f.receipt.outputs[0],
        );
      expect(await call(f)).toEqual({
        status: 'indeterminate',
        reason: `${scope}:malformed`,
      });
    },
  );

  it.each([1, '1', true, -1n, MAX_U64 + 1n])(
    'keeps malformed native monetary value %s indeterminate',
    async (received) => {
      const f = fixture();
      Object.assign(f.native, { received });
      expect(await call(f)).toEqual({
        status: 'indeterminate',
        reason: 'proof:malformed',
      });
    },
  );

  it.each(['proof', 'receipt', 'address'] as const)(
    'keeps a missing %s failure reason indeterminate',
    async (scope) => {
      const f = fixture();
      const malformed = async () => ({ status: 'invalid' }) as never;
      if (scope === 'proof') f.providers.proof.verify = malformed;
      else if (scope === 'receipt') f.providers.receipt.reconstruct = malformed;
      else f.providers.addresses.verify = malformed;
      expect(await call(f)).toEqual({
        status: 'indeterminate',
        reason: `${scope}:malformed`,
      });
    },
  );

  it.each(['spent', 'maturity'] as const)(
    'keeps an unrecognized output %s indeterminate',
    async (field) => {
      const f = fixture();
      Object.assign(f.receipt.outputs[0], { [field]: 'not-an-observation' });
      expect(await call(f)).toEqual({
        status: 'indeterminate',
        reason: 'output:malformed',
      });
    },
  );

  it.each([1, '1', true, -1n, MAX_U64 + 1n])(
    'keeps malformed receipt monetary value %s indeterminate',
    async (amount) => {
      const f = fixture();
      Object.assign(f.receipt.outputs[0], { amount });
      expect(await call(f)).toEqual({
        status: 'indeterminate',
        reason: 'output:malformed',
      });
    },
  );

  it('requires all receipt fields instead of trusting a partial summary', async () => {
    const f = fixture();
    Reflect.deleteProperty(f.receipt, 'blockHash');
    expect(await call(f)).toEqual({
      status: 'indeterminate',
      reason: 'receipt:malformed',
    });
  });

  it('requires a native pin and an actual address provider', async () => {
    const f = fixture();
    f.config.nativeSourcePin = '0'.repeat(40);
    expect(await call(f)).toEqual({
      status: 'indeterminate',
      reason: 'config:native-source-pin',
    });
    const second = fixture();
    Reflect.deleteProperty(second.providers, 'addresses');
    expect(await call(second)).toEqual({
      status: 'indeterminate',
      reason: 'verifier:unavailable',
    });
  });

  it('rejects an empty qualifying receipt and aggregate overflow', async () => {
    const f = fixture();
    f.receipt.outputs = [];
    expect(await call(f)).toEqual({
      status: 'rejected',
      reason: 'receipt:output-count',
    });
    const multi = multiFixture();
    multi.receipt.outputs[0].amount = MAX_U64;
    expect(await call(multi)).toEqual({
      status: 'rejected',
      reason: 'receipt_sum:uint64',
    });
  });

  it('accepts an exact conversion without silently changing fees', async () => {
    const f = fixture();
    f.intent.network_fee = f.fees.networkFee = '900';
    f.native.messageBytes = encodeIntent(f.intent);
    f.fees.destinationDecimals = 9;
    expect(await call(f)).toMatchObject({
      status: 'accepted',
      networkFee: 900n,
      destinationAmount: 999999999n,
      retainedAtomicRemainder: 0n,
    });
  });

  it('consumes verifier results, preserves the historical candidate and labels fixture authority', async () => {
    const f = fixture();
    const result = await verifyDeposit(
      encodeIntent(f.intent),
      PROOF,
      { payload: 'fixture' },
      f.config,
      f.fees,
      f.providers,
    );
    expect(result).toMatchObject({
      status: 'accepted',
      authority: 'stateless-candidate',
      evidenceMode: 'fixture',
      amount: 1000000000000n,
      netAmount: 999999999880n,
      recipient: 'synthetic-recipient',
      intentHash:
        'f43016f4bd64705e65894cfe77431dc69a2b612e49a8301a5a798823cf3a02cd',
    });
    expect(f.providers.proof.verify).toHaveBeenCalledOnce();
    expect(f.providers.receipt.reconstruct).toHaveBeenCalledOnce();
    expect(f.providers.addresses.verify).toHaveBeenCalledOnce();
  });

  it('does not treat caller verified:true or a shaped proof as native evidence', async () => {
    const f = fixture();
    expect(
      await verifyDeposit(
        encodeIntent(f.intent),
        PROOF,
        { verified: true },
        f.config,
        f.fees,
      ),
    ).toEqual({ status: 'indeterminate', reason: 'verifier:unavailable' });
  });

  it('rejects inbound proof before invoking cryptographic verification', async () => {
    const f = fixture();
    const proof = 'InProofV2' + '1'.repeat(132);
    f.native.proof = proof;
    expect(
      await verifyDeposit(
        encodeIntent(f.intent),
        proof,
        {},
        f.config,
        f.fees,
        f.providers,
      ),
    ).toEqual({ status: 'rejected', reason: 'proof:outbound-v2' });
    expect(f.providers.proof.verify).not.toHaveBeenCalled();
  });

  it('returns indeterminate if independent receipt reconstruction is unavailable', async () => {
    const f = fixture();
    f.providers.receipt.reconstruct = async () => ({
      status: 'unavailable',
      reason: 'missing-key-images',
    });
    expect(
      await verifyDeposit(
        encodeIntent(f.intent),
        PROOF,
        {},
        f.config,
        f.fees,
        f.providers,
      ),
    ).toEqual({
      status: 'indeterminate',
      reason: 'receipt:missing-key-images',
    });
  });

  it('rejects an economic output already assigned under another locator', async () => {
    const f = fixture();
    f.config.creditedOutputIds = new Set([`monero:output-key:stagenet:${KEY}`]);
    expect(
      await verifyDeposit(
        encodeIntent(f.intent),
        PROOF,
        {},
        f.config,
        f.fees,
        f.providers,
      ),
    ).toEqual({ status: 'rejected', reason: 'output:already-assigned' });
  });

  it.each([
    'sourcePin',
    'network',
    'txid',
    'vaultAddress',
    'proof',
    'snapshotId',
  ] as const)('binds native %s independently', async (name) => {
    const f = fixture();
    const mismatches = {
      sourcePin: '0'.repeat(40),
      network: 'mainnet',
      txid: 'd'.repeat(64),
      vaultAddress: 'other-vault',
      proof: PROOF + '1'.repeat(132),
      snapshotId: 'other-snapshot',
    };
    Object.assign(f.native, { [name]: mismatches[name] });
    expect(await call(f)).toEqual({
      status: 'rejected',
      reason: `proof:${name}`,
    });
  });

  it('binds every changed recipient byte to the actual native message', async () => {
    const f = fixture();
    f.intent.to_address = 'other-recipient';
    expect(await call(f)).toEqual({
      status: 'rejected',
      reason: 'proof:message',
    });
  });

  it.each([
    ['domain', 'other-domain'],
    ['version', 2],
    ['source_network', 'mainnet'],
    ['vault_epoch', 'epoch-2'],
    ['vault_address', 'other-vault'],
    ['destination_network', 'other-network'],
    ['destination_asset', 'other-asset'],
    ['bridge_fee', '101'],
    ['network_fee', '21'],
    ['txid', 'd'.repeat(64)],
  ])(
    'rejects coordinated %s changes despite a matching fixture native result',
    async (name, value) => {
      const f = name === 'version' ? multiFixture() : fixture();
      if (name === 'version') f.config.version = 1;
      else Object.assign(f.intent, { [name]: value });
      f.native.messageBytes = encodeIntent(f.intent);
      expect(await call(f)).toEqual({
        status: 'rejected',
        reason: `config:${name}`,
      });
    },
  );

  it.each([false, 1, 'true', null])(
    'requires literal native good=true, not %s',
    async (good) => {
      const f = fixture();
      Object.assign(f.native, { good });
      expect(await call(f)).toEqual({
        status: good === false ? 'rejected' : 'indeterminate',
        reason:
          good === false ? 'proof:cryptographic-result' : 'proof:malformed',
      });
    },
  );

  it.each([
    [
      'native amount',
      (f: Fixture) => {
        f.native.received++;
      },
      'proof:amount',
      'rejected',
    ],
    [
      'receipt amount',
      (f: Fixture) => {
        f.receipt.outputs[0].amount++;
      },
      'receipt:amount',
      'rejected',
    ],
    [
      'native pool',
      (f: Fixture) => {
        f.native.inPool = true;
      },
      'proof:pool',
      'indeterminate',
    ],
    [
      'receipt pool',
      (f: Fixture) => {
        f.receipt.inPool = true;
      },
      'receipt:pool',
      'indeterminate',
    ],
    [
      'confirmation snapshot',
      (f: Fixture) => {
        f.native.confirmations++;
      },
      'proof:confirmation-snapshot',
      'indeterminate',
    ],
    [
      'confirmation threshold',
      (f: Fixture) => {
        f.config.snapshot.minConfirmations++;
      },
      'proof:confirmations',
      'indeterminate',
    ],
    [
      'block hash',
      (f: Fixture) => {
        f.receipt.blockHash = 'd'.repeat(64);
      },
      'receipt:snapshot',
      'indeterminate',
    ],
    [
      'block height',
      (f: Fixture) => {
        f.receipt.blockHeight++;
      },
      'receipt:snapshot',
      'indeterminate',
    ],
    [
      'receipt snapshot',
      (f: Fixture) => {
        f.receipt.snapshotId += 'x';
      },
      'receipt:snapshot',
      'indeterminate',
    ],
    [
      'unowned output',
      (f: Fixture) => {
        f.receipt.outputs[0].owned = false;
      },
      'output:ownership',
      'rejected',
    ],
    [
      'locked output',
      (f: Fixture) => {
        f.receipt.outputs[0].maturity = 'locked';
      },
      'output:maturity',
      'indeterminate',
    ],
    [
      'unknown maturity',
      (f: Fixture) => {
        f.receipt.outputs[0].maturity = 'unknown';
      },
      'output:maturity',
      'indeterminate',
    ],
    [
      'spent output',
      (f: Fixture) => {
        f.receipt.outputs[0].spent = 'spent';
      },
      'output:spent',
      'rejected',
    ],
    [
      'unknown spent state',
      (f: Fixture) => {
        f.receipt.outputs[0].spent = 'unknown';
      },
      'output:spent-unavailable',
      'indeterminate',
    ],
    [
      'duplicate key in history',
      (f: Fixture) => {
        f.receipt.outputs[0].keyOccurrences = 2n;
      },
      'output:canonical-key-duplicate',
      'rejected',
    ],
    [
      'missing key in history',
      (f: Fixture) => {
        f.receipt.outputs[0].keyOccurrences = 0n;
      },
      'output:canonical-key-duplicate',
      'rejected',
    ],
    [
      'expired',
      (f: Fixture) => {
        f.intent.expiry_height = 109n;
        f.native.messageBytes = encodeIntent(f.intent);
      },
      'intent:expired',
      'rejected',
    ],
  ] as const)('isolates %s', async (_name, mutate, reason, status) => {
    const f = fixture();
    mutate(f);
    expect(await call(f)).toEqual({ status, reason });
  });

  it.each(['network', 'txid', 'vaultAddress'] as const)(
    'binds receipt %s independently',
    async (name) => {
      const f = fixture();
      const mismatches = {
        network: 'mainnet',
        txid: 'd'.repeat(64),
        vaultAddress: 'other-vault',
      };
      Object.assign(f.receipt, { [name]: mismatches[name] });
      expect(await call(f)).toEqual({
        status: 'rejected',
        reason: `receipt:${name}`,
      });
    },
  );

  it('consumes address validation and binds its exact result', async () => {
    const f = fixture();
    f.providers.addresses.verify = async () => ({
      status: 'invalid',
      reason: 'wrong-network',
    });
    expect(await call(f)).toEqual({
      status: 'rejected',
      reason: 'address:wrong-network',
    });
    f.providers.addresses.verify = async (request) => ({
      status: 'verified',
      value: { ...request, recipient: 'another' },
    });
    expect(await call(f)).toEqual({
      status: 'rejected',
      reason: 'address:recipient',
    });
  });

  it.each(['proof', 'receipt', 'addresses'] as const)(
    'does not accept when the %s provider throws',
    async (name) => {
      const f = fixture();
      const fail = async () => {
        throw new Error('offline');
      };
      if (name === 'receipt') f.providers.receipt.reconstruct = fail;
      else f.providers[name].verify = fail;
      expect(await call(f)).toEqual({
        status: 'indeterminate',
        reason: `${name === 'addresses' ? 'address' : name}:unavailable`,
      });
    },
  );

  it('rejects malformed or missing provider verdicts', async () => {
    const f = fixture();
    Object.assign(f.providers.proof, {
      verify: async () => ({ verified: true, value: f.native }),
    });
    expect(await call(f)).toEqual({
      status: 'indeterminate',
      reason: 'proof:malformed',
    });
  });

  it.each(['OutProofV1', 'OutProofV3', 'SpendProofV1'])(
    'rejects %s',
    async (header) => {
      const f = fixture();
      expect(
        await verifyDeposit(
          encodeIntent(f.intent),
          header + '1'.repeat(132),
          {},
          f.config,
          f.fees,
          f.providers,
        ),
      ).toEqual({ status: 'rejected', reason: 'proof:outbound-v2' });
    },
  );

  it.each([
    ['empty', ''],
    ['length', '1'.repeat(133)],
    ['alphabet', '0'.repeat(132)],
    ['oversize', '1'.repeat(65604)],
  ])('rejects malformed proof body: %s', async (_label, body) => {
    const f = fixture();
    expect(
      await verifyDeposit(
        encodeIntent(f.intent),
        'OutProofV2' + body,
        {},
        f.config,
        f.fees,
        f.providers,
      ),
    ).toEqual({ status: 'rejected', reason: 'proof:encoding' });
  });

  it('keeps identities independent from epoch, txid and block occurrence where required', async () => {
    const first = fixture();
    const a = await call(first);
    expect(a.status).toBe('accepted');
    if (a.status !== 'accepted') throw Error('fixture');
    const next = fixture();
    next.intent.txid =
      next.native.txid =
      next.receipt.txid =
      next.config.snapshot.txid =
        'd'.repeat(64);
    next.receipt.outputs[0].index = 5n;
    next.intent.vault_epoch = next.config.vaultEpoch = 'epoch-2';
    next.native.messageBytes = encodeIntent(next.intent);
    next.config.creditedOutputIds = new Set(
      a.outputs.map((output) => output.economicId),
    );
    expect(await call(next)).toEqual({
      status: 'rejected',
      reason: 'output:already-assigned',
    });
    expect(outputLocator('stagenet', TXID, 0n)).not.toBe(
      outputLocator('stagenet', 'd'.repeat(64), 5n),
    );
    expect(economicOutputIdentity('stagenet', KEY)).not.toBe(
      economicOutputIdentity('mainnet', KEY),
    );
  });

  it('rejects an assigned transaction even with a different output key', async () => {
    const f = fixture();
    f.config.creditedDepositIds = new Set([depositIdentity('stagenet', TXID)]);
    f.receipt.outputs[0].publicKey = 'd'.repeat(64);
    expect(await call(f)).toEqual({
      status: 'rejected',
      reason: 'deposit:already-assigned',
    });
  });

  it('accepts a complete V2 multi-output receipt with exact aggregate amount', async () => {
    const f = multiFixture();
    f.receipt.outputs = [...f.receipt.outputs].reverse(); // chain observer order is irrelevant
    const result = await call(f);
    expect(result).toMatchObject({
      status: 'accepted',
      amount: 1000000000000n,
    });
    if (result.status !== 'accepted') throw Error('fixture');
    expect(result.outputs.map((output) => output.outputIndex)).toEqual([
      0n,
      3n,
    ]);
  });

  it.each([
    [
      'duplicate index',
      (f: Fixture) => {
        f.receipt.outputs[1].index = 0n;
      },
      'output:duplicate-index',
    ],
    [
      'duplicate key',
      (f: Fixture) => {
        f.receipt.outputs[1].publicKey = KEY;
      },
      'output:duplicate-key',
    ],
    [
      'index substitution',
      (f: Fixture) => {
        f.receipt.outputs[1].index = 4n;
      },
      'output:intent-index',
    ],
    [
      'key substitution',
      (f: Fixture) => {
        f.receipt.outputs[1].publicKey = 'e'.repeat(64);
      },
      'output:intent-key',
    ],
    [
      'amount redistribution',
      (f: Fixture) => {
        f.receipt.outputs[0].amount++;
        f.receipt.outputs[1].amount--;
      },
      'output:intent-amount',
    ],
  ] as const)(
    'rejects multi-output %s at its consumer',
    async (_name, mutate, reason) => {
      const f = multiFixture();
      mutate(f);
      expect(await call(f)).toEqual({ status: 'rejected', reason });
    },
  );

  it('does not silently extend historical V1 to multiple outputs', async () => {
    const f = fixture();
    f.receipt.outputs = [
      f.receipt.outputs[0],
      { ...f.receipt.outputs[0], index: 1n, publicKey: 'd'.repeat(64) },
    ];
    expect(await call(f)).toEqual({
      status: 'rejected',
      reason: 'receipt:v1-one-output',
    });
  });

  it('rejects implicit truncation and reports an explicitly retained remainder', async () => {
    const f = fixture();
    f.fees.destinationDecimals = 9;
    expect(await call(f)).toEqual({
      status: 'rejected',
      reason: 'amount:conversion-remainder',
    });
    f.fees.remainder = 'retain';
    expect(await call(f)).toMatchObject({
      status: 'accepted',
      destinationAmount: 999999999n,
      retainedAtomicRemainder: 880n,
    });
  });

  it('rejects destination uint64 overflow without Number conversion', async () => {
    const f = fixture();
    f.intent.amount = MAX_U64.toString();
    f.native.received = f.receipt.outputs[0].amount = MAX_U64;
    f.native.messageBytes = encodeIntent(f.intent);
    f.fees.destinationDecimals = 18;
    expect(await call(f)).toEqual({
      status: 'rejected',
      reason: 'destination_amount:uint64',
    });
  });

  it('rejects fees consuming the deposit and a zero converted destination', async () => {
    const f = fixture();
    f.intent.amount = '120';
    f.native.messageBytes = encodeIntent(f.intent);
    expect(await call(f)).toEqual({
      status: 'rejected',
      reason: 'amount:fees-consume-deposit',
    });
    f.intent.amount = '121';
    f.native.messageBytes = encodeIntent(f.intent);
    f.fees.destinationDecimals = 9;
    f.fees.remainder = 'retain';
    expect(await call(f)).toEqual({
      status: 'rejected',
      reason: 'amount:zero-destination',
    });
  });

  it('returns immutable candidates and projection, preserving evidence limitations', async () => {
    const f = fixture();
    const before = structuredClone([
      f.intent,
      f.native,
      f.receipt,
      f.config,
      f.fees,
    ]);
    const result = await call(f);
    if (result.status !== 'accepted') throw Error('fixture');
    expect([f.intent, f.native, f.receipt, f.config, f.fees]).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.outputs[0])).toBe(true);
    const projection = toRosenObservation(result);
    expect(projection).toMatchObject({
      authority: 'stateless-candidate',
      evidenceMode: 'fixture',
      amountUnit: 'monero-atomic',
      sourceTxId: TXID,
    });
    expect(projection.outputIds).toEqual([
      economicOutputIdentity('stagenet', KEY),
    ]);
    expect(() => toRosenObservation({ ...result })).toThrow(
      'Candidate must come from verifyDeposit',
    );
  });

  it('does not claim atomicity: two calls against the same old view produce candidates only', async () => {
    const f = fixture();
    const results = await Promise.all([call(f), call(f)]);
    expect(results.map((result) => result.status)).toEqual([
      'accepted',
      'accepted',
    ]);
    expect(f.config.creditedOutputIds.size).toBe(0);
    expect(f.config.creditedDepositIds.size).toBe(0);
  });

  it('rechecks expiration on a later verification rather than making acceptance permanent', async () => {
    const f = fixture();
    expect((await call(f)).status).toBe('accepted');
    f.config.snapshot.chainHeight = 121n;
    expect(await call(f)).toEqual({
      status: 'rejected',
      reason: 'intent:expired',
    });
  });

  it('snapshots mutable caller bytes and config across await', async () => {
    const f = fixture();
    const raw = encodeIntent(f.intent);
    f.providers.addresses.verify = async (request) => {
      raw.fill(0);
      f.config.vaultAddress = 'changed';
      f.fees.networkFee = '999999';
      return { status: 'verified', value: request };
    };
    expect(
      await verifyDeposit(raw, PROOF, {}, f.config, f.fees, f.providers),
    ).toMatchObject({
      status: 'accepted',
      vaultAddress: 'synthetic-vault',
      networkFee: 20n,
    });
  });
});
