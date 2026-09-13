import { describe, expect, it } from 'vitest';
import { consumeVerifiedAgreement } from './txAgreement';

describe('opaque verified agreement receipt', () => {
  it.each([null, undefined, true, 'receipt', 1, {}, Object.freeze({})])('rejects unissued receipt %#', value => {
    expect(() => consumeVerifiedAgreement(value)).toThrow();
  });
  it('structural approved certificate never becomes an issued token', () => {
    const certificate = Object.freeze({txJson:'{}',txId:'a'.repeat(64),txDataHash:'b'.repeat(64),signatures:Object.freeze(['signature']),timestamp:0,publicKeys:Object.freeze(['public-key']),protocolVersion:'1.0.0',requiredSign:1});
    expect(() => consumeVerifiedAgreement(certificate)).toThrow();
    expect(() => consumeVerifiedAgreement(certificate)).toThrow();
    expect(() => consumeVerifiedAgreement({certificate,provenance:{}})).toThrow();
  });
});
