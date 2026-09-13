import * as wasm from 'ergo-lib-wasm-nodejs';

import { economicOutputIdentity } from '@rosen-bridge/monero-deposit';

import type {
  ErgoCreditRegistry,
  CreditPreparationResult,
  CreditSigningResult,
  CreditEffectResult,
} from '../db/ergoCreditRegistry';
import type { DeliveryClaim } from './creditDelivery';
import { boundedInteger, identityString } from './creditDelivery';
import { canonicalDecision } from './depositAdmission';
import {
  verifyErgoCreditAdmission,
  type VerifiedErgoAdmission,
} from './ergoCreditAdmission';
import {
  verifyErgoCreditCandidate,
  type ErgoCreditDependencies,
} from './ergoCreditConsumer';
import { nativePrepared } from './ergoCreditNative';

export interface CreditEconomicOutput {
  economicId: string;
  sourceNetwork: string;
  publicKey: string;
  txid: string;
  outputIndex: string;
  amount: string;
  vaultEpoch: string;
}
export interface CreditPreparationBinding {
  domain: 'rosen-monero-ergo-preparation';
  version: 1;
  mode: 'synthetic';
  obligationId: string;
  payload: string;
  payloadHash: string;
  destinationId: string;
  destinationProfile: string;
  envelopeDigest: string;
  executionProfileDigest: string;
  economicOutputs: CreditEconomicOutput[];
}
export interface CheckedCreditPreparation {
  readonly purpose?: 'preparation' | 'signing' | 'effect';
  readonly bindingJson: string;
  readonly candidateJson: string | null;
}
const checked = new WeakMap<
  object,
  { destination: ErgoCreditRegistry; value: Readonly<CheckedCreditPreparation> }
>();
/** No public issuer: only the actual verified producer creates a one-operation capability. */
export function checkedCreditPreparation(
  capability: unknown,
  destination: ErgoCreditRegistry,
): Readonly<CheckedCreditPreparation> | undefined {
  if (!capability || typeof capability !== 'object') return;
  const stored = checked.get(capability);
  return stored?.destination === destination ? stored.value : undefined;
}
function bind(admission: VerifiedErgoAdmission): string {
  const candidate = admission.candidate;
  const binding: CreditPreparationBinding = {
    domain: 'rosen-monero-ergo-preparation',
    version: 1,
    mode: 'synthetic',
    obligationId: admission.obligationId,
    payload: admission.claim.payload,
    payloadHash: admission.claim.payloadHash,
    destinationId: admission.claim.destinationId,
    destinationProfile: admission.claim.destinationProfile,
    envelopeDigest: admission.envelopeDigest,
    executionProfileDigest: admission.executionProfileDigest,
    economicOutputs: candidate.outputs
      .map((output) => ({
        economicId: economicOutputIdentity(
          candidate.sourceNetwork,
          output.publicKey,
        ),
        sourceNetwork: candidate.sourceNetwork,
        publicKey: output.publicKey,
        txid: candidate.txid,
        outputIndex: output.outputIndex.toString(),
        amount: output.amount.toString(),
        vaultEpoch: candidate.vaultEpoch,
      }))
      .sort((a, b) => a.economicId.localeCompare(b.economicId)),
  };
  return canonicalDecision(binding);
}
async function persist(
  destination: ErgoCreditRegistry,
  value: CheckedCreditPreparation,
): Promise<CreditPreparationResult> {
  const capability = Object.freeze({});
  checked.set(capability, {
    destination,
    value: Object.freeze({ ...value, purpose: 'preparation' }),
  });
  try {
    return await destination.prepareChecked(capability);
  } finally {
    checked.delete(capability);
  }
}
/** Proposes the actual newly verified D3a candidate; a competing candidate conflicts. */
export async function prepareErgoCredit(
  claim: DeliveryClaim,
  deps: ErgoCreditDependencies,
  destination: ErgoCreditRegistry,
): Promise<CreditPreparationResult> {
  try {
    const runtime = deps.runtime;
    const select = runtime.selectInputs.bind(runtime);
    let bindingJson: string | undefined;
    const candidate = await verifyErgoCreditCandidate(claim, {
      ...deps,
      runtime: {
        ...runtime,
        selectInputs: async (admission) => {
          // D3a owns this verified result; retain only privately owned exact primitive bytes.
          bindingJson = bind(admission);
          return select(admission);
        },
      },
    });
    if (candidate.status !== 'verified-unsigned') return candidate;
    if (!bindingJson)
      return {
        status: 'indeterminate',
        reason: 'preparation:missing-admission',
      };
    return await persist(destination, {
      bindingJson,
      candidateJson: canonicalDecision(candidate),
    });
  } catch {
    return { status: 'indeterminate', reason: 'preparation:unavailable' };
  }
}
/** Recovers original bytes with a current source claim and historical D1 reproduction.
 * Does not regenerate, replace, sign, release or apply a destination effect.
 */
export async function recoverErgoCredit(
  claim: DeliveryClaim,
  deps: ErgoCreditDependencies,
  destination: ErgoCreditRegistry,
): Promise<CreditPreparationResult> {
  try {
    const admission = await verifyErgoCreditAdmission(claim, deps);
    if (admission.status !== 'verified') return admission;
    return await persist(destination, {
      bindingJson: bind(admission),
      candidateJson: null,
    });
  } catch {
    return { status: 'indeterminate', reason: 'preparation:unavailable' };
  }
}

export type PrivateSigningFault = (
  point: 'beforeNative' | 'afterNative',
) => Promise<void>;

/** Actual checked producer to one local synthetic effect; no chain submission. */
export async function executeErgoCredit(
  claim: DeliveryClaim,
  deps: ErgoCreditDependencies,
  destination: ErgoCreditRegistry,
  signer: PrivateErgoCreditSigner,
  executionOwner: string,
  lease: bigint,
): Promise<CreditEffectResult> {
  try {
    const captured = Object.freeze(structuredClone(claim));
    const dependencies = { ...deps, profile: structuredClone(deps.profile) };
    let prepared = await recoverErgoCredit(captured, dependencies, destination);
    if (prepared.status === 'missing')
      prepared = await prepareErgoCredit(captured, dependencies, destination);
    if (!('preparation' in prepared)) return prepared;
    const signed = await signer.sign(captured, dependencies);
    if (signed.status !== 'staged') return signed;
    const admission = await verifyErgoCreditAdmission(captured, dependencies);
    if (admission.status !== 'verified') return admission;
    const capability = Object.freeze({});
    checked.set(capability, {
      destination,
      value: Object.freeze({
        purpose: 'effect',
        bindingJson: bind(admission),
        candidateJson: null,
      }),
    });
    try {
      const work = await destination.claimEffectChecked(
        capability,
        executionOwner,
        lease,
      );
      if (work.status !== 'claimed') return work;
      const fence = Object.freeze(structuredClone(work.fence));
      return await destination.applyEffectChecked(capability, fence);
    } finally {
      checked.delete(capability);
    }
  } catch {
    return { status: 'indeterminate', reason: 'effect:unavailable' };
  }
}
export class PrivateErgoCreditSigner {
  readonly #wallet: wasm.Wallet;
  readonly #destination: ErgoCreditRegistry;
  readonly #owner: string;
  readonly #lease: bigint;
  readonly #fault?: PrivateSigningFault;
  #closing = false;
  #close?: Promise<void>;
  #active = new Set<Promise<CreditSigningResult>>();
  private constructor(
    wallet: wasm.Wallet,
    destination: ErgoCreditRegistry,
    owner: string,
    lease: bigint,
    fault?: PrivateSigningFault,
  ) {
    this.#wallet = wallet;
    this.#destination = destination;
    this.#owner = owner;
    this.#lease = lease;
    this.#fault = fault;
  }
  static create(options: {
    destination: ErgoCreditRegistry;
    owner: string;
    lease: bigint;
    secretKeys: readonly Uint8Array[];
    fault?: PrivateSigningFault;
  }): PrivateErgoCreditSigner {
    const { destination, owner, lease, fault } = options;
    if (!identityString(owner) || boundedInteger(lease) === 0n)
      throw Error('Invalid signer identity/lease');
    if (
      !Array.isArray(options.secretKeys) ||
      !options.secretKeys.length ||
      options.secretKeys.length > 16
    )
      throw Error('Invalid synthetic keys');
    const copied = options.secretKeys.map((k) => {
      if (!(k instanceof Uint8Array) || k.length !== 32)
        throw Error('Invalid synthetic key');
      return Uint8Array.from(k);
    });
    const keys = new wasm.SecretKeys();
    try {
      copied.forEach((k) => keys.add(wasm.SecretKey.dlog_from_bytes(k)));
      return new PrivateErgoCreditSigner(
        wasm.Wallet.from_secrets(keys),
        destination,
        owner,
        lease,
        fault,
      );
    } finally {
      copied.forEach((k) => k.fill(0));
      keys.free();
    }
  }
  sign(
    claim: DeliveryClaim,
    deps: ErgoCreditDependencies,
  ): Promise<CreditSigningResult> {
    if (this.#closing)
      return Promise.resolve({
        status: 'indeterminate',
        reason: 'signing:closed',
      });
    const result = this.perform(claim, deps);
    this.#active.add(result);
    void result.finally(() => this.#active.delete(result));
    return result;
  }
  private async perform(
    claim: DeliveryClaim,
    deps: ErgoCreditDependencies,
  ): Promise<CreditSigningResult> {
    let capability: object | undefined;
    try {
      const admission = await verifyErgoCreditAdmission(claim, deps);
      if (admission.status !== 'verified') return admission;
      capability = Object.freeze({});
      checked.set(capability, {
        destination: this.#destination,
        value: Object.freeze({
          purpose: 'signing',
          bindingJson: bind(admission),
          candidateJson: null,
        }),
      });
      const work = await this.#destination.claimSigningChecked(
        capability,
        this.#owner,
        this.#lease,
      );
      if (work.status !== 'claimed')
        return work.status === 'staged'
          ? Object.freeze({
              status: 'staged',
              signed: Object.freeze({ ...work.signed }),
            })
          : work;
      const preparation = Object.freeze({ ...work.preparation });
      const fence = Object.freeze({ ...work.fence });
      const native = nativePrepared(preparation);
      await this.#fault?.('beforeNative');
      const signed = this.#wallet.sign_reduced_transaction(native.reduced);
      const signedHex = Buffer.from(signed.sigma_serialize_bytes()).toString(
        'hex',
      );
      signed.free();
      await this.#fault?.('afterNative');
      const result = await this.#destination.stageSigningChecked(
        capability,
        fence,
        signedHex,
      );
      return result.status === 'staged'
        ? Object.freeze({
            status: 'staged',
            signed: Object.freeze({ ...result.signed }),
          })
        : result;
    } catch {
      return { status: 'indeterminate', reason: 'signing:unavailable' };
    } finally {
      if (capability) checked.delete(capability);
    }
  }
  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closing = true;
    this.#close = Promise.allSettled([...this.#active]).then(() => {
      this.#wallet.free();
    });
    return this.#close;
  }
}
