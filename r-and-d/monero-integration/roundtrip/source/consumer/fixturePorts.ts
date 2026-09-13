import {TokenMap} from '@rosen-bridge/tokens';
let map:TokenMap|undefined;
export async function configureFixtureTokens(rows:Parameters<TokenMap['updateConfigByJson']>[0]) {
  const next=new TokenMap();await next.updateConfigByJson(structuredClone(rows));map=next;
}
export const TokenHandler=Object.freeze({getInstance:()=>Object.freeze({getTokenMap:()=>{if(!map)throw Error('Fixture map absent');return map;}})});
export const RevenuePeriod=Object.freeze({});
