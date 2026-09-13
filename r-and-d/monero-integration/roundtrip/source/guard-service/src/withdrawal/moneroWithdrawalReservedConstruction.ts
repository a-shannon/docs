import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import type { MoneroWithdrawalReservation } from '../db/moneroWithdrawalReservation';
import {
  captureUnapprovedMoneroPayoutRequest,
  type CapturedMoneroPayout,
  type NativeIntentCommand,
} from './moneroWithdrawalNativeProjection';
import {
  canonicalUint,
  decodeNativeSelection,
  ownData,
  publicHex,
  SELECTION_FRAME_BYTES,
  validateConstructionReceipt,
} from './moneroWithdrawalSelection';

function captureCommand(raw: NativeIntentCommand) {
  const captured = ownData(raw, ['file', 'args'], 'command');
  if (
    typeof captured.file !== 'string' ||
    !captured.file.length ||
    captured.file.includes('\0') ||
    !Array.isArray(captured.args) ||
    captured.args.length > 16 ||
    Reflect.ownKeys(captured.args).length !== captured.args.length + 1
  )
    throw Error('command:shape');
  const args = Array.from({ length: captured.args.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      captured.args,
      `${index}`,
    );
    if (
      !descriptor ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.length > 4096 ||
      descriptor.value.includes('\0')
    )
      throw Error('command:args');
    return descriptor.value as string;
  });
  return { file: captured.file, args };
}

function requestWire(projection: CapturedMoneroPayout) {
  const fields = [
    randomBytes(32).toString('hex'),
    projection.eventId,
    projection.instructionDigest,
    projection.requestDigest,
    projection.network,
    projection.address,
    projection.amount,
    projection.ceiling,
  ];
  fields.slice(0, 4).forEach((field) => publicHex(field, 'request'));
  if (!['mainnet', 'testnet', 'stagenet'].includes(projection.network))
    throw Error('request:network');
  if (!/^[1-9A-HJ-NP-Za-km-z]{1,256}$/.test(projection.address))
    throw Error('request:address');
  const wire = ['WMNI1', ...fields, ''].join('\n');
  if (wire.length > 2048) throw Error('request:wire');
  return { fields, wire, hex: Buffer.from(wire, 'ascii').toString('hex') };
}

/** The configured executable is a trusted local dependency; all I/O is bounded. */
async function openSelection(
  projection: CapturedMoneroPayout,
  command: ReturnType<typeof captureCommand>,
) {
  const request = requestWire(projection);
  const child = spawn(command.file, command.args, {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffered = Buffer.alloc(0);
  let total = 0;
  let stderrTotal = 0;
  let exited = false;
  let phase: 'offer' | 'waiting' | 'result' = 'offer';
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const abort = (reason: string) => {
    failure ??= Error(reason);
    child.kill();
    wake?.();
  };
  const timer = setTimeout(() => abort('native:timeout'), 30000);
  child.on('error', () => abort('native:process'));
  child.stdin.on('error', () => abort('native:stdin'));
  child.stdout.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (total > SELECTION_FRAME_BYTES || phase === 'waiting') {
      abort('native:unexpected-output');
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    wake?.();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTotal += chunk.length;
    if (stderrTotal > SELECTION_FRAME_BYTES) abort('native:stderr-limit');
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once('close', (code) => {
      exited = true;
      clearTimeout(timer);
      wake?.();
      resolve(code);
    });
  });
  const stop = async () => {
    if (!exited) child.kill();
    await closed;
  };
  const readFrame = (lineCount: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (failure) {
          wake = undefined;
          reject(failure);
          return;
        }
        let boundary = -1;
        for (let index = 0; index < lineCount; ++index) {
          boundary = buffered.indexOf(10, boundary + 1);
          if (boundary < 0) break;
        }
        if (boundary >= 0) {
          const frame = buffered.subarray(0, boundary + 1);
          buffered = buffered.subarray(boundary + 1);
          wake = undefined;
          if (frame.some((byte) => byte !== 10 && (byte < 33 || byte > 126)))
            reject(Error('native:framing'));
          else resolve(frame.toString('ascii'));
        } else if (exited) {
          wake = undefined;
          reject(Error('native:truncated'));
        }
      };
      wake = check;
      check();
    });
  child.stdin.write(request.wire, 'ascii');
  try {
    const offer = (await readFrame(3)).split('\n');
    phase = 'waiting';
    if (
      buffered.length ||
      offer[0] !== 'WMNO1' ||
      offer[1] !== request.hex ||
      !/^(?:[0-9a-f]{2})+$/.test(offer[2])
    )
      throw Error('native:offer');
    const selection = decodeNativeSelection(
      Buffer.from(offer[2], 'hex').toString('ascii'),
    );
    // Buffer's ASCII decoder clears high bits; require byte-exact round trip.
    if (
      Buffer.from(selection.bytes, 'ascii').toString('hex') !== offer[2] ||
      selection.network !== projection.network
    )
      throw Error('native:selection');
    let granted = false;
    return {
      selection,
      stop,
      async construct(reservationId: string, generation: string) {
        if (granted || failure || exited) throw Error('native:unavailable');
        publicHex(reservationId, 'grant:reservation');
        if (canonicalUint(generation, 'grant:generation') === '0')
          throw Error('grant:generation');
        const grant = [
          'WMNG1',
          request.hex,
          offer[2],
          generation,
          reservationId,
          '',
        ].join('\n');
        if (grant.length > SELECTION_FRAME_BYTES) throw Error('grant:size');
        granted = true;
        phase = 'result';
        child.stdin.end(grant, 'ascii');
        const result = (await readFrame(13)).split('\n');
        const code = await closed;
        if (failure || code !== 0 || buffered.length || result[0] !== 'WMNR1')
          throw Error('native:result');
        for (let index = 0; index < request.fields.length; ++index)
          if (result[index + 1] !== request.fields[index])
            throw Error(`native:binding:${index + 1}`);
        return validateConstructionReceipt(
          {
            status: result[11],
            signing: result[12],
            eventId: projection.eventId,
            instructionDigest: projection.instructionDigest,
            requestDigest: projection.requestDigest,
            network: projection.network,
            address: projection.address,
            amount: projection.amount,
            maxMinerFeeAtomic: projection.ceiling,
            necessaryFeeAtomic: result[9],
            inputCount: Number(canonicalUint(result[10], 'native:input-count')),
          },
          projection,
          selection.inputs.length,
        );
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Read a public selection without granting construction or creating ownership. */
export async function inspectUnapprovedMoneroSelection(
  requestValue: unknown,
  nativeCommand: NativeIntentCommand,
) {
  const command = captureCommand(nativeCommand);
  const projection = await captureUnapprovedMoneroPayoutRequest(requestValue);
  const session = await openSelection(projection, command);
  try {
    return session.selection;
  } finally {
    await session.stop();
  }
}

/** Actual native offer -> committed reservation/claim -> one-shot native grant. */
export async function constructReservedMoneroWithdrawal(
  registry: MoneroWithdrawalReservation,
  requestValue: unknown,
  nativeCommand: NativeIntentCommand,
  owner: string,
  leaseDuration: bigint,
) {
  const command = captureCommand(nativeCommand);
  publicHex(owner, 'claim:owner');
  if (typeof leaseDuration !== 'bigint' || leaseDuration <= 0n)
    throw Error('claim:duration');
  const projection = await captureUnapprovedMoneroPayoutRequest(requestValue);
  const session = await openSelection(projection, command);
  try {
    const reserved = await registry.reserve(
      projection.request,
      session.selection.bytes,
    );
    if (reserved.status !== 'created' && reserved.status !== 'existing')
      return reserved;
    if (reserved.reservation.state === 'completed')
      return {
        status: 'completed' as const,
        reservation: reserved.reservation,
      };
    const claim = await registry.claim(
      reserved.reservation.reservationId,
      owner,
      leaseDuration,
    );
    if (claim.status !== 'claimed') return claim;
    return await registry.construct(claim.fence, async (reservation) => {
      if (
        reservation.requestJson !== JSON.stringify(projection.request) ||
        reservation.selectionBytes !== session.selection.bytes
      )
        throw Error('native:reservation-substitution');
      return session.construct(
        reservation.reservationId,
        reservation.generation,
      );
    });
  } finally {
    await session.stop();
  }
}
