import * as wasm from 'ergo-lib-wasm-nodejs';
import { createHash } from 'node:crypto';

import { ErgoTransaction } from '@rosen-chains/ergo';

import { digest } from '../db/depositRegistry';
import type { DurableCreditPreparation } from '../db/ergoCreditRegistry';
import { canonicalDecision } from './depositAdmission';
import { exactHex, parseCanonical } from './ergoCreditAdmission';
import {
  contextFromDescriptor,
  type VerifiedUnsignedCredit,
} from './ergoCreditConsumer';

export interface SignedCreditRecord {
  obligationId: string;
  preparationHash: string;
  signedHex: string;
  signedHash: string;
  nativeTxId: string;
  verificationJson: string;
  verificationHash: string;
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const requireNative = (condition: boolean, reason: string) => {
  if (!condition) throw Error(reason);
};
/** Native reconstruction is validation only; it cannot issue an admission capability. */
export function nativePrepared(
  preparation: Readonly<DurableCreditPreparation>,
) {
  const candidate = parseCanonical(
    preparation.candidateJson,
    'native-candidate',
  ) as unknown as VerifiedUnsignedCredit;
  requireNative(
    digest(preparation.candidateJson) === preparation.candidateHash,
    'signing:candidate-hash',
  );
  requireNative(
    candidate.obligationId === preparation.obligationId,
    'signing:obligation',
  );
  requireNative(
    digest(candidate.contextJson) === candidate.contextDigest,
    'signing:context-digest',
  );
  const wrapper = ErgoTransaction.fromJson(candidate.transactionJson);
  requireNative(
    wrapper.getTxHexString() === candidate.reducedHex,
    'signing:wrapper-bytes',
  );
  requireNative(
    canonicalDecision(wrapper.getInputBoxesString()) ===
      canonicalDecision(candidate.inputHex),
    'signing:wrapper-inputs',
  );
  requireNative(
    canonicalDecision(wrapper.getDataInputsString()) ===
      canonicalDecision(candidate.dataInputHex),
    'signing:wrapper-data',
  );
  requireNative(wrapper.eventId === candidate.eventId, 'signing:wrapper-event');
  const reduced = wasm.ReducedTransaction.sigma_parse_bytes(
    Buffer.from(exactHex(candidate.reducedHex, 'reduced'), 'hex'),
  );
  requireNative(
    hex(reduced.sigma_serialize_bytes()) === candidate.reducedHex,
    'signing:reduced-canonical',
  );
  const unsigned = reduced.unsigned_tx();
  requireNative(wrapper.txId === unsigned.id().to_str(), 'signing:wrapper-id');
  const boxes = wasm.ErgoBoxes.empty(),
    data = wasm.ErgoBoxes.empty();
  const parse = (bytes: string) => {
    const box = wasm.ErgoBox.sigma_parse_bytes(
      Buffer.from(exactHex(bytes, 'box'), 'hex'),
    );
    requireNative(
      hex(box.sigma_serialize_bytes()) === bytes,
      'signing:box-canonical',
    );
    return box;
  };
  candidate.inputHex.forEach((b) => boxes.add(parse(b)));
  candidate.dataInputHex.forEach((b) => data.add(parse(b)));
  requireNative(unsigned.inputs().len() === boxes.len(), 'signing:input-count');
  for (let i = 0; i < boxes.len(); i++)
    requireNative(
      unsigned.inputs().get(i).box_id().to_str() ===
        boxes.get(i).box_id().to_str(),
      'signing:input-id',
    );
  requireNative(
    unsigned.data_inputs().len() === data.len(),
    'signing:data-count',
  );
  for (let i = 0; i < data.len(); i++)
    requireNative(
      unsigned.data_inputs().get(i).box_id().to_str() ===
        data.get(i).box_id().to_str(),
      'signing:data-id',
    );
  const context = contextFromDescriptor(JSON.parse(candidate.contextJson));
  const recomputed = wasm.ReducedTransaction.from_unsigned_tx(
    unsigned,
    boxes,
    data,
    context,
  );
  requireNative(
    hex(recomputed.sigma_serialize_bytes()) === candidate.reducedHex,
    'signing:reduction-context',
  );
  return { candidate, reduced, unsigned, boxes, data, context };
}
export function verifySignedPreparation(
  preparation: Readonly<DurableCreditPreparation>,
  signedHex: string,
): Readonly<SignedCreditRecord> {
  exactHex(signedHex, 'signed');
  const native = nativePrepared(preparation);
  const signed = wasm.Transaction.sigma_parse_bytes(
    Buffer.from(signedHex, 'hex'),
  );
  requireNative(
    hex(signed.sigma_serialize_bytes()) === signedHex,
    'signing:signed-canonical',
  );
  requireNative(
    signed.inputs().len() === native.unsigned.inputs().len(),
    'signing:proof-count',
  );
  const json = signed.to_js_eip12();
  const proofs = json.inputs.map(
    (input: { spendingProof: { proofBytes: string } }) => {
      const proof = input.spendingProof.proofBytes;
      requireNative(
        typeof proof === 'string' && /^(?:[0-9a-f]{2})*$/.test(proof),
        'signing:proof-encoding',
      );
      return Buffer.from(proof, 'hex');
    },
  );
  // from_unsigned_tx consumes this native handle; capture identity before the move.
  const unsignedTxId = native.unsigned.id().to_str();
  const projected = wasm.Transaction.from_unsigned_tx(native.unsigned, proofs);
  requireNative(
    hex(projected.sigma_serialize_bytes()) === signedHex,
    'signing:unsigned-correspondence',
  );
  requireNative(signed.id().to_str() === unsignedTxId, 'signing:native-id');
  for (let i = 0; i < signed.inputs().len(); i++)
    requireNative(
      wasm.verify_tx_input_proof(
        i,
        native.context,
        signed,
        native.boxes,
        native.data,
      ),
      `signing:native-proof:${i}`,
    );
  const signedHash = createHash('sha256')
      .update(Buffer.from(signedHex, 'hex'))
      .digest('hex'),
    nativeTxId = signed.id().to_str();
  const verificationJson = canonicalDecision({
    domain: 'rosen-monero-ergo-signed-verification',
    version: 1,
    preparationHash: preparation.preparationHash,
    candidateHash: preparation.candidateHash,
    contextDigest: native.candidate.contextDigest,
    unsignedTxId,
    nativeTxId,
    signedHash,
  });
  return Object.freeze({
    obligationId: preparation.obligationId,
    preparationHash: preparation.preparationHash,
    signedHex,
    signedHash,
    nativeTxId,
    verificationJson,
    verificationHash: digest(verificationJson),
  });
}
