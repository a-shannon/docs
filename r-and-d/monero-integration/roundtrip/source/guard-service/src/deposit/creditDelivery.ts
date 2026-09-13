/** Synthetic delivery profile only; neither a Rosen certificate nor chain settlement. */
export interface DeliveryTarget {
  id: string;
  profile: string;
}
export interface DeliveryClaim {
  obligationId: string;
  payloadHash: string;
  payload: string;
  destinationId: string;
  destinationProfile: string;
  owner: string;
  generation: string;
  leaseUntil: string;
}
export interface DurableAcknowledgement {
  mode: 'synthetic';
  destinationId: string;
  destinationProfile: string;
  obligationId: string;
  payloadHash: string;
  result: string;
}
/** Trusted composition verifies destination durability, not just transport success. */
export interface AcknowledgementVerifier {
  verify(
    raw: unknown,
    expected: Readonly<DeliveryClaim>,
  ): Promise<DurableAcknowledgement | undefined>;
}
export type ClaimResult =
  | { status: 'claimed'; claim: DeliveryClaim }
  | { status: 'busy' | 'delivered' | 'missing' | 'target-conflict' };
export const MAX_DELIVERY_INTEGER = (1n << 64n) - 1n;
export function boundedInteger(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_DELIVERY_INTEGER)
    throw new Error('Invalid exact delivery integer');
  return value;
}
export function storedInteger(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value))
    throw new Error('Invalid stored delivery integer');
  return boundedInteger(BigInt(value));
}
export function identityString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}
export function acknowledgementBytes(
  value: unknown,
  claim: DeliveryClaim,
): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const ack = value as DurableAcknowledgement;
  const keys = [
    'mode',
    'destinationId',
    'destinationProfile',
    'obligationId',
    'payloadHash',
    'result',
  ];
  if (
    Object.keys(ack).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(ack, key)) ||
    ack.mode !== 'synthetic' ||
    ack.destinationId !== claim.destinationId ||
    ack.destinationProfile !== claim.destinationProfile ||
    ack.obligationId !== claim.obligationId ||
    ack.payloadHash !== claim.payloadHash ||
    typeof ack.result !== 'string' ||
    !ack.result.length ||
    ack.result.length > 4096
  )
    return;
  return JSON.stringify({
    mode: ack.mode,
    destinationId: ack.destinationId,
    destinationProfile: ack.destinationProfile,
    obligationId: ack.obligationId,
    payloadHash: ack.payloadHash,
    result: ack.result,
  });
}
