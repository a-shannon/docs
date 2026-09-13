import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { Migration1789499200000 } from '../guard-service/src/db/migrations/moneroWithdrawal/sqlite/1789499200000-migration';
import { Migration1789499300000 } from '../guard-service/src/db/migrations/moneroWithdrawal/sqlite/1789499300000-migration';
import { WithdrawalJournal, type JournalFault, type WithdrawalJournalAnchor, type FinalWithdrawalRecord } from './withdrawalJournal';
import type { ReservationRecord } from '../guard-service/src/db/moneroWithdrawalReservation';

// Journal-only durable-state fixtures. These values issue no native or agreement authority.
async function fixture(fault?: JournalFault) {
  const directory = mkdtempSync((config.runtimeDirectory+'/journal-')), database = join(directory, 'reservation.sqlite');
  const external = new DataSource({ type: 'sqlite', database, synchronize: false, cache: false, busyErrorRetry: 0, migrations: [Migration1789499200000, Migration1789499300000], logging: false });
  await external.initialize(); await external.runMigrations();
  const requestDigest = '10'.repeat(32), reservationId = '20'.repeat(32);
  const receipt = Object.freeze({ status: 'unapproved-native-intent' as const, signing: 'prohibited' as const, eventId: '30'.repeat(32), instructionDigest: '40'.repeat(32), requestDigest, network: 'testnet', address: 'journal-only-receiver', amount: '17', maxMinerFeeAtomic: '9', necessaryFeeAtomic: '5', inputCount: 2 });
  const reservation: Readonly<ReservationRecord> = Object.freeze({ sourceNetwork: 'testnet', network: 'testnet', vaultSpend: '50'.repeat(32), vaultView: '60'.repeat(32), reservationId, reservationHash: '70'.repeat(32), requestJson: JSON.stringify({ requestDigest }), selectionBytes: 'journal-only-selection-fixture', eventId: receipt.eventId, state: 'completed', owner: '80'.repeat(32), generation: '1', leaseUntil: '1000000', receipt, receiptHash: createHash('sha256').update(JSON.stringify(receipt)).digest('hex') });
  await external.query('INSERT INTO monero_withdrawal_identity VALUES(1,?,?,?,?,?)', [reservation.sourceNetwork, reservation.network, reservation.vaultSpend, reservation.vaultView, '1000']);
  await external.query('INSERT INTO monero_withdrawal_reservation VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [reservation.reservationId, reservation.reservationHash, reservation.requestJson, reservation.selectionBytes, reservation.eventId, reservation.sourceNetwork, reservation.network, reservation.vaultSpend, reservation.vaultView, reservation.state, reservation.owner, reservation.generation, reservation.leaseUntil, JSON.stringify(reservation.receipt), reservation.receiptHash]);
  for (let ordinal = 0; ordinal < 2; ordinal++) await external.query('INSERT INTO monero_withdrawal_output VALUES(?,?,?,?,?,?,?,?,?)', [reservationId, ordinal, 'testnet', String(ordinal + 1).repeat(64), String(ordinal + 3).repeat(64), String(ordinal), String(ordinal + 10), '20', '90'.repeat(32)]);
  const anchor: Readonly<WithdrawalJournalAnchor> = Object.freeze({ reservation, requestDigest, nativeDirectory: directory, descriptorDigest: 'a0'.repeat(32), bindingDigest: 'b0'.repeat(32), expectationDigest: 'c0'.repeat(32), hostGeneration: '1', reservationGeneration: '1' });
  const bytesHex = '010203', final: Readonly<FinalWithdrawalRecord> = Object.freeze({ expectationDigest: anchor.expectationDigest, bindingDigest: anchor.bindingDigest, txId: 'd0'.repeat(32), byteHash: createHash('sha256').update(Buffer.from(bytesHex, 'hex')).digest('hex'), bytesHex });
  let journal = await WithdrawalJournal.open(database, fault);
  return { external, anchor, final, get journal() { return journal; }, reopen: async () => { await journal.close(); journal = await WithdrawalJournal.open(database); }, close: async () => { await journal.close(); await external.destroy(); } };
}
async function exclusion(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal((await f.external.query('SELECT state FROM monero_withdrawal_reservation'))[0].state, 'completed');
  assert.equal((await f.external.query('SELECT COUNT(*) AS n FROM monero_withdrawal_output'))[0].n, 2);
}
test('journal signing/completion survives fresh connection, retains exclusion and copies delivery bytes', async () => {
  const f = await fixture(); try {
    await f.journal.prepare(f.anchor); assert.equal((await f.journal.readByRequestDigest(f.anchor.requestDigest))?.state, 'prepared');
    await f.journal.markSigning(f.anchor.reservation.reservationId); await f.reopen();
    assert.equal((await f.journal.read(f.anchor.reservation.reservationId)).state, 'signing');
    const result = await f.journal.complete(f.anchor.reservation.reservationId, f.final); assert.equal(result.reservationId, f.anchor.reservation.reservationId); assert.equal(result.byteDigest, f.final.byteHash);
    const bytes = result.txBytes; bytes[0] = 99; assert.equal(result.txBytes[0], 1); assert.ok(Object.isFrozen(result));
    await f.reopen(); const entry = await f.journal.read(f.anchor.reservation.reservationId); assert.equal(entry.state, 'completed'); assert.equal(entry.final?.bytesHex, f.final.bytesHex);
    await exclusion(f);
  } finally { await f.close(); }
});
test('duplicate preparation cannot replace the trusted expectation anchor', async () => {
  const f = await fixture(); try {
    await f.journal.prepare(f.anchor);
    await assert.rejects(f.journal.prepare({ ...f.anchor, expectationDigest: 'e0'.repeat(32) }));
    assert.equal((await f.journal.read(f.anchor.reservation.reservationId)).anchor.expectationDigest, f.anchor.expectationDigest); await exclusion(f);
  } finally { await f.close(); }
});
test('signing cannot be taken twice or reset, and quarantine is terminal', async () => {
  const f = await fixture(); try {
    await f.journal.prepare(f.anchor); await f.journal.markSigning(f.anchor.reservation.reservationId);
    await assert.rejects(f.journal.markSigning(f.anchor.reservation.reservationId)); await f.journal.quarantine(f.anchor.reservation.reservationId);
    await assert.rejects(f.journal.complete(f.anchor.reservation.reservationId, f.final)); await assert.rejects(f.journal.markSigning(f.anchor.reservation.reservationId));
    await f.reopen(); assert.equal((await f.journal.read(f.anchor.reservation.reservationId)).state, 'quarantined'); await exclusion(f);
  } finally { await f.close(); }
});
test('exact original completed reservation is checked again before state writes', async () => {
  const f = await fixture(); try {
    await f.journal.prepare(f.anchor); await f.external.query('UPDATE monero_withdrawal_reservation SET owner=?', ['e0'.repeat(32)]);
    await assert.rejects(f.journal.markSigning(f.anchor.reservation.reservationId));
    assert.equal((await f.external.query('SELECT state FROM monero_withdrawal_signing_journal'))[0].state, 'prepared'); await exclusion(f);
  } finally { await f.close(); }
});
test('journal rejects a request digest not bound to the completed construction record', async () => {
  const f = await fixture(); try { assert.throws(() => f.journal.prepare({ ...f.anchor, requestDigest: 'e0'.repeat(32) })); await exclusion(f); } finally { await f.close(); }
});
test('completion requires signing plus exact expected/binding digests and complete-byte hash', async () => {
  const f = await fixture(); try {
    await f.journal.prepare(f.anchor); await assert.rejects(f.journal.complete(f.anchor.reservation.reservationId, f.final)); await f.journal.markSigning(f.anchor.reservation.reservationId);
    for (const change of [{ expectationDigest: 'e0'.repeat(32) }, { bindingDigest: 'e0'.repeat(32) }, { byteHash: 'e0'.repeat(32) }, { txId: '00' }, { bytesHex: '00'.repeat(9409) }]) await assert.rejects(f.journal.complete(f.anchor.reservation.reservationId, { ...f.final, ...change }));
    assert.equal((await f.journal.read(f.anchor.reservation.reservationId)).state, 'signing'); await exclusion(f);
  } finally { await f.close(); }
});
test('completed delivery is immutable and only identical bytes may be returned again', async () => {
  const f = await fixture(); try {
    await f.journal.prepare(f.anchor); await f.journal.markSigning(f.anchor.reservation.reservationId); await f.journal.complete(f.anchor.reservation.reservationId, f.final);
    assert.equal((await f.journal.complete(f.anchor.reservation.reservationId, f.final)).txBytes[0], 1);
    const changed = { ...f.final, bytesHex: '040506', byteHash: createHash('sha256').update(Buffer.from('040506', 'hex')).digest('hex') };
    await assert.rejects(f.journal.complete(f.anchor.reservation.reservationId, changed));
    await assert.rejects(f.external.query("UPDATE monero_withdrawal_signing_journal SET state='signing',finalJson=NULL"));
    await assert.rejects(f.external.query('DELETE FROM monero_withdrawal_signing_journal')); await exclusion(f);
  } finally { await f.close(); }
});
for (const phase of ['prepared', 'signing', 'completed'] as const) test(`${phase} before-commit fault rolls back rather than acknowledges`, async () => {
  const f = await fixture(point => { if (point === `${phase}-before-commit`) throw Error('trusted-fixture-fault'); }); try {
    if (phase === 'prepared') { await assert.rejects(f.journal.prepare(f.anchor)); assert.equal(await f.journal.readIfPresent(f.anchor.reservation.reservationId), null); }
    else {
      await f.journal.prepare(f.anchor);
      if (phase === 'signing') { await assert.rejects(f.journal.markSigning(f.anchor.reservation.reservationId)); assert.equal((await f.journal.read(f.anchor.reservation.reservationId)).state, 'prepared'); }
      else { await f.journal.markSigning(f.anchor.reservation.reservationId); await assert.rejects(f.journal.complete(f.anchor.reservation.reservationId, f.final)); assert.equal((await f.journal.read(f.anchor.reservation.reservationId)).state, 'signing'); }
    }
    await exclusion(f);
  } finally { await f.close(); }
});
test('signing post-commit acknowledgment loss persists signing for independent recovery, never reuse', async () => {
  const f = await fixture(point => { if (point === 'signing-after-commit') throw Error('trusted-fixture-ack-loss'); }); try {
    await f.journal.prepare(f.anchor); await assert.rejects(f.journal.markSigning(f.anchor.reservation.reservationId), /ack-failed-after-commit/);
    await f.reopen(); assert.equal((await f.journal.read(f.anchor.reservation.reservationId)).state, 'signing'); await assert.rejects(f.journal.markSigning(f.anchor.reservation.reservationId)); await exclusion(f);
  } finally { await f.close(); }
});
test('completed post-commit acknowledgment loss preserves the identical durable final', async () => {
  const f = await fixture(point => { if (point === 'completed-after-commit') throw Error('trusted-fixture-ack-loss'); }); try {
    await f.journal.prepare(f.anchor); await f.journal.markSigning(f.anchor.reservation.reservationId); await assert.rejects(f.journal.complete(f.anchor.reservation.reservationId, f.final), /ack-failed-after-commit/);
    await f.reopen(); assert.equal((await f.journal.complete(f.anchor.reservation.reservationId, f.final)).byteDigest, f.final.byteHash); await exclusion(f);
  } finally { await f.close(); }
});
test('SQLite busy writer prevents signing acknowledgment without retry or state advance', async () => {
  const f = await fixture(); try {
    await f.journal.prepare(f.anchor); await f.external.query('BEGIN IMMEDIATE');
    try { await assert.rejects(f.journal.markSigning(f.anchor.reservation.reservationId)); } finally { await f.external.query('ROLLBACK'); }
    assert.equal((await f.journal.read(f.anchor.reservation.reservationId)).state, 'prepared'); await exclusion(f);
  } finally { await f.close(); }
});
test('actual SQLite COMMIT failure provides no acknowledgment and leaves no reusable live attempt', async () => {
  const f = await fixture(); try {
    await f.journal.prepare(f.anchor);
    await f.external.query('BEGIN'); await f.external.query('SELECT state FROM monero_withdrawal_signing_journal');
    try { await assert.rejects(f.journal.markSigning(f.anchor.reservation.reservationId), /commit-indeterminate/); }
    finally { await f.external.query('ROLLBACK'); }
    await assert.rejects(f.journal.read(f.anchor.reservation.reservationId), /indeterminate/);
    await f.reopen(); assert.equal((await f.journal.read(f.anchor.reservation.reservationId)).state, 'prepared'); await exclusion(f);
  } finally { await f.close(); }
});
