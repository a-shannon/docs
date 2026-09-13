import type { DepositRegistry } from '../db/depositRegistry';
import type {
  AcknowledgementVerifier,
  DeliveryClaim,
  DeliveryTarget,
} from './creditDelivery';

export interface CreditWorker {
  registry: DepositRegistry;
  destination: AcknowledgementVerifier & { target: DeliveryTarget };
  owner: string;
  now(): bigint;
  lease: bigint;
  /** Transport wait bound only. Expiry cannot cancel a message already in flight. */
  timeoutMs?: number;
  send(claim: Readonly<DeliveryClaim>): Promise<unknown>;
}
/** One bounded attempt. A timeout or lost reply retains the claim until expiry. */
export async function deliverCredit(
  worker: CreditWorker,
  obligationId: string,
): Promise<{
  status: 'delivered' | 'busy' | 'missing' | 'target-conflict' | 'retry';
}> {
  try {
    const timeout = worker.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 60_000)
      return { status: 'retry' };
    const result = await worker.registry.claimDelivery(
      obligationId,
      worker.destination.target,
      worker.owner,
      worker.now(),
      worker.lease,
    );
    if (result.status !== 'claimed') return result;
    const claim = Object.freeze(result.claim);
    if (!(await worker.registry.validateDeliveryClaim(claim, worker.now())))
      return { status: 'retry' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raw: unknown;
    try {
      raw = await Promise.race([
        worker.send(claim),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Delivery transport timeout')),
            timeout,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return {
      status: (await worker.registry.acknowledgeDelivery(
        claim,
        raw,
        () => worker.now(),
        worker.destination,
      ))
        ? 'delivered'
        : 'retry',
    };
  } catch {
    return { status: 'retry' };
  }
}
