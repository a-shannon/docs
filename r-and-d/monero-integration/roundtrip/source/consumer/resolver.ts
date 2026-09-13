import type { AbstractChain } from '@rosen-chains/abstract-chain';
let active:AbstractChain<unknown>|undefined;
export function setFixtureChain(chain:AbstractChain<unknown>|undefined){active=chain;}
export function getChain(network:string):AbstractChain<unknown>{if(network!=='monero'||!active||active.CHAIN!==network)throw Error('Unsupported or unavailable local chain');return active;}
export default Object.freeze({getInstance:()=>Object.freeze({getChain})});
