import { createHash } from 'node:crypto';
import * as wasm from 'ergo-lib-wasm-nodejs';
import { canonicalAssignment } from '../db/moneroCreditAssignment.mjs';

const hex = value => Buffer.from(value.sigma_serialize_bytes()).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const wrapped = new WeakSet();

/** Exact mediator input, copied before any external await. */
export function snapshotCreditSigning(tx, requiredSign, boxes, dataBoxes = []) {
  if (requiredSign !== 3 || !Array.isArray(boxes) || !Array.isArray(dataBoxes) ||
      !boxes.length || boxes.length > 128 || dataBoxes.length > 16) throw Error('credit-sign:shape');
  const reducedHex = hex(tx);
  if (reducedHex.length > 2000000) throw Error('credit-sign:size');
  const reduced = wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(reducedHex,'hex'));
  const inputHex = boxes.map(hex), dataHex = dataBoxes.map(hex);
  const unsigned = JSON.parse(reduced.unsigned_tx().to_json());
  const inputs = inputHex.map(value => wasm.ErgoBox.sigma_parse_bytes(Buffer.from(value,'hex')));
  const dataInputs = dataHex.map(value => wasm.ErgoBox.sigma_parse_bytes(Buffer.from(value,'hex')));
  if (unsigned.inputs.length !== inputs.length || unsigned.dataInputs.length !== dataInputs.length ||
      unsigned.inputs.some((input,i) => input.boxId !== inputs[i].box_id().to_str()) ||
      unsigned.dataInputs.some((input,i) => input.boxId !== dataInputs[i].box_id().to_str()) ||
      new Set([...inputs,...dataInputs].map(box => box.box_id().to_str())).size !== inputs.length + dataInputs.length)
    throw Error('credit-sign:input-binding');
  const body = {domain:'rosen-monero-ergo-credit-signing-v1',requiredSign,reducedHex,inputHex,dataHex};
  return { ...body, digest:hash(canonicalAssignment(body)), txId:reduced.unsigned_tx().id().to_str(),
    reduced, inputs, dataInputs };
}

/**
 * Guard-owned mediator for the pinned Ergo multisig participant. verify is a
 * trusted source/trigger/order verifier; it must recompute, not accept a verdict.
 * Assignment is permanent economic state. The returned facade exposes no prover.
 * This adapter is scoped to Monero credit and fixed four-member custody.
 */
export function createMoneroCreditSigner({participant,assignment,verify,requireFreshContribution=false}) {
  if (!participant || wrapped.has(participant) || typeof verify !== 'function' ||
      typeof participant.getProver !== 'function' || typeof participant.sign !== 'function')
    throw Error('credit-sign:composition');
  if (typeof requireFreshContribution !== 'boolean' ||
      (requireFreshContribution && participant.contributionValidationVersion !== 1))
    throw Error('credit-sign:contribution-implementation');
  wrapped.add(participant);
  const originalProver = participant.getProver.bind(participant);
  const originalSign = participant.sign.bind(participant);
  const requests = new Map(), capabilities = new Map();
  let closed = false, proxy;

  function assertRetained(capability) {
    capability.assertCurrent();
    const retained = assignment.assign(capability.request);
    if (retained.status !== 'existing') throw Error('credit-sign:assignment-' + retained.status);
    capability.assertCurrent();
  }

  async function refreshContribution(request) {
    if (closed || !requireFreshContribution) throw Error('credit-sign:fresh-unavailable');
    if (!request || Object.keys(request).sort().join(',') !== 'kind,reducedHex,txId' ||
        !['commitment','coordinator-sign','peer-sign'].includes(request.kind) ||
        typeof request.reducedHex !== 'string') throw Error('credit-sign:fresh-request');
    const key = hash(request.reducedHex), capability = capabilities.get(key);
    if (!capability || capability.failed || capability.reducedHex !== request.reducedHex ||
        capability.txId !== request.txId) throw Error('credit-sign:fresh-binding');
    // A second callback may not leave the first callback's authorization usable.
    capability.permit = undefined;
    if (capability.refreshing) { capability.failed = true; throw Error('credit-sign:fresh-concurrent'); }
    capability.refreshing = true;
    try {
      const fresh = await capability.revalidate();
      if (closed || capability.failed || capabilities.get(key) !== capability ||
          !fresh || typeof fresh.assertCurrent !== 'function' ||
          canonicalAssignment(fresh.assignment) !== capability.canonicalRequest)
        throw Error('credit-sign:fresh-verification');
      capability.assertCurrent = fresh.assertCurrent;
      assertRetained(capability);
      capability.permit = request.kind === 'commitment'
        ? 'generate_commitments_for_reduced_transaction' : 'sign_reduced_transaction_multi';
    } catch (error) {
      capability.failed = true; capability.permit = undefined; throw error;
    } finally { capability.refreshing = false; }
  }

  function assertContribution(tx, nativeMethod) {
    if (closed) throw Error('credit-sign:closed');
    const reducedHex = hex(tx), capability = capabilities.get(hash(reducedHex));
    if (!capability || capability.reducedHex !== reducedHex) throw Error('credit-sign:unissued');
    if (requireFreshContribution) {
      const permit = capability.permit;
      capability.permit = undefined;
      if (capability.failed || capability.refreshing || permit !== nativeMethod)
        throw Error('credit-sign:fresh-permit');
    }
    // Synchronous check and contribution are adjacent; no external await opens
    // a known-invalidation gap after the final durable assignment check.
    assertRetained(capability);
  }
  participant.getProver = () => {
    if (!proxy) {
      const prover = originalProver();
      proxy = new Proxy(prover,{get(target,name) {
        const method = Reflect.get(target,name,target);
        if (name === 'generate_commitments_for_reduced_transaction' || name === 'sign_reduced_transaction_multi')
          return (tx,...args) => { assertContribution(tx,name); return method.call(target,tx,...args); };
        if (typeof method === 'function') return method.bind(target);
        return method;
      }});
    }
    return proxy;
  };

  const sign = (tx,requiredSign,boxes,dataBoxes) => {
    if (closed) return Promise.reject(Error('credit-sign:closed'));
    let snapshot;
    try { snapshot = snapshotCreditSigning(tx,requiredSign,boxes,dataBoxes); }
    catch (error) { return Promise.reject(error); }
    const previous = requests.get(snapshot.txId);
    if (previous) return previous.digest === snapshot.digest ? previous.promise : Promise.reject(Error('credit-sign:queue-conflict'));
    const promise = Promise.resolve().then(async () => {
      // Trusted verifier owns native proof, independently reconstructed source
      // evidence, trigger/order equality, current committee and reduction parity.
      const result = await verify(Object.freeze({
        digest:snapshot.digest,txId:snapshot.txId,reducedHex:snapshot.reducedHex,
        inputHex:Object.freeze([...snapshot.inputHex]),dataHex:Object.freeze([...snapshot.dataHex]),requiredSign,
      }));
      if (closed || !result || typeof result.assertCurrent !== 'function' ||
          (requireFreshContribution && typeof result.revalidate !== 'function')) throw Error('credit-sign:verification');
      const request = structuredClone(result.assignment);
      if (request.binding.creditTransactionDigest !== snapshot.digest) throw Error('credit-sign:verifier-binding');
      result.assertCurrent();
      const retained = assignment.assign(request);
      if (!['assigned','existing'].includes(retained.status)) throw Error('credit-sign:assignment-' + retained.status);
      result.assertCurrent();
      capabilities.set(hash(snapshot.reducedHex),{reducedHex:snapshot.reducedHex,txId:snapshot.txId,
        request,canonicalRequest:canonicalAssignment(request),assertCurrent:result.assertCurrent,revalidate:result.revalidate,
        refreshing:false,failed:false,permit:undefined});
      try { return await originalSign(snapshot.reduced,requiredSign,snapshot.inputs,snapshot.dataInputs); }
      finally { capabilities.delete(hash(snapshot.reducedHex)); }
    });
    // Retain settled or failed promises: a retry cannot silently create another
    // in-process signing attempt after an ambiguous outcome.
    requests.set(snapshot.txId,{digest:snapshot.digest,promise});
    return promise;
  };
  // Gate the participant's own entry too; trusted integration cannot accidentally
  // retain a raw sign method that bypasses this facade after installation.
  participant.sign = sign;
  return Object.freeze({
    sign,
    refreshContribution,
    isInSign: txId => participant.isInSign(txId),
    handleMessage: (message,peerId) => participant.handleMessage(message,peerId),
    handleMyTurn: () => participant.handleMyTurn(),
    cleanup: () => participant.cleanup(),
    invalidate: (obligationId,reason) => assignment.invalidate(obligationId,reason),
    close: () => { closed=true; capabilities.clear(); },
  });
}
