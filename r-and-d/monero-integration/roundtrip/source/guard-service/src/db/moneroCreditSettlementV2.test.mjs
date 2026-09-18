import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, unlinkSync, readFileSync} from 'node:fs';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ECDH, randomUUID, createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {MoneroCreditAssignment as Ledger, committeeConfigDigest} from './moneroCreditAssignment.mjs';

const h = n => n.toString(16).padStart(2, '0').repeat(32);
const keys = [1, 2, 3, 4].map(n => {
  const key = ECDH('secp256k1');
  key.setPrivateKey(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));
  return key.getPublicKey('hex', 'compressed');
});
const config = {custodyDomain: 'local-monero-genesis:' + h(1), guardKey: keys[0],
  committeeKeys: keys, quorum: 3, maxFaults: 1, activationId: 'guard-activation-1',
  policyEpoch: '1', policyDigest: h(10), backingPolicy: 'single-deposit-v2'};
const request = () => ({binding: {obligationId: 'deposit', creditTransactionDigest: h(11),
  sourceIntentDigest: h(12), triggerBoxId: h(13), policyDigest: config.policyDigest,
  committeeDigest: committeeConfigDigest(config)}, outputs: [{sourceNetwork: 'mainnet', publicKey: h(14)}],
  backing: {version: 2, genesis: h(1), committeeDigest: h(2), vaultSpend: h(3),
    vaultAddress: 'configured-vault', intentHash: h(12), txId: h(4), blockHash: h(5),
    blockHeight: 4097, outputIndex: 1, globalIndex: 5000, outputKey: h(14), keyImage: h(6),
    amountAtomic: '1000', destinationNetwork: 'ergo-testnet', destinationAsset: h(7),
    recipient: 'configured-recipient', creditedAtomic: '880'}});
const settlement = () => Object.fromEntries(['reservationId', 'reservationHash', 'requestDigest',
  'selectionDigest', 'bindingDigest', 'expectationDigest'].map((name, i) => [name, h(50 + i)]));
const methods = ['reserveSettlement', 'assertSettlement', 'observeSettlement'];
const bytes = file => Object.fromEntries(['', '-wal'].filter(s => existsSync(file + s))
  .map(s => [s, createHash('sha256').update(readFileSync(file + s)).digest('hex')]));
function fixture(t, cfg = config) {
  const file = join(tmpdir(), 'monero-settlement-v2-' + randomUUID() + '.sqlite'), handles = [];
  const track = method => {const ledger = Ledger[method](file, cfg); handles.push(ledger); return ledger;};
  const ledger = track('create');
  t.after(() => {
    for (const handle of handles) handle.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) unlinkSync(file + suffix);
  });
  return {file, ledger, open: () => track('open'), read: () => track('openReadOnly')};
}
function withDb(file, fn) {
  const db = new DatabaseSync(file);
  try {return fn(db);} finally {db.close();}
}
const rows = db => ['metadata', 'claims', 'outputs', 'nullifiers', 'settlements']
  .map(table => db.prepare('SELECT * FROM ' + table).all());

test('v2 reserves one exact tuple durably without changing the original descriptor', t => {
  const f = fixture(t), r = request(), s = settlement(); let ledger = f.ledger;
  ledger.assign(r); const assigned = ledger.checkpoint();
  const result = ledger.reserveSettlement(r, s);
  assert.equal(result.status, 'reserved'); assert.deepEqual(result.settlement, s);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.settlement));
  const reserved = ledger.checkpoint();
  assert.equal(reserved.revision, assigned.revision + 1); assert.equal(reserved.settlements, 1);
  assert.equal(reserved.claims, 1); assert.equal(reserved.outputs, 1); assert.equal(reserved.nullifiers, 1);
  for (const restart of [false, true]) {
    if (restart) {ledger.close(); ledger = f.open();}
    assert.equal(ledger.reserveSettlement(structuredClone(r), structuredClone(s)).status, 'existing');
    assert.deepEqual(ledger.assertSettlement(r, s).settlement, s);
    assert.equal(ledger.observeSettlement(r, s).status, 'assigned');
    assert.deepEqual(ledger.checkpoint(), reserved);
  }
  withDb(f.file, db => {
    const claim = db.prepare('SELECT * FROM claims').get(), retained = db.prepare('SELECT * FROM settlements').get();
    assert.deepEqual(JSON.parse(claim.request).backing, r.backing);
    assert.equal(claim.requestDigest, result.requestDigest);
    assert.equal(claim.settlementDigest, result.settlementDigest);
    assert.equal(retained.settlementDigest, result.settlementDigest);
    assert.deepEqual(JSON.parse(retained.settlement), s);
  });
});

test('each malformed v2 tuple is rejected before the first reservation without claiming it', t => {
  const ledger = fixture(t).ledger, r = request(), s = settlement();
  ledger.assign(r); const before = ledger.checkpoint();
  for (const name of Object.keys(s)) {
    const missing = {...s}; delete missing[name];
    for (const bad of [missing, ...[undefined, null, 1, '', 'ab', 'AB'.repeat(32), 'zz'.repeat(32)]
      .map(value => ({...s, [name]: value}))]) {
      assert.throws(() => ledger.reserveSettlement(r, bad), /settlement:.*(?:schema|hex)/, name);
      assert.deepEqual(ledger.checkpoint(), before, name);
    }
  }
  assert.throws(() => ledger.reserveSettlement(r, {...s, extra: true}), /settlement:schema/);
  assert.deepEqual(ledger.checkpoint(), before);
  assert.equal(ledger.reserveSettlement(r, s).status, 'reserved');
});

test('each v2 tuple field is required, canonical and immutable independently', t => {
  const f = fixture(t), ledger = f.ledger, r = request(), s = settlement();
  ledger.assign(r); ledger.reserveSettlement(r, s); const before = ledger.checkpoint();
  for (const name of Object.keys(s)) {
    const changed = {...s, [name]: h(90)};
    for (const method of methods) assert.throws(() => ledger[method](r, changed), /settlement:conflict/, name);
    const missing = {...s}; delete missing[name];
    for (const bad of [missing, ...[undefined, null, 1, '', 'ab', 'AB'.repeat(32), 'zz'.repeat(32)]
      .map(value => ({...s, [name]: value}))]) {
      for (const method of methods) assert.throws(() => ledger[method](r, bad), /settlement:/, name);
    }
    assert.deepEqual(ledger.checkpoint(), before, name);
  }
  let accessed = false;
  for (const corrupt of [
    value => {value.extra = true;},
    value => Object.defineProperty(value, 'hidden', {value: true}),
    value => Object.defineProperty(value, Symbol('extra'), {value: true}),
    value => Object.setPrototypeOf(value, {inherited: true}),
    value => Object.defineProperty(value, 'reservationId', {enumerable: true, get() {accessed = true; return h(50);}}),
  ]) {
    const bad = settlement(); corrupt(bad);
    for (const method of methods) assert.throws(() => ledger[method](r, bad), /settlement:schema/);
  }
  assert.equal(accessed, false); assert.deepEqual(ledger.checkpoint(), before);
});

test('v2 settlement never assigns absent backing or creates a reservation during observation', t => {
  const ledger = fixture(t).ledger, r = request(), s = settlement(), empty = ledger.checkpoint();
  for (const method of methods) assert.throws(() => ledger[method](r, s), /assignment:missing/);
  assert.deepEqual(ledger.checkpoint(), empty); ledger.assign(r); const assigned = ledger.checkpoint();
  for (const method of ['assertSettlement', 'observeSettlement'])
    assert.throws(() => ledger[method](r, s), /settlement:missing/);
  assert.deepEqual(ledger.checkpoint(), assigned);
  ledger.invalidate(r.binding.obligationId, 'source-reorganization'); const invalidated = ledger.checkpoint();
  for (const method of ['reserveSettlement', 'assertSettlement'])
    assert.throws(() => ledger[method](r, s), /assignment:invalidated/);
  assert.throws(() => ledger.observeSettlement(r, s), /settlement:missing/);
  assert.deepEqual(ledger.checkpoint(), invalidated);
});

test('v2 reservation is bound to every original descriptor and request field', t => {
  const ledger = fixture(t).ledger, r = request(), s = settlement();
  ledger.assign(r); ledger.reserveSettlement(r, s); const before = ledger.checkpoint();
  const changedRequests = [];
  for (const name of Object.keys(r.backing).filter(name => name !== 'version')) {
    const changed = structuredClone(r);
    changed.backing[name] = typeof r.backing[name] === 'number' ? r.backing[name] + 1
      : ['amountAtomic', 'creditedAtomic'].includes(name) ? '999'
      : ['vaultAddress', 'destinationNetwork', 'recipient'].includes(name) ? 'changed' : h(90);
    if (name === 'outputKey') changed.outputs[0].publicKey = changed.backing.outputKey;
    if (name === 'intentHash') changed.binding.sourceIntentDigest = changed.backing.intentHash;
    changedRequests.push([name, changed]);
  }
  for (const name of Object.keys(r.binding)) {
    const changed = structuredClone(r); changed.binding[name] = name === 'obligationId' ? 'other' : h(90);
    changedRequests.push(['binding.' + name, changed]);
  }
  const network = structuredClone(r); network.outputs[0].sourceNetwork = 'stagenet';
  const missing = structuredClone(r); delete missing.backing;
  const version = structuredClone(r); version.backing.version = 1;
  changedRequests.push(['network', network], ['missing backing', missing], ['v1 confusion', version]);
  for (const [label, changed] of changedRequests) {
    for (const method of methods) assert.throws(() => ledger[method](changed, s), undefined, label);
    assert.deepEqual(ledger.checkpoint(), before, label);
  }
});

test('v2 invalidation retains the tuple and P/I across reopen but revokes assert and reserve', t => {
  const f = fixture(t), r = request(), s = settlement(); let ledger = f.ledger;
  ledger.assign(r); ledger.reserveSettlement(r, s); ledger.invalidate(r.binding.obligationId, 'source-reorganization');
  const before = ledger.checkpoint();
  for (const restart of [false, true]) {
    if (restart) {ledger.close(); ledger = f.open();}
    for (const method of ['reserveSettlement', 'assertSettlement'])
      assert.throws(() => ledger[method](r, s), /assignment:invalidated/);
    const retained = ledger.observeSettlement(r, s);
    assert.equal(retained.status, 'invalidated'); assert.equal(retained.reason, 'source-reorganization');
    assert.deepEqual(retained.settlement, s);
    for (const name of Object.keys(s))
      assert.throws(() => ledger.observeSettlement(r, {...s, [name]: h(90)}), /settlement:conflict/, name);
    const sameP = structuredClone(r); sameP.binding.obligationId = 'same-output'; sameP.backing.keyImage = h(90);
    const sameI = structuredClone(r); sameI.binding.obligationId = 'same-image';
    sameI.backing.outputKey = h(90); sameI.outputs[0].publicKey = h(90);
    assert.equal(ledger.assign(sameP).status, 'conflict'); assert.equal(ledger.assign(sameI).status, 'conflict');
    assert.equal(ledger.assign(r).status, 'invalidated'); assert.deepEqual(ledger.checkpoint(), before);
  }
});

test('unbacked custody cannot reserve, assert or observe a settlement', t => {
  const cfg = {...config}; delete cfg.backingPolicy;
  const ledger = fixture(t, cfg).ledger, r = request(); delete r.backing;
  r.binding.committeeDigest = committeeConfigDigest(cfg); ledger.assign(r); const before = ledger.checkpoint();
  for (const method of methods) assert.throws(() => ledger[method](r, settlement()), /settlement:backing-required/);
  assert.deepEqual(ledger.checkpoint(), before);
});

for (const [label, trigger] of [
  ['insert', 'BEFORE INSERT ON settlements'],
  ['claim marker', 'BEFORE UPDATE OF settlementDigest ON claims'],
  ['revision', 'BEFORE UPDATE OF revision ON metadata'],
]) test('v2 ' + label + ' storage failure retains the claim and rolls back the entire reservation', t => {
  const f = fixture(t), r = request(), s = settlement(), ledger = f.ledger; ledger.assign(r);
  const before = ledger.checkpoint();
  withDb(f.file, db => db.exec(`CREATE TRIGGER reject_settlement ${trigger} BEGIN SELECT RAISE(ABORT,'settlement-storage-fault'); END`));
  assert.throws(() => ledger.reserveSettlement(r, s), /settlement-storage-fault/);
  assert.deepEqual(ledger.checkpoint(), before); assert.equal(ledger.assertAssigned(r).status, 'assigned');
  ledger.close(); const reopened = f.open(); assert.deepEqual(reopened.checkpoint(), before);
  withDb(f.file, db => db.exec('DROP TRIGGER reject_settlement'));
  assert.equal(reopened.reserveSettlement(r, s).status, 'reserved');
});

test('competing v2 handles retain only one tuple and identical retry does not bump revision', t => {
  const f = fixture(t), a = f.ledger, b = f.open(), r = request(), s = settlement(); a.assign(r);
  assert.equal(b.reserveSettlement(r, s).status, 'reserved'); const before = a.checkpoint();
  assert.throws(() => a.reserveSettlement(r, {...s, reservationId: h(90)}), /settlement:conflict/);
  assert.equal(a.reserveSettlement(r, s).status, 'existing'); assert.deepEqual(b.checkpoint(), before);
});

test('v2 read-only custody verifies retained settlement integrity without enabling settlement methods', t => {
  const f = fixture(t), r = request(), s = settlement(); f.ledger.assign(r); f.ledger.reserveSettlement(r, s);
  const reader = f.read(), before = reader.checkpoint(), retained = bytes(f.file);
  assert.deepEqual(reader.checkpoint(), f.ledger.checkpoint());
  assert.equal(reader.assertAssigned(r).status, 'assigned');
  for (const method of methods) assert.throws(() => reader[method](r, s), /custody:read-only/);
  assert.deepEqual(reader.checkpoint(), before); assert.deepEqual(bytes(f.file), retained);
});

for (const [label, corrupt] of [
  ['missing tuple', db => db.exec('DELETE FROM settlements')],
  ['missing marker', db => db.exec('UPDATE claims SET settlementDigest=NULL')],
  ['changed marker', db => db.prepare('UPDATE claims SET settlementDigest=?').run(h(90))],
  ['changed tuple digest', db => db.prepare('UPDATE settlements SET settlementDigest=?').run(h(90))],
  ['malformed tuple', db => db.exec("UPDATE settlements SET settlement='{}'")],
  ['missing output', db => db.exec('DELETE FROM outputs')],
  ['missing image', db => db.exec('DELETE FROM nullifiers')],
  ...Object.keys(settlement()).map(name => ['changed retained ' + name, db => {
    const value = JSON.parse(db.prepare('SELECT settlement FROM settlements').get().settlement); value[name] = h(90);
    db.prepare('UPDATE settlements SET settlement=?').run(JSON.stringify(value));
  }]),
]) test('v2 settlement fails closed without repairing or clearing ' + label, t => {
  const f = fixture(t), r = request(), s = settlement(); f.ledger.assign(r); f.ledger.reserveSettlement(r, s);
  const reader = f.read();
  withDb(f.file, db => {
    corrupt(db); const corrupted = rows(db);
    for (const method of methods) assert.throws(() => f.ledger[method](r, s));
    assert.throws(() => reader.checkpoint()); assert.throws(() => reader.assertAssigned(r));
    assert.throws(() => f.open()); assert.throws(() => f.read());
    assert.deepEqual(rows(db), corrupted);
  });
});

test('v2 settlement methods reject changed custody file identity without clearing claims', t => {
  const f = fixture(t), r = request(), s = settlement(); f.ledger.assign(r); f.ledger.reserveSettlement(r, s);
  const before = f.ledger.checkpoint(), original = fs.lstatSync;
  // Exercise the identity discriminant directly; native Windows open-handle
  // replacement behavior is covered separately by moneroCreditNovelty.test.
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    const stat = original(file, ...args);
    // Windows file IDs can exceed the safe-integer range: ino++ may be a no-op.
    if (file === f.file) stat.ino = stat.ino === 0 ? 1 : 0;
    return stat;
  }); syncBuiltinESMExports();
  try {for (const method of methods) assert.throws(() => f.ledger[method](r, s), /custody:file-replaced/);}
  finally {t.mock.restoreAll(); syncBuiltinESMExports();}
  assert.deepEqual(f.ledger.checkpoint(), before);
});
