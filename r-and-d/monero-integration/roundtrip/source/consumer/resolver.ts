import type { AbstractChain } from '@rosen-chains/abstract-chain';
import {getRewardChain} from './rewardPorts';
let active:AbstractChain<unknown>|undefined;
export function setFixtureChain(chain:AbstractChain<unknown>|undefined){active=chain;}
export function getChain(network:'ergo'):ReturnType<typeof getRewardChain>;
export function getChain(network:'monero'):AbstractChain<unknown>;
export function getChain(network:string):AbstractChain<unknown>|ReturnType<typeof getRewardChain>;
export function getChain(network:string):AbstractChain<unknown>|ReturnType<typeof getRewardChain>{if(network==='ergo')return getRewardChain();if(network!=='monero'||!active||active.CHAIN!==network)throw Error('Unsupported or unavailable local chain');return active;}
export default Object.freeze({getInstance:()=>Object.freeze({getChain,getErgoChain:getRewardChain})});
