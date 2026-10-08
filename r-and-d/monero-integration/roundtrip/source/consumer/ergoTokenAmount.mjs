import assert from 'node:assert/strict';

export const ERGO_ASSET_AMOUNT_LIMIT=9223372036854775807n;

/** Each Ergo token output is a positive signed 64-bit amount. */
export function assertErgoTokenAmount(amount,role){
  assert(typeof amount==='bigint'&&amount>=1n&&amount<=ERGO_ASSET_AMOUNT_LIMIT,
    `Ergo token ${role} amount`);
  return amount;
}

export function checkedErgoCreditAmounts(gross,bridgeFee,networkFee){
  const fee=assertErgoTokenAmount(bridgeFee+networkFee,'fee');
  const net=assertErgoTokenAmount(gross-fee,'recipient');
  return {fee,net};
}
