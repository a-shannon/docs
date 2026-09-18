import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {captureContributionPackage,contributionPackageFiles} from './contribution-package.mjs';
const names=['package.json','dist/const.js','dist/index.js','dist/multiSigHandler.js','dist/multiSigUtils.js','dist/types.js'];
const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'contribution-package-'));mkdirSync(join(root,'dist'));
  for(const file of names)writeFileSync(join(root,file),file==='package.json'?JSON.stringify({name:'@rosen-bridge/ergo-multi-sig',version:'3.0.1',main:'dist/index.js',type:'module'}):'export const test=1;');
  const sha256=sha(names.map(file=>{const bytes=readFileSync(join(root,file));return file+'\0'+sha(bytes)+'\0'+bytes.length+'\n';}).join(''));
  return {root,sha256};
}
test('fixed package closure verifies and rejects undeclared modules and wrong pins',()=>{
  const cfg=fixture(),pin=captureContributionPackage({...cfg,commit:'1'.repeat(40)});pin.verify();assert(pin.read(pin.entry).length>0);
  assert.deepEqual(pin.files.map(row=>row.name),contributionPackageFiles);assert(pin.files.every(row=>row.path.startsWith(pin.root)&&/^[0-9a-f]{64}$/.test(row.sha256)));
  assert.throws(()=>pin.read(pin.prefix+'dist/unreviewed.js'),/undeclared/);
  assert.throws(()=>captureContributionPackage({...cfg,sha256:'00'.repeat(32)}),/pin/);
  assert.throws(()=>captureContributionPackage({...cfg,commit:'00'}),/commit/);
  assert.throws(()=>captureContributionPackage({...cfg,extra:1}),/configuration/);
});
for(const file of names)test('package mutation refuses '+file,()=>{
  const cfg=fixture(),pin=captureContributionPackage(cfg);writeFileSync(join(cfg.root,file),'changed');
  assert.throws(()=>pin.verify(),/changed/);
});
test('caller mutation cannot replace retained package location or pin',()=>{
  const cfg=fixture(),pin=captureContributionPackage(cfg),entry=pin.entry;
  cfg.root='missing';cfg.sha256='00'.repeat(32);
  pin.verify();assert.equal(pin.entry,entry);assert.notEqual(pin.sha256,cfg.sha256);
});
