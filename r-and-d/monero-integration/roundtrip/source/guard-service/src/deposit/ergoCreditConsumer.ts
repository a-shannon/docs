import { blake2b } from 'blakejs';
import * as wasm from 'ergo-lib-wasm-nodejs';

import { TokenMap } from '@rosen-bridge/tokens';
import {
  TransactionType,
  type EventTrigger,
  type PaymentTransaction,
  type PaymentOrder,
  type SinglePayment,
} from '@rosen-chains/abstract-chain';
import { ErgoChain, ErgoTransaction } from '@rosen-chains/ergo';

import { digest } from '../db/depositRegistry';
import type { DeliveryClaim } from './creditDelivery';
import { canonicalDecision } from './depositAdmission';
import {
  boxDigest,
  CreditRefusal,
  exactHex,
  MAX_ERGO_AMOUNT,
  recordShape,
  requireCredit,
  verifyErgoCreditAdmission,
  type ErgoAdmissionDependencies,
  type ErgoExecutionProfile,
  type VerifiedErgoAdmission,
} from './ergoCreditAdmission';

export interface ErgoContextDescriptor {
  headers: unknown[];
  preHeaderFromIndex: 0;
}
export interface CheckedErgoInputs {
  triggerHex: string;
  guardHex: string;
  wids: string[];
  context: ErgoContextDescriptor;
}
/** Trusted composition supplies real adapters and captures the context returned by getStateContext. */
export interface ErgoCreditRuntime {
  chain: ErgoChain;
  tokenMap: TokenMap;
  selectInputs(admission: VerifiedErgoAdmission): Promise<CheckedErgoInputs>;
  extractTrigger(hex: string): EventTrigger;
  generationContext(): ErgoContextDescriptor | undefined;
}
export interface ErgoCreditDependencies extends ErgoAdmissionDependencies {
  runtime: ErgoCreditRuntime;
}
export interface VerifiedUnsignedCredit {
  status: 'verified-unsigned';
  obligationId: string;
  envelopeDigest: string;
  executionProfileDigest: string;
  triggerId: string;
  eventId: string;
  transactionJson: string;
  reducedHex: string;
  inputHex: readonly string[];
  dataInputHex: readonly string[];
  contextJson: string;
  contextDigest: string;
  netAmount: string;
}
export type ErgoCreditResult =
  | VerifiedUnsignedCredit
  | { status: 'rejected' | 'indeterminate'; reason: string };
export const canonicalTree = (address: string): string =>
  wasm.Address.from_base58(address).to_ergo_tree().to_base16_bytes();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
/** Detach the generated object and prevent consumers from changing checked bytes.
 * Buffers cannot be frozen in JavaScript: each accessor returns an independent copy.
 */
function immutableTransaction(
  generated: PaymentTransaction,
  eventId: string,
): ErgoTransaction {
  const json = generated.toJson();
  const tx = ErgoTransaction.fromJson(json);
  requireCredit(tx.toJson() === json, 'transaction:serialization');
  requireCredit(
    tx.network === 'ergo' &&
      tx.eventId === eventId &&
      tx.txType === TransactionType.payment,
    'transaction:identity',
  );
  const txBytes = hex(tx.txBytes);
  const inputBoxes = tx.inputBoxes.map(hex);
  const dataInputs = tx.dataInputs.map(hex);
  Object.defineProperties(tx, {
    txBytes: { get: () => Buffer.from(txBytes, 'hex') },
    inputBoxes: {
      get: () => inputBoxes.map((bytes) => Buffer.from(bytes, 'hex')),
    },
    dataInputs: {
      get: () => dataInputs.map((bytes) => Buffer.from(bytes, 'hex')),
    },
  });
  Object.freeze(tx);
  return tx;
}
const parseBox = (bytes: string): wasm.ErgoBox => {
  const box = wasm.ErgoBox.sigma_parse_bytes(
    Buffer.from(exactHex(bytes, 'box'), 'hex'),
  );
  requireCredit(hex(box.sigma_serialize_bytes()) === bytes, 'box:canonical');
  return box;
};
export function contextFromDescriptor(
  descriptor: ErgoContextDescriptor,
): wasm.ErgoStateContext {
  recordShape(descriptor, ['headers', 'preHeaderFromIndex'], 'ergo-context');
  requireCredit(
    descriptor.preHeaderFromIndex === 0 &&
      Array.isArray(descriptor.headers) &&
      descriptor.headers.length === 10 &&
      Buffer.byteLength(canonicalDecision(descriptor)) <= 65536,
    'ergo-context:schema',
  );
  const headers = wasm.BlockHeaders.from_json(descriptor.headers);
  return new wasm.ErgoStateContext(
    wasm.PreHeader.from_block_header(headers.get(0)),
    headers,
  );
}
export function executionTokenMap(profile: ErgoExecutionProfile) {
  return [
    {
      monero: {
        tokenId: 'XMR',
        name: 'XMR',
        decimals: 12,
        type: 'native',
        residency: 'native',
        extra: {},
      },
      ergo: {
        tokenId: profile.destinationAsset,
        name: 'synthetic rsXMR',
        decimals: 12,
        type: 'EIP-004',
        residency: 'wrapped',
        extra: {},
      },
    },
  ];
}
/** Independent conservation/allocation check for the admitted token-only, merged-WID profile.
 * Construction still uses EventOrder; no order produced here is sent to the generator.
 */
function assertCompleteProfileOrder(
  actual: PaymentOrder,
  admission: VerifiedErgoAdmission,
  trigger: wasm.ErgoBox,
  wids: string[],
): void {
  const p = admission.profile;
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  const amount = admission.candidate.amount;
  const bridge = max(
    max(admission.candidate.bridgeFee, BigInt(p.fees.bridgeFee)),
    (amount * BigInt(p.fees.feeRatio)) / BigInt(p.fees.feeRatioDivisor),
  );
  const network = max(
    admission.candidate.networkFee,
    BigInt(p.fees.networkFee),
  );
  const emission =
    (bridge * BigInt(p.fees.rsnRatio)) / BigInt(p.fees.rsnRatioDivisor);
  const count = BigInt(wids.length);
  const watcher = (bridge * BigInt(p.rewards.watchersPercent)) / 100n / count;
  const watcherEmission =
    (emission * BigInt(p.rewards.watchersEmissionPercent)) / 100n / count;
  const permitErg = BigInt(trigger.value().as_i64().to_str()) / count;
  const rwtCount =
    BigInt(trigger.tokens().get(0).amount().as_i64().to_str()) / count;
  const minimumErg = BigInt(p.funding.minimumErg);
  const tokens = (id: string, value: bigint) =>
    value > 0n ? [{ id, value }] : [];
  const expected: PaymentOrder = wids.map((wid) => ({
    address: p.contracts.permit,
    assets: {
      nativeToken: permitErg,
      tokens: [
        { id: p.contracts.rwtId, value: rwtCount },
        ...tokens(p.destinationAsset, watcher),
        ...tokens(p.rewards.emissionTokenId, watcherEmission),
      ],
    },
    extra: wid,
  }));
  expected.push({
    address: admission.candidate.recipient,
    assets: {
      nativeToken: minimumErg + BigInt(p.funding.additionalErg),
      tokens: [{ id: p.destinationAsset, value: amount - bridge - network }],
    },
  });
  const guardBridge = bridge - count * watcher;
  const shares = p.rewards.distribution.map((receiver) => ({
    address: receiver.address,
    amount: (guardBridge * BigInt(receiver.percent)) / 100n,
  }));
  const remaining =
    guardBridge - shares.reduce((sum, share) => sum + share.amount, 0n);
  expected.push({
    address: p.rewards.defaultAddress,
    assets: {
      nativeToken: minimumErg,
      tokens: tokens(p.destinationAsset, remaining),
    },
    extra: '',
  });
  for (const share of shares)
    expected.push({
      address: share.address,
      assets: {
        nativeToken: minimumErg,
        tokens: tokens(p.destinationAsset, share.amount),
      },
    });
  const remainingEmission = emission - count * watcherEmission;
  if (remainingEmission > 0n)
    expected.push({
      address: p.rewards.emissionAddress,
      assets: {
        nativeToken: minimumErg,
        tokens: tokens(p.rewards.emissionTokenId, remainingEmission),
      },
    });
  expected.push({
    address: p.rewards.networkAddress,
    assets: {
      nativeToken: minimumErg,
      tokens: [{ id: p.destinationAsset, value: network }],
    },
  });
  const canonicalOrder = (order: SinglePayment[]) =>
    canonicalDecision(
      order.map((payment) => ({
        ...payment,
        address: canonicalTree(payment.address),
      })),
    );
  requireCredit(
    canonicalOrder(actual) === canonicalOrder(expected),
    'payment:profile-order',
  );
}
function checkedEvent(
  runtime: ErgoCreditRuntime,
  triggerHex: string,
  wids: string[],
  admission: VerifiedErgoAdmission,
): EventTrigger {
  const box = parseBox(triggerHex);
  const profile = admission.profile;
  requireCredit(
    box.ergo_tree().to_base16_bytes() ===
      canonicalTree(profile.contracts.trigger),
    'trigger:tree',
  );
  requireCredit(
    wids.length > 0 && wids.length <= 32 && new Set(wids).size === wids.length,
    'trigger:wids',
  );
  wids.forEach((wid) => exactHex(wid, 'wid', 32));
  requireCredit(
    box.register_value(5)?.to_coll_coll_byte().length === 12,
    'trigger:field-count',
  );
  requireCredit(
    box.register_value(7)?.to_i32() === wids.length,
    'trigger:count',
  );
  requireCredit(
    hex(box.register_value(4)!.to_byte_array()) ===
      hex(blake2b(Buffer.from(wids.join(''), 'hex'), undefined, 32)),
    'trigger:wid-hash',
  );
  requireCredit(
    hex(box.register_value(6)!.to_byte_array()) ===
      hex(
        blake2b(
          Buffer.from(canonicalTree(profile.contracts.permit), 'hex'),
          undefined,
          32,
        ),
      ),
    'trigger:permit',
  );
  requireCredit(
    box.tokens().len() === 1 &&
      box.tokens().get(0).id().to_str() === profile.contracts.rwtId,
    'trigger:rwt',
  );
  requireCredit(
    BigInt(box.tokens().get(0).amount().as_i64().to_str()) %
      BigInt(wids.length) ===
      0n,
    'trigger:rwt-count',
  );
  const event = runtime.extractTrigger(triggerHex);
  const expected = admission.observation;
  for (const name of [
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
    'sourceBlockId',
  ] as const)
    requireCredit(event[name] === expected[name], `trigger:${name}`);
  requireCredit(
    event.sourceChainHeight === expected.height,
    'trigger:source-height',
  );
  requireCredit(
    event.WIDsCount === wids.length &&
      event.WIDsHash === hex(box.register_value(4)!.to_byte_array()),
    'trigger:extracted-wids',
  );
  return event;
}
/** Produces a verified unsigned candidate only. Signature release and delivery belong to D3b. */
export async function verifyErgoCreditCandidate(
  claim: DeliveryClaim,
  deps: ErgoCreditDependencies,
): Promise<ErgoCreditResult> {
  try {
    const admission = await verifyErgoCreditAdmission(claim, deps);
    if (admission.status !== 'verified') return admission;
    const runtime = deps.runtime;
    const profile = admission.profile;
    requireCredit(
      canonicalDecision(runtime.tokenMap.getConfig()) ===
        canonicalDecision(executionTokenMap(profile)),
      'runtime:token-map',
    );
    const config = runtime.chain.getChainConfigs();
    requireCredit(
      config.fee === BigInt(profile.funding.minerFee) &&
        runtime.chain.getMinimumNativeToken() ===
          BigInt(profile.funding.minimumErg),
      'runtime:funding',
    );
    for (const name of ['lock', 'permit', 'fraud'] as const)
      requireCredit(
        canonicalTree(config.addresses[name]) ===
          canonicalTree(profile.contracts[name]),
        `runtime:${name}`,
      );
    requireCredit(
      runtime.chain.getRWTToken() === profile.contracts.rwtId,
      'runtime:rwt',
    );
    const checked = structuredClone(await runtime.selectInputs(admission));
    recordShape(
      checked,
      ['triggerHex', 'guardHex', 'wids', 'context'],
      'inputs',
    );
    const contextJson = canonicalDecision(checked.context);
    requireCredit(
      digest(contextJson) === profile.stateContextDigest,
      'context:profile',
    );
    const stateContext = contextFromDescriptor(checked.context);
    requireCredit(
      boxDigest(checked.guardHex) === profile.guardBoxDigest,
      'guard:profile',
    );
    const guard = parseBox(checked.guardHex);
    requireCredit(
      guard.ergo_tree().to_base16_bytes() ===
        canonicalTree(profile.contracts.guard),
      'guard:tree',
    );
    requireCredit(
      guard.tokens().len() === 1 &&
        guard.tokens().get(0).id().to_str() === profile.contracts.guardNFT &&
        guard.tokens().get(0).amount().as_i64().to_str() === '1',
      'guard:nft',
    );
    const event = checkedEvent(
      runtime,
      checked.triggerHex,
      checked.wids,
      admission,
    );
    const trigger = parseBox(checked.triggerHex);
    const eventTxId = JSON.parse(trigger.to_json()).transactionId as string;
    // Real service consumers; fixtures substitute their environmental ports only.
    const { default: EventOrder } = await import('../event/eventOrder');
    const { default: TransactionVerifier } = await import(
      '../verification/transactionVerifier'
    );
    const { default: GuardsErgoConfigs } = await import(
      '../configs/guardsErgoConfigs'
    );
    const { default: ChainHandler } = await import('../handlers/chainHandler');
    const { TokenHandler } = await import('../handlers/tokenHandler');
    const { default: MinimumFeeHandler } = await import(
      '../handlers/minimumFeeHandler'
    );
    const feeConfig = Object.fromEntries(
      Object.entries(profile.fees).map(([key, value]) => [key, BigInt(value)]),
    ) as unknown as Parameters<typeof EventOrder.createEventPaymentOrder>[2];
    const checkConsumerProfile = () => {
      requireCredit(
        ChainHandler.getInstance().getChain('ergo') === runtime.chain,
        'runtime:chain',
      );
      const sourceChain = ChainHandler.getInstance().getChain('monero');
      requireCredit(
        sourceChain.getRWTToken() === profile.contracts.rwtId &&
          canonicalTree(sourceChain.getChainConfigs().addresses.permit) ===
            canonicalTree(profile.contracts.permit),
        'runtime:source-config',
      );
      requireCredit(
        canonicalDecision(
          TokenHandler.getInstance().getTokenMap().getConfig(),
        ) === canonicalDecision(executionTokenMap(profile)),
        'runtime:consumer-token-map',
      );
      requireCredit(
        canonicalDecision(MinimumFeeHandler.getEventFeeConfig(event)) ===
          canonicalDecision(feeConfig),
        'runtime:fee-config',
      );
      requireCredit(
        GuardsErgoConfigs.minimumErg === BigInt(profile.funding.minimumErg) &&
          GuardsErgoConfigs.additionalErgOnPayment ===
            BigInt(profile.funding.additionalErg),
        'runtime:consumer-funding',
      );
      const rewards = {
        watchersPercent: Number(GuardsErgoConfigs.watchersSharePercent),
        watchersEmissionPercent: Number(
          GuardsErgoConfigs.watchersEmissionSharePercent,
        ),
        distribution: GuardsErgoConfigs.chainBridgeFeeDistribution.monero,
        defaultAddress: GuardsErgoConfigs.bridgeFeeDefaultAddress,
        networkAddress: GuardsErgoConfigs.networkFeeRepoAddress,
        emissionAddress: GuardsErgoConfigs.emissionAddress,
        emissionTokenId: GuardsErgoConfigs.emissionTokenId,
      };
      requireCredit(
        canonicalDecision(rewards) === canonicalDecision(profile.rewards),
        'runtime:rewards',
      );
    };
    checkConsumerProfile();
    const order = await EventOrder.createEventPaymentOrder(
      event,
      eventTxId,
      feeConfig,
      checked.wids,
    );
    for (const payment of order)
      for (const value of [
        payment.assets.nativeToken,
        ...payment.assets.tokens.map((token) => token.value),
      ])
        requireCredit(
          value >= 0n && value <= MAX_ERGO_AMOUNT,
          'order:amount-range',
        );
    const eventId = hex(blake2b(event.sourceTxId, undefined, 32));
    const generated = await runtime.chain.generateTransaction(
      eventId,
      TransactionType.payment,
      order,
      [],
      [],
      [checked.triggerHex],
      [checked.guardHex],
    );
    const tx = immutableTransaction(generated, eventId);
    if (!(await TransactionVerifier.verifyTxCommonConditions(tx)))
      throw new CreditRefusal('transaction:common');
    if (
      !(await TransactionVerifier.verifyEventTransaction(tx, event, eventTxId))
    )
      throw new CreditRefusal('transaction:event');
    assertCompleteProfileOrder(
      runtime.chain.extractTransactionOrder(tx),
      admission,
      trigger,
      checked.wids,
    );
    const txObject = tx as PaymentTransaction & {
      inputBoxes: Uint8Array[];
      dataInputs: Uint8Array[];
    };
    const actualInputs = txObject.inputBoxes.map(hex);
    const actualData = txObject.dataInputs.map(hex);
    requireCredit(
      actualInputs.length >= 2 &&
        actualInputs.length <= 128 &&
        new Set(actualInputs).size === actualInputs.length,
      'transaction:inputs',
    );
    // The two existing verifiers do not bind this decision to the consumed trigger.
    const consumed = checkedEvent(
      runtime,
      actualInputs[0],
      checked.wids,
      admission,
    );
    requireCredit(
      actualInputs[0] === checked.triggerHex &&
        parseBox(actualInputs[0]).box_id().to_str() ===
          trigger.box_id().to_str(),
      'transaction:trigger-identity',
    );
    requireCredit(
      canonicalDecision(consumed) === canonicalDecision(event),
      'transaction:trigger-event',
    );
    for (const funding of actualInputs.slice(1))
      requireCredit(
        parseBox(funding).ergo_tree().to_base16_bytes() ===
          canonicalTree(profile.contracts.lock),
        'transaction:funding-tree',
      );
    requireCredit(
      actualData.length === 1 && actualData[0] === checked.guardHex,
      'transaction:guard-identity',
    );
    requireCredit(
      canonicalDecision(runtime.generationContext()) === contextJson,
      'transaction:context-identity',
    );
    const nativeReduced = wasm.ReducedTransaction.sigma_parse_bytes(tx.txBytes);
    const boxes = wasm.ErgoBoxes.empty();
    actualInputs.forEach((bytes) => boxes.add(parseBox(bytes)));
    const data = wasm.ErgoBoxes.empty();
    actualData.forEach((bytes) => data.add(parseBox(bytes)));
    const regenerated = wasm.ReducedTransaction.from_unsigned_tx(
      nativeReduced.unsigned_tx(),
      boxes,
      data,
      stateContext,
    );
    requireCredit(
      hex(regenerated.sigma_serialize_bytes()) === hex(tx.txBytes),
      'transaction:reduction-context',
    );
    const recipientTree = canonicalTree(admission.candidate.recipient);
    const recipientOutputs = runtime.chain
      .extractTransactionOrder(tx)
      .filter((payment) => canonicalTree(payment.address) === recipientTree);
    requireCredit(
      recipientOutputs.length === 1 && recipientOutputs[0].extra === undefined,
      'payment:recipient-layout',
    );
    const recipientAssets = recipientOutputs[0].assets;
    requireCredit(
      recipientAssets.tokens.length === 1 &&
        recipientAssets.tokens[0].id === profile.destinationAsset,
      'payment:asset',
    );
    const net = runtime.tokenMap.unwrapAmount(
      profile.destinationAsset,
      recipientAssets.tokens[0].value,
      'ergo',
    ).amount;
    requireCredit(net === admission.candidate.destinationAmount, 'payment:net');
    requireCredit(
      recipientAssets.nativeToken ===
        BigInt(profile.funding.minimumErg) +
          BigInt(profile.funding.additionalErg),
      'payment:erg-funding',
    );
    checkConsumerProfile();
    // Capture every returned byte before yielding to the final ownership check.
    const result: VerifiedUnsignedCredit = Object.freeze({
      status: 'verified-unsigned',
      obligationId: admission.obligationId,
      envelopeDigest: admission.envelopeDigest,
      executionProfileDigest: admission.executionProfileDigest,
      triggerId: trigger.box_id().to_str(),
      eventId,
      transactionJson: tx.toJson(),
      reducedHex: hex(tx.txBytes),
      inputHex: Object.freeze(actualInputs),
      dataInputHex: Object.freeze(actualData),
      contextJson,
      contextDigest: digest(contextJson),
      netAmount: net.toString(),
    });
    if (
      !(await deps.registry.validateDeliveryClaim(admission.claim, deps.now()))
    )
      throw new CreditRefusal('claim:stale');
    return result;
  } catch (error) {
    return error instanceof CreditRefusal
      ? { status: error.status, reason: error.reason }
      : { status: 'indeterminate', reason: 'consumer:unavailable' };
  }
}
