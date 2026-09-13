import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, mkdtempSync, openSync, closeSync, fstatSync, readSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MoneroWithdrawalReservation, type ReservationRecord, type ReservationFaultPoint } from '../guard-service/src/db/moneroWithdrawalReservation';
import { captureUnapprovedMoneroPayoutRequest } from '../guard-service/src/withdrawal/moneroWithdrawalNativeProjection';
import { decodeNativeSelection, publicHex } from '../guard-service/src/withdrawal/moneroWithdrawalSelection';
import { nativePin } from './nativePin';
import { decimal, frame, canonical, hex, ResponseFramer, U64 } from './codec';
import { AbsolutePhaseDeadline, RetainedFramer, retainedRequest, retainedReceipt, positive, digest } from './retainedCodec';
import { bindVerifiedAgreement, captureAuthority, decodeApprovalDescriptor, ownData, type WithdrawalAuthorityProfile, type NativeApprovalDescriptor, type ApprovedNativeSummary } from './approvalAuthority';
import type { VerifiedAgreementSnapshot } from '../guard-service/src/agreement/txAgreement';
import { WithdrawalJournal, validateFinalRecord, type WithdrawalJournalAnchor, type FinalWithdrawalRecord, type CompletedWithdrawal, type JournalFault } from './withdrawalJournal';

export interface RetainedWithdrawalSetup {
  readonly database: string;
  readonly clock: () => bigint;
  readonly leaseDuration: bigint;
  readonly monotonicNow?: () => number;
  readonly fault?: (point: ReservationFaultPoint) => void | Promise<void>;
}
export interface AuthorizedWithdrawalSetup extends RetainedWithdrawalSetup {
  readonly authority: WithdrawalAuthorityProfile;
  readonly journalFault?: JournalFault;
}
type RetainedSnapshot = Readonly<ReturnType<typeof frame> & {
  json: string; recipient: string; payment: bigint; input: bigint; change: bigint;
  fee: bigint; ceiling: bigint; spend: string; view: string; count: number; live: () => void;
}>;
type RetainedOwner = Readonly<{
  snapshot: RetainedSnapshot;
  close: () => Promise<void>;
  approve?: (receipt: unknown) => Promise<Readonly<ApprovedNativeSummary>>;
  sign?: () => Promise<Readonly<CompletedWithdrawal>>;
}>;

/** Captures trusted own-data setup synchronously, before adapter's first await. */
export function prepareAuthorizedWithdrawal(setup: AuthorizedWithdrawalSetup) {
  const captured = ownData(setup);
  const allowed = ['database', 'clock', 'leaseDuration', 'monotonicNow', 'fault', 'authority', 'journalFault'];
  if (Object.keys(captured).some(k => !allowed.includes(k)) || ['database', 'clock', 'leaseDuration', 'authority'].some(k => !Object.hasOwn(captured, k))) throw Error('authority:setup-schema');
  const profile = captureAuthority(captured.authority);
  if (captured.journalFault !== undefined && typeof captured.journalFault !== 'function') throw Error('authority:journal-fault');
  const profileJson = JSON.stringify(profile);
  const current = () => {
    const now = ownData(setup);
    if (Object.keys(now).length !== Object.keys(captured).length || Object.keys(captured).some(k => !Object.hasOwn(now, k) || now[k] !== captured[k]) || JSON.stringify(captureAuthority(now.authority)) !== profileJson) throw Error('authority:profile-changed');
  };
  const immutableSetup = Object.freeze({ database: captured.database, clock: captured.clock, leaseDuration: captured.leaseDuration, monotonicNow: captured.monotonicNow, fault: captured.fault }) as RetainedWithdrawalSetup;
  return (requestValue: unknown, hostGeneration: bigint, generationLive: () => void, ownClose: (close: () => Promise<void>) => void, onRevoke: () => void, signal?: AbortSignal) => {
    current();
    return openWithdrawal(requestValue, immutableSetup, hostGeneration, generationLive, ownClose, onRevoke, signal, { profile, current, journalFault: captured.journalFault as JournalFault | undefined });
  };
}

/** Holds data privately; only adapter's module-private admission can brand a payment. */
export async function openRetainedWithdrawal(requestValue: unknown, setup: RetainedWithdrawalSetup, hostGeneration: bigint, generationLive: () => void, ownClose: (close: () => Promise<void>) => void, onRevoke: () => void, signal?: AbortSignal) {
  return openWithdrawal(requestValue, setup, hostGeneration, generationLive, ownClose, onRevoke, signal);
}
async function openWithdrawal(requestValue: unknown, setup: RetainedWithdrawalSetup, hostGeneration: bigint, generationLive: () => void, ownClose: (close: () => Promise<void>) => void, onRevoke: () => void, signal?: AbortSignal, authority?: Readonly<{ profile: Readonly<WithdrawalAuthorityProfile>; current: () => void; journalFault?: JournalFault }>): Promise<RetainedOwner> {
  generationLive();
  if (signal?.aborted) throw Error('retained:cancelled');
  positive(hostGeneration.toString());
  // Capture trusted setup once; it never supplies a replacement registry.
  const { database, clock, leaseDuration, fault, monotonicNow } = setup;
  if (!isAbsolute(database) || typeof clock !== 'function' || typeof leaseDuration !== 'bigint' || leaseDuration <= 0n || leaseDuration > U64 || (fault !== undefined && typeof fault !== 'function') || (monotonicNow !== undefined && typeof monotonicNow !== 'function')) throw Error('retained:setup');
  const phaseDeadline = new AbsolutePhaseDeadline(monotonicNow ?? performance.now.bind(performance));
  const projection = await captureUnapprovedMoneroPayoutRequest(requestValue);
  generationLive(); if (signal?.aborted) throw Error('retained:cancelled');
  authority?.current();
  const wire = authority ? 'W1HD' : 'W1HC';
  const request = retainedRequest(projection, randomBytes(32).toString('hex'));
  if (createHash('sha256').update(readFileSync(nativePin.path)).digest('hex') !== nativePin.sha256) throw Error('Native pin mismatch');
  const runtime = mkdtempSync(join(nativePin.runtime, 'retained-'));
  const child = spawn(nativePin.path, [runtime], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let revoked = false, exited = false, stderrSize = 0;
  let registry: MoneroWithdrawalReservation | undefined;
  let phase: 'offer' | 'waiting' | 'result' | 'held' | 'expectation' | 'final' = 'offer';
  let framer = new RetainedFramer(4, 147456);
  let wake: ((rows: string[]) => void) | undefined;
  let rejectFrame: ((error: Error) => void) | undefined;
  let pending: string[] | undefined;
  let exitResolve!: () => void;
  const closed = new Promise<void>(resolve => { exitResolve = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invalidate = () => { revoked = true; onRevoke(); rejectFrame?.(Error('retained:revoked')); rejectFrame = undefined; wake = undefined; };
  const fail = () => { invalidate(); if (!exited) child.kill(); };
  const live = () => { generationLive(); phaseDeadline.check(); if (revoked || signal?.aborted || child.exitCode !== null || child.signalCode !== null) throw Error('retained:owner-retired'); };
  const deadline = () => { phaseDeadline.start(); if (timer) clearTimeout(timer); timer = setTimeout(fail, 180000); };
  const close = async () => {
    invalidate(); phaseDeadline.clear(); if (timer) clearTimeout(timer);
    if (!exited) {
      child.stdin.end('STOP\n');
      const killTimer = setTimeout(() => { if (!exited) child.kill(); }, 2000);
      await closed; clearTimeout(killTimer);
    }
    if (registry) { const owned = registry; registry = undefined; await owned.close(); }
  };
  const abort = () => { void close().catch(() => undefined); };
  ownClose(close);
  signal?.addEventListener('abort', abort, { once: true });
  child.once('error', fail); child.stdin.on('error', fail);
  child.stdout.on('error', fail); child.stderr.on('error', fail);
  child.once('exit', invalidate);
  child.once('close', () => { exited = true; invalidate(); if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); exitResolve(); });
  child.stderr.on('data', (raw: Buffer) => { stderrSize += raw.length; if (stderrSize > 4096) fail(); });
  child.stdout.on('data', (raw: Buffer) => {
    try {
      live(); if (phase === 'waiting' || phase === 'held') throw Error('retained:late-data');
      const rows = framer.push(raw); if (!rows) return;
      phaseDeadline.check();
      if (phase === 'offer') { phase = 'waiting'; deadline(); }
      else { phase = 'held'; phaseDeadline.clear(); if (timer) clearTimeout(timer); }
      if (wake) { const resolve = wake; wake = undefined; rejectFrame = undefined; resolve(rows); }
      else pending = rows;
    } catch { fail(); }
  });
  const read = async () => {
    live();
    if (pending) { const rows = pending; pending = undefined; return rows; }
    return new Promise<string[]>((resolve, reject) => { wake = resolve; rejectFrame = reject; });
  };
  try {
    deadline();
    const query = [wire + 'Q1', hostGeneration.toString(), request.hex, ''].join('\n');
    if (query.length > 8192) throw Error('retained:query-size');
    child.stdin.write(query, 'ascii');
    const offer = await read(); live();
    if (offer[0] !== wire + 'O1' || offer[1] !== hostGeneration.toString() || offer[2] !== request.hex) throw Error('retained:offer-binding');
    const selectionBytes = hex(offer[3], 65536);
    const selection = decodeNativeSelection(selectionBytes.toString('ascii'));
    if (!selection.bytes.startsWith('WMNS2\n') || Buffer.from(selection.bytes, 'ascii').toString('hex') !== offer[3] || selection.network !== projection.network) throw Error('retained:selection-binding');
    // Offer-to-grant began at frame reception, before this continuation.
    registry = await MoneroWithdrawalReservation.open(database, { sourceNetwork: projection.sourceNetwork, network: 'testnet', vaultSpend: selection.vaultSpend, vaultView: selection.vaultView }, clock, fault);
    live();
    const reserved = await registry.reserve(projection.request, selection.bytes); live();
    if ((reserved.status !== 'created' && reserved.status !== 'existing') || reserved.reservation.state === 'completed') throw Error('retained:reservation-not-fresh');
    const owner = randomBytes(32).toString('hex');
    const claim = await registry.claim(reserved.reservation.reservationId, owner, leaseDuration); live();
    if (claim.status !== 'claimed') throw Error('retained:claim-rejected');
    let callbacks = 0;
    let granted: Readonly<ReservationRecord> | undefined;
    let receipt: ReturnType<typeof retainedReceipt> | undefined;
    let candidate: string[] | undefined;
    let descriptor: Readonly<NativeApprovalDescriptor> | undefined;
    const completion = await registry.construct(claim.fence, async record => {
      live(); if (++callbacks !== 1 || record.state !== 'claimed' || record.requestJson !== JSON.stringify(projection.request) || record.selectionBytes !== selection.bytes || record.reservationId !== reserved.reservation.reservationId || record.reservationHash !== reserved.reservation.reservationHash || record.owner !== owner || record.eventId !== projection.eventId || record.sourceNetwork !== projection.sourceNetwork || record.network !== projection.network || record.vaultSpend !== selection.vaultSpend || record.vaultView !== selection.vaultView) throw Error('retained:grant-binding');
      granted = Object.freeze({ ...record });
      [record.reservationId, record.reservationHash, record.owner].forEach(x => publicHex(x, 'grant'));
      positive(record.generation); positive(record.leaseUntil);
      const grant = [wire + 'G1', hostGeneration.toString(), request.hex, offer[3], record.reservationId, record.reservationHash, record.owner, record.generation, record.leaseUntil, ''].join('\n');
      if (grant.length > 147456) throw Error('retained:grant-size');
      phase = 'result'; framer = new RetainedFramer(authority ? 12 : 11, 65536); deadline();
      child.stdin.write(grant, 'ascii');
      const rows = await read(); live();
      const expected = [wire + 'R1', hostGeneration.toString(), record.reservationId, record.reservationHash, record.owner, record.generation, record.leaseUntil, request.hex, digest(selection.bytes)];
      if (expected.some((value, i) => rows[i] !== value)) throw Error('retained:result-binding');
      receipt = retainedReceipt(rows[9], projection, request.fields, selection.inputs.length);
      candidate = new ResponseFramer().push(hex(rows[10], 18000));
      if (!candidate || candidate[0] !== 'W1HA1' || candidate[1] !== request.fields[0] || candidate[2] !== hostGeneration.toString()) throw Error('retained:candidate-correlation');
      const f = frame(candidate[3]);
      const [payment, input, change, fee, ceiling] = candidate.slice(5, 10).map(decimal);
      publicHex(candidate[10], 'candidate:spend'); publicHex(candidate[11], 'candidate:view');
      const count = decimal(candidate[12]);
      const inputSum = selection.inputs.reduce((sum, value) => sum + BigInt(value.amount), 0n);
      if (f.eventId !== projection.eventId || candidate[4] !== projection.address || payment !== BigInt(projection.amount) || ceiling !== BigInt(projection.ceiling) || fee !== BigInt(receipt.necessaryFeeAtomic) || input !== inputSum || input > U64 || input !== payment + change + fee || candidate[10] !== selection.vaultSpend || candidate[11] !== selection.vaultView || count !== BigInt(selection.inputs.length)) throw Error('retained:candidate-binding');
      if (authority) {
        authority.current();
        if (f.bytes.subarray(71, 103).toString('hex') !== projection.instructionDigest || f.bytes.subarray(103, 135).toString('hex') !== projection.requestDigest) throw Error('authority:candidate-request');
        descriptor = decodeApprovalDescriptor(rows[11], { ...f, recipient: candidate[4], payment, input, change, fee, ceiling, spend: candidate[10], view: candidate[11], count: Number(count) }, authority.profile);
      }
      live(); return receipt;
    });
    live();
    if (callbacks !== 1 || !granted || !receipt || !candidate || completion.status !== 'completed') throw Error('retained:no-current-commit');
    const committed = completion.reservation;
    for (const key of Object.keys(granted) as (keyof ReservationRecord)[]) {
      if (key === 'state' || key === 'receipt' || key === 'receiptHash') continue;
      if (committed[key] !== granted[key]) throw Error('retained:commit-binding');
    }
    if (committed.state !== 'completed' || JSON.stringify(committed.receipt) !== JSON.stringify(receipt) || committed.receiptHash !== createHash('sha256').update(JSON.stringify(receipt)).digest('hex')) throw Error('retained:commit-receipt');
    const ownedRegistry = registry; registry = undefined; await ownedRegistry.close(); live();
    const f = frame(candidate[3]);
    const [payment, input, change, fee, ceiling] = candidate.slice(5, 10).map(decimal);
    const snapshot = Object.freeze({ ...f, json: canonical(f.eventId, candidate[3], f.id), recipient: candidate[4], payment, input, change, fee, ceiling, spend: candidate[10], view: candidate[11], count: Number(decimal(candidate[12])), live });
    if (!authority) return Object.freeze({ snapshot, close });
    authority.current();
    if (!descriptor) throw Error('authority:no-owned-descriptor');
    const heldDescriptor = descriptor;
    const heldCommit = Object.freeze({ ...committed });
    // This capability remains lexical, with its exact same live native owner.
    let approvalStarted = false;
    let approvedContext: Readonly<{ verified: Readonly<VerifiedAgreementSnapshot>; agreementCurrent: () => void; descriptor: Readonly<NativeApprovalDescriptor>; reservation: Readonly<ReservationRecord>; hostGeneration: bigint; candidateJson: string; requestHex: string; selectionDigest: string; summary: Readonly<ApprovedNativeSummary> }> | undefined;
    const approve = async (receiptValue: unknown): Promise<Readonly<ApprovedNativeSummary>> => {
      if (approvalStarted) throw Error('authority:approval-used');
      approvalStarted = true;
      try {
        live(); authority.current();
        // Lazy import preserves W1HC's existing runtime closure. No supplied verifier.
        const { consumeVerifiedAgreement, assertVerifiedAgreementCurrent } = await import('../guard-service/src/agreement/txAgreement');
        live(); authority.current();
        const verified = consumeVerifiedAgreement(receiptValue);
        const agreementCurrent = () => { assertVerifiedAgreementCurrent(verified); };
        agreementCurrent();
        const txDataHash = bindVerifiedAgreement(verified, projection.request.canonicalRequest, snapshot.json, snapshot.id, authority.profile);
        live(); authority.current();
        const bindingDigest = createHash('sha256').update('W1hd/private-approved-owner/v1\0', 'utf8').update(JSON.stringify({ requestDigest: projection.requestDigest, instructionDigest: projection.instructionDigest, txDataHash, certificate: verified.certificate, descriptor: heldDescriptor.bytesHex, reservationId: heldCommit.reservationId, reservationHash: heldCommit.reservationHash, reservationGeneration: heldCommit.generation, reservationOwner: heldCommit.owner, leaseUntil: heldCommit.leaseUntil, receiptHash: heldCommit.receiptHash, hostGeneration: hostGeneration.toString(), selectionDigest: digest(selection.bytes), body: f.bytes.subarray(139, 139 + f.bytes.readUInt32LE(135)).toString('hex'), message: f.bytes.subarray(-64, -32).toString('hex') })).digest('hex');
        const summary: Readonly<ApprovedNativeSummary> = Object.freeze({ status: 'approved-retained-native', requestDigest: projection.requestDigest, txDataHash, descriptorDigest: heldDescriptor.digest, bindingDigest });
        approvedContext = Object.freeze({ verified, agreementCurrent, descriptor: heldDescriptor, reservation: heldCommit, hostGeneration, candidateJson: snapshot.json, requestHex: request.hex, selectionDigest: digest(selection.bytes), summary });
        if (!approvedContext) throw Error('authority:no-private-context');
        return summary;
      } catch (error) { approvedContext = undefined; await close(); throw error; }
    };
    let signStarted = false;
    const sign = async (): Promise<Readonly<CompletedWithdrawal>> => {
      if (signStarted) throw Error('sign:one-use');
      signStarted = true;
      const context = approvedContext; approvedContext = undefined;
      let journal: WithdrawalJournal | undefined;
      let journalAttempted = false;
      const signingLive = () => { if (!context) throw Error('sign:unapproved'); context.agreementCurrent(); authority.current(); live(); };
      try {
        signingLive();
        const preparation = ['W1HDP1', context!.hostGeneration.toString(), context!.requestHex, context!.reservation.reservationId, context!.reservation.reservationHash, context!.reservation.owner, context!.reservation.generation, context!.reservation.leaseUntil, context!.selectionDigest, context!.descriptor.digest, context!.summary.bindingDigest, ''].join('\n');
        if (preparation.length > 8192) throw Error('sign:preparation-size');
        phase = 'expectation'; framer = new RetainedFramer(3, 137); deadline();
        signingLive(); child.stdin.write(preparation, 'ascii');
        const expected = await read(); signingLive();
        if (expected[0] !== 'W1HDE1' || expected[2] !== context!.summary.bindingDigest) throw Error('sign:expectation-binding');
        hex(expected[1], 32, 32); hex(expected[2], 32, 32);
        const expectationPath = join(runtime, 'expectation.private');
        if (createHash('sha256').update(boundedPrivateFile(expectationPath, 65536)).digest('hex') !== expected[1]) throw Error('sign:expectation-custody');
        signingLive();
        const anchor: Readonly<WithdrawalJournalAnchor> = Object.freeze({ reservation: context!.reservation, requestDigest: projection.requestDigest, nativeDirectory: runtime, descriptorDigest: context!.descriptor.digest, bindingDigest: context!.summary.bindingDigest, expectationDigest: expected[1], hostGeneration: context!.hostGeneration.toString(), reservationGeneration: context!.reservation.generation });
        journal = await WithdrawalJournal.open(database, authority.journalFault); signingLive();
        journalAttempted = true;
        await journal.prepare(anchor); signingLive();
        const signing = await journal.markSigning(context!.reservation.reservationId); signingLive();
        if (signing.state !== 'signing' || JSON.stringify(signing.anchor) !== JSON.stringify(anchor)) throw Error('sign:journal-ack');
        const command = ['W1HDS1', anchor.expectationDigest, anchor.bindingDigest, ''].join('\n');
        if (command.length !== 137) throw Error('sign:command-size');
        phase = 'final'; framer = new RetainedFramer(6, 32768); deadline();
        signingLive(); child.stdin.write(command, 'ascii');
        const rows = await read(); signingLive();
        const final = finalResponse(rows, anchor);
        const completed = await journal.complete(context!.reservation.reservationId, final); signingLive();
        await journal.close(); journal = undefined; signingLive();
        await close();
        context!.agreementCurrent(); authority.current(); generationLive();
        if (signal?.aborted) throw Error('sign:cancelled-after-completion');
        return completed;
      } catch (error) {
        await close();
        if (journal) { await journal.close(); journal = undefined; }
        if (journalAttempted) {
          if (!existsSync(join(runtime, 'terminal.private'))) await quarantineJournal(database, heldCommit.reservationId);
          else {
            // Presence is not completion. The separate no-sign recovery path classifies it.
            // Never expose recovered bytes through this failed invocation's delivery path.
            try { await recoverRetainedWithdrawal(database, heldCommit.reservationId); }
            catch { await quarantineJournal(database, heldCommit.reservationId); }
          }
        }
        throw error;
      }
    };
    return Object.freeze({ snapshot, close, approve, sign });
  } catch (error) {
    await close(); throw error;
  }
}

function finalResponse(rows: string[], anchor: Readonly<WithdrawalJournalAnchor>): Readonly<FinalWithdrawalRecord> {
  if (rows.length !== 6 || rows[0] !== 'W1HDF1') throw Error('sign:final-framing');
  return validateFinalRecord({ expectationDigest: rows[1], bindingDigest: rows[2], txId: rows[3], byteHash: rows[4], bytesHex: rows[5] }, anchor);
}
async function quarantineJournal(database: string, reservationId: string) {
  const owned = await WithdrawalJournal.open(database);
  try {
    const entry = await owned.readIfPresent(reservationId);
    if (entry?.state === 'prepared' || entry?.state === 'signing') await owned.quarantine(reservationId);
  } finally { await owned.close(); }
}
function boundedPrivateFile(path: string, maximum: number): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size < 1 || size > maximum) throw Error('sign:private-file-size');
    const bytes = Buffer.alloc(maximum + 1), count = readSync(fd, bytes, 0, maximum + 1, 0);
    if (count !== size || fstatSync(fd).size !== size) throw Error('sign:private-file-changed');
    return bytes.subarray(0, count);
  } catch { throw Error('sign:private-file-unavailable'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Reads a durable anchor independently. Recovery has no live signing authority path. */
export async function recoverRetainedWithdrawal(database: string, reservationId: string, signal?: AbortSignal): Promise<Readonly<CompletedWithdrawal>> {
  let journal: WithdrawalJournal | undefined = await WithdrawalJournal.open(database);
  let signing = false;
  try {
    const entry = await journal.read(reservationId); signing = entry.state === 'signing';
    if (entry.state !== 'signing' && entry.state !== 'completed') throw Error('recovery:not-deliverable');
    if (signal?.aborted) throw Error('recovery:cancelled');
    if (createHash('sha256').update(readFileSync(nativePin.path)).digest('hex') !== nativePin.sha256) throw Error('recovery:native-pin');
    const child = spawn(nativePin.path, ['--recover', entry.anchor.nativeDirectory, entry.anchor.expectationDigest], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const rows = await new Promise<string[]>((resolve, reject) => {
      const framer = new RetainedFramer(6, 32768), deadline = new AbsolutePhaseDeadline(performance.now.bind(performance));
      deadline.start(); let result: string[] | undefined, stderrSize = 0, failed = false;
      const fail = () => { failed = true; child.kill(); };
      const abort = () => { fail(); };
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(fail, 180000);
      child.once('error', fail); child.stdout.on('error', fail); child.stderr.on('error', fail);
      child.stderr.on('data', (raw: Buffer) => { stderrSize += raw.length; if (stderrSize > 4096) fail(); });
      child.stdout.on('data', (raw: Buffer) => { try { deadline.check(); if (failed || signal?.aborted) throw Error('recovery:cancelled'); const complete = framer.push(raw); if (complete) result = complete; } catch { fail(); } });
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        try { deadline.check(); if (failed || signal?.aborted || code !== 0 || !result) throw Error('recovery:terminal-invalid'); resolve(result); } catch { reject(Error('recovery:terminal-invalid')); }
      });
    });
    if (signal?.aborted) throw Error('recovery:cancelled');
    const final = finalResponse(rows, entry.anchor);
    const completed = await journal.complete(reservationId, final);
    if (signal?.aborted) throw Error('recovery:cancelled');
    await journal.close(); journal = undefined;
    return completed;
  } catch (error) {
    if (journal) { await journal.close(); journal = undefined; }
    if (signing) await quarantineJournal(database, reservationId);
    throw error;
  }
}
