const unavailable=new Proxy(function(){throw Error('Isolated service accessed');},{get(){throw Error('Isolated service accessed');},apply(){throw Error('Isolated service accessed');},construct(){throw Error('Isolated service accessed');}});
export const DatabaseAction=unavailable;
export const ChainNativeToken=unavailable;
export default unavailable;
