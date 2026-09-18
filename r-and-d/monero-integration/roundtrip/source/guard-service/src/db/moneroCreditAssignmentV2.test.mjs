import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ECDH, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {MoneroCreditAssignment as Ledger, committeeConfigDigest} from './moneroCreditAssignment.mjs';

const h = n => n.toString(16).padStart(2, '0').repeat(32);
const keys = [1, 2, 3, 4].map(n => {
  const key = ECDH('secp256k1');
  key.setPrivateKey(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));
  return key.getPublicKey('hex', 'compressed');
});
const config = {
  custodyDomain: 'v2-test-custody', guardKey: keys[0], committeeKeys: keys,
  quorum: 3, maxFaults: 1, activationId: 'guard-activation-1', policyEpoch: '1',
  policyDigest: h(10), backingPolicy: 'single-deposit-v2',
};
const request = (obligationId = 'deposit') => ({
  binding: {
    obligationId, creditTransactionDigest: h(11), sourceIntentDigest: h(12),
    triggerBoxId: h(13), policyDigest: config.policyDigest,
    committeeDigest: committeeConfigDigest(config),
  },
  outputs: [{sourceNetwork: 'mainnet', publicKey: h(14)}],
  backing: {
    version: 2, genesis: h(1), committeeDigest: h(2), vaultSpend: h(3),
    vaultAddress: 'configured-vault', intentHash: h(12), txId: h(4),
    blockHash: h(5), blockHeight: 4097, outputIndex: 1, globalIndex: 5000,
    outputKey: h(14), keyImage: h(6), amountAtomic: '1000',
    destinationNetwork: 'ergo-testnet', destinationAsset: h(7),
    recipient: 'configured-recipient', creditedAtomic: '880',
  },
});
function fixture(t) {
  const file = join(tmpdir(), 'monero-credit-v2-' + randomUUID() + '.sqlite');
  const handles = [];
  t.after(() => {
    handles.forEach(handle => handle.close());
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(file + suffix)) unlinkSync(file + suffix);
    }
  });
  return {
    file,
    create: (cfg = config) => { const l = Ledger.create(file, cfg); handles.push(l); return l; },
    open: (cfg = config) => { const l = Ledger.open(file, cfg); handles.push(l); return l; },
  };
}

test('v2 retains the complete descriptor and independent committee bindings across restart', t => {
  const f = fixture(t), r = request();
  assert.notEqual(r.backing.committeeDigest, r.binding.committeeDigest);
  let ledger = f.create();
  assert.equal(ledger.assign(r).status, 'assigned');
  const checkpoint = ledger.checkpoint();
  ledger.close();
  ledger = f.open();
  assert.equal(ledger.assign(structuredClone(r)).status, 'existing');
  assert.equal(ledger.assertAssigned(r).status, 'assigned');
  assert.deepEqual(ledger.checkpoint(), checkpoint);
  const db = new DatabaseSync(f.file);
  try {
    const stored = JSON.parse(db.prepare('SELECT request FROM claims').get().request);
    assert.deepEqual(stored.backing, r.backing);
    assert.equal(db.prepare('SELECT nullifierId FROM nullifiers').get().nullifierId,
      `monero:key-image:${r.backing.genesis}:${r.backing.vaultSpend}:${r.backing.keyImage}`);
    assert.equal(db.prepare('SELECT economicId FROM outputs').get().economicId,
      `monero:output-key:mainnet:${r.backing.outputKey}`);
  } finally { db.close(); }
});

test('v2 closed fields, canonical types and request associations fail before assignment', t => {
  const ledger = fixture(t).create(), r = request(), before = ledger.checkpoint();
  const reject = (change, label) => {
    const changed = structuredClone(r); change(changed);
    assert.throws(() => ledger.assign(changed), undefined, label);
    assert.deepEqual(ledger.checkpoint(), before, label + ': no reservation');
  };
  for (const name of Object.keys(r.backing)) {
    reject(x => { delete x.backing[name]; }, name + ': missing');
    reject(x => { x.backing[name] = null; }, name + ': null');
  }
  for (const name of ['genesis', 'committeeDigest', 'vaultSpend', 'intentHash', 'txId',
    'blockHash', 'outputKey', 'keyImage', 'destinationAsset']) {
    for (const value of ['AB'.repeat(32), 'ab', 'zz'.repeat(32), 1]) {
      reject(x => { x.backing[name] = value; }, name + ': hex');
    }
  }
  for (const name of ['blockHeight', 'outputIndex', 'globalIndex']) {
    for (const value of ['1', -1, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      reject(x => { x.backing[name] = value; }, name + ': safe integer');
    }
  }
  for (const name of ['amountAtomic', 'creditedAtomic']) {
    for (const value of ['0', '01', '-1', '1.0', '18446744073709551616', 1]) {
      reject(x => { x.backing[name] = value; }, name + ': uint64');
    }
  }
  for (const name of ['vaultAddress', 'destinationNetwork', 'recipient']) {
    for (const value of ['', 'x'.repeat(257), 'line\nfeed']) {
      reject(x => { x.backing[name] = value; }, name + ': text');
    }
  }
  reject(x => { x.backing.version = 1; }, 'version');
  reject(x => { x.backing.extra = true; }, 'extra');
  reject(x => { x.backing.outputKey = h(90); }, 'output association');
  reject(x => { x.backing.intentHash = h(90); }, 'intent association');
  reject(x => { x.binding.committeeDigest = x.backing.committeeDigest; }, 'committee role swap');
  reject(x => { x.outputs.push({sourceNetwork: 'mainnet', publicKey: h(90)}); }, 'one output');
  reject(x => { delete x.backing; }, 'mandatory backing');
  let accessed = false;
  for (const corrupt of [
    x => Object.defineProperty(x.backing, 'hidden', {value: true}),
    x => Object.defineProperty(x.backing, Symbol('extra'), {value: true}),
    x => Object.defineProperty(x.backing, 'version', {enumerable: true, get() { accessed = true; return 2; }}),
    x => Object.setPrototypeOf(x.backing, {inherited: true}),
  ]) reject(corrupt, 'plain data only');
  assert.equal(accessed, false);
});

test('every valid v2 descriptor field is immutable after assignment', t => {
  const ledger = fixture(t).create(), r = request(); ledger.assign(r);
  const before = ledger.checkpoint();
  for (const name of Object.keys(r.backing).filter(name => name !== 'version')) {
    const changed = structuredClone(r);
    changed.backing[name] = typeof r.backing[name] === 'number' ? r.backing[name] + 1
      : ['amountAtomic', 'creditedAtomic'].includes(name) ? '999'
      : ['vaultAddress', 'destinationNetwork', 'recipient'].includes(name) ? 'changed' : h(90);
    // Keep these semantic pairs valid: rejection must be the retained exact claim.
    if (name === 'outputKey') changed.outputs[0].publicKey = changed.backing.outputKey;
    if (name === 'intentHash') changed.binding.sourceIntentDigest = changed.backing.intentHash;
    assert.equal(ledger.assign(changed).status, 'conflict', name);
    assert.deepEqual(ledger.checkpoint(), before, name);
  }
});

test('v2 P and I uniqueness survives occurrence, committee changes and invalidation', t => {
  const f = fixture(t), ledger = f.create(), first = request('first');
  ledger.assign(first);
  const sameP = request('other-occurrence');
  Object.assign(sameP.backing, {txId: h(30), blockHash: h(31), blockHeight: 5000,
    outputIndex: 2, globalIndex: 8000, committeeDigest: h(32), keyImage: h(33)});
  const sameI = request('other-output');
  sameI.backing.outputKey = h(34); sameI.outputs[0].publicKey = h(34);
  const before = ledger.checkpoint();
  assert.equal(ledger.assign(sameP).status, 'conflict');
  assert.equal(ledger.assign(sameI).status, 'conflict');
  assert.deepEqual(ledger.checkpoint(), before);
  ledger.invalidate('first', 'source-reorganization');
  const retained = ledger.checkpoint(); ledger.close();
  const reopened = f.open();
  assert.equal(reopened.assign(first).status, 'invalidated');
  assert.equal(reopened.assign(sameP).status, 'conflict');
  assert.equal(reopened.assign(sameI).status, 'conflict');
  assert.deepEqual(reopened.checkpoint(), retained);
  const independent = structuredClone(sameI); independent.backing.keyImage = h(35);
  assert.equal(reopened.assign(independent).status, 'assigned');
});

test('v2 configuration is explicit and never migrates existing v1 or unbacked custody', t => {
  const f = fixture(t), ledger = f.create(); ledger.assign(request()); ledger.close();
  for (const cfg of [{...config, backingPolicy: 'single-deposit-v1'},
    {...config, backingPolicy: 'unknown'}, {...config, policyEpoch: '2'},
    Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'backingPolicy'))]) {
    assert.throws(() => f.open(cfg));
  }
  for (const backingPolicy of ['single-deposit-v1', undefined]) {
    const prior = fixture(t), cfg = {...config};
    if (backingPolicy) cfg.backingPolicy = backingPolicy; else delete cfg.backingPolicy;
    const original = prior.create(cfg); original.close();
    assert.throws(() => prior.open(config), /custody:config-drift/);
  }
});

test('v2 nullifier failure is atomic and v2 does not enable settlement', t => {
  const f = fixture(t), ledger = f.create(), r = request(), db = new DatabaseSync(f.file);
  try {
    db.exec("CREATE TRIGGER reject_image BEFORE INSERT ON nullifiers BEGIN SELECT RAISE(ABORT,'v2-nullifier-fault'); END");
    const before = ledger.checkpoint();
    assert.throws(() => ledger.assign(r), /v2-nullifier-fault/);
    assert.deepEqual(ledger.checkpoint(), before);
    db.exec('DROP TRIGGER reject_image');
  } finally { db.close(); }
  assert.equal(ledger.assign(r).status, 'assigned');
  const settlement = Object.fromEntries(['reservationId', 'reservationHash', 'requestDigest',
    'selectionDigest', 'bindingDigest', 'expectationDigest'].map((name, i) => [name, h(50 + i)]));
  const before = ledger.checkpoint();
  for (const method of ['reserveSettlement', 'assertSettlement', 'observeSettlement']) {
    assert.throws(() => ledger[method](r, settlement), /settlement:profile/);
  }
  assert.deepEqual(ledger.checkpoint(), before);
});
