import {launchNative} from './adapter';
it.each(['wrong-tag','wrong-nonce','wrong-generation','ascii','oversize','stderr','partial','duplicate','timeout','canonical-invalid-frame'])('rejects private hostile host %s and awaits its retirement',async mode=>{process.env.W1HB_HOSTILE=mode;await expect(launchNative()).rejects.toThrow();});
