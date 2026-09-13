import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire,isBuiltin} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(config.rosenRoot+'/package.json');
const ts=require('typescript');
const base=sourceRoot+'/watcher';
export async function producer(deployment) {
  const c=deployment.contracts,t=deployment.tokens;
  const config={general:{minBoxValue:'1000000',fee:'1100000',address:deployment.fundingAddress},rosen:{rwtRepoNFT:t.RWTRepoNFT,RWTId:t.RWT,RSN:t.Asset,AWC:t.WID,repoConfigNFT:t.RepoConfigNFT,watcherPermitAddress:c.Permit.address,RWTRepoAddress:deployment.fundingAddress,watcherCollateralAddress:deployment.fundingAddress,repoConfigAddress:deployment.fundingAddress,emissionAddress:deployment.fundingAddress,emissionNFT:t.CleanupNFT,eventTriggerAddress:c.EventTrigger.address}};
  const names=['src/ergo/boxes.ts','src/ergo/utils.ts','src/utils/utils.ts','src/config/constants.ts'];
  const modules=new Map();
  const forbidden=name=>new Proxy(function(){throw Error('Unused port '+name);},{get(){throw Error('Unused port '+name);}});
  const synthetic=(key,exports)=>{if(!modules.has(key))modules.set(key,new vm.SyntheticModule(Object.keys(exports),function(){for(const [n,v]of Object.entries(exports))this.setExport(n,v);},{identifier:key}));return modules.get(key);};
  const source=name=>{if(!modules.has(name))modules.set(name,new vm.SourceTextModule(ts.transpileModule(fs.readFileSync(base+'/'+name,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace("assert { type: 'json' }","with { type: 'json' }"),{identifier:name}));return modules.get(name);};
  async function linker(specifier,ref) {
    if(!specifier.startsWith('.'))return synthetic(specifier,await import(isBuiltin(specifier)?specifier:pathToFileURL(require.resolve(specifier))));
    const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(ref.identifier),specifier));
    if(names.includes(resolved+'.ts'))return source(resolved+'.ts');
    const ports={'src/config/config':{getConfig:()=>config},'src/ergo/network/ergoNetwork':{ErgoNetwork:forbidden('network')},'src/errors/errors':{NotEnoughFund:class extends Error{},NoWID:class extends Error{},ChangeBoxCreationError:class extends Error{}},'src/config/tokensConfig':{TokensConfig:forbidden('tokens')},'src/api/Transaction':{Transaction:forbidden('tx')},'src/init':{watcherDatabase:forbidden('db')},'package.json':{default:{version:'6.3.2'}}};
    assert(ports[resolved],resolved);return synthetic(resolved,ports[resolved]);
  }
  const m=source(names[0]);await m.link(linker);await m.evaluate();
  return new m.namespace.Boxes(forbidden('db'));
}
