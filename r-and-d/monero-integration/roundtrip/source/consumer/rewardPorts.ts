import { AsyncLocalStorage } from 'node:async_hooks';
import type { ErgoChain } from '@rosen-chains/ergo';
import type { TokenMap } from '@rosen-bridge/tokens';
import { TokenHandler as FixtureTokenHandler } from './fixturePorts';

type RewardScope = {
  chain: ErgoChain;
  tokenMap: TokenMap;
  configs: Record<string, unknown>;
  eventBoxes: {
    getEventBox: (id: string) => Promise<string>;
    getEventValidCommitments: (...args: unknown[]) => Promise<string[]>;
  };
};
const scope = new AsyncLocalStorage<RewardScope>();
export function withRewardPorts<T>(ports: RewardScope, run: () => T): T {
  return scope.run(ports, run);
}
export function getRewardChain(): ErgoChain {
  const active = scope.getStore();
  if (!active) throw Error('Reward chain unavailable outside configured scope');
  return active.chain;
}
export const TokenHandler = Object.freeze({ getInstance: () => Object.freeze({
  getTokenMap: () => scope.getStore()?.tokenMap ?? FixtureTokenHandler.getInstance().getTokenMap(),
}) });
// Both upstream defaults use the same scoped object; unsupported access refuses.
export default new Proxy(Object.freeze({}), { get(_target, key: string) {
  const active = scope.getStore();
  if (!active) throw Error('Reward ports unavailable outside configured scope');
  if (key === 'getEventBox' || key === 'getEventValidCommitments') return active.eventBoxes[key];
  if (!Object.hasOwn(active.configs, key)) throw Error('Unsupported reward configuration: ' + key);
  return active.configs[key];
} });
