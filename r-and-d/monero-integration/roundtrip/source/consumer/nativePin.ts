import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
// The test runner supplies the independently computed native executable pin.
const sha256=process.env.MONERO_NODE_NATIVE_SHA256;
if(!sha256||!/^[0-9a-f]{64}$/.test(sha256))throw Error('Node fixture native pin required');
export const nativePin=Object.freeze({path:config.nativeBinary,sha256,runtime:config.runtimeDirectory});
