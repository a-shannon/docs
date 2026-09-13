import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import {assertExternalWork,freezeInputs,sha256} from './launcher-guards.mjs';
function temporary(t){
  const root=mkdtempSync(join(tmpdir(),'roundtrip-launcher-test-'));
  t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert(basename(root).startsWith('roundtrip-launcher-test-'));rmSync(root,{recursive:true,force:true});});
  return root;
}
test('rejects overlap in both directions for source, prepared roots and executable paths',t=>{
  const root=temporary(t);
  for(const role of ['source','rosen','ergo','binary']){
    const protectedPath=join(root,role);mkdirSync(protectedPath);
    assert.throws(()=>assertExternalWork(join(protectedPath,'absent','work'),[protectedPath]),/overlaps/);
    assert.throws(()=>assertExternalWork(root,[protectedPath]),/overlaps/);
    assert.throws(()=>assertExternalWork(protectedPath,[protectedPath]),/overlaps/);
    assert.doesNotThrow(()=>assertExternalWork(join(root,role+'-separate'),[protectedPath]));
  }
});
test('resolves a junction ancestor before checking an absent child',t=>{
  const root=temporary(t),prepared=join(root,'prepared'),alias=join(root,'alias');mkdirSync(prepared);
  symlinkSync(prepared,alias,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>assertExternalWork(join(alias,'new','work'),[prepared]),/overlaps/);
});
test('Windows path casing cannot bypass overlap', {skip:process.platform!=='win32'},t=>{
  const root=temporary(t),prepared=join(root,'Prepared');mkdirSync(prepared);
  assert.throws(()=>assertExternalWork(join(prepared.toUpperCase(),'NEW','work'),[prepared.toLowerCase()]),/overlaps/);
});
function pinnedFixture(t){
  const root=temporary(t),gitRoot=join(root,'repo');mkdirSync(gitRoot);
  execFileSync('git',['init','--quiet',gitRoot],{windowsHide:true});
  // Detached fixture HEADs exercise real Git reference reads without authoring commits.
  const expectedHead='1'.repeat(40);writeFileSync(join(gitRoot,'.git/HEAD'),expectedHead+'\n');
  const names=['prepared.js','package.json','package-lock.json','manifest.json','copied.js','copied-manifest.json','caller-config.json','runtime-config.json','native.bin','daemon.bin','node.bin'];
  const files=names.map(name=>{const path=join(root,name);writeFileSync(path,name);return {path,sha256:sha256(readFileSync(path))};});
  return {root,gitRoot,expectedHead,files};
}
for(const name of ['prepared.js','package.json','package-lock.json','manifest.json','copied.js','copied-manifest.json','caller-config.json','runtime-config.json','native.bin','daemon.bin','node.bin']){
  test('post-run validation rejects a changed '+name,t=>{
    const input=pinnedFixture(t),closure=freezeInputs(input);assert.equal(closure.verify(),true);
    writeFileSync(join(input.root,name),'changed');assert.throws(()=>closure.verify(),/Declared input changed/);
  });
}
test('post-run validation rejects prepared Git HEAD drift',t=>{
  const input=pinnedFixture(t),closure=freezeInputs(input);
  writeFileSync(join(input.gitRoot,'.git/HEAD'),'2'.repeat(40)+'\n');assert.throws(()=>closure.verify(),/Git head changed/);
});
test('declared external proof-pin checks run before and after execution',t=>{
  const input=pinnedFixture(t);let valid=true,count=0;
  const closure=freezeInputs({...input,checks:[()=>{count++;assert(valid,'proof pin changed');}]});
  assert.equal(count,1);valid=false;assert.throws(()=>closure.verify(),/proof pin changed/);assert.equal(count,2);
});
test('post-run validation reuses exact source-set validation',t=>{
  const input=pinnedFixture(t);let complete=true;
  const closure=freezeInputs({...input,validateSets:()=>{assert(complete,'source set changed');}});
  complete=false;assert.throws(()=>closure.verify(),/source set changed/);
});
test('post-run validation rejects retargeted dependency junction with identical file bytes',t=>{
  const input=pinnedFixture(t),first=join(input.root,'first'),second=join(input.root,'second'),link=join(input.root,'dependency');
  mkdirSync(first);mkdirSync(second);writeFileSync(join(first,'x'),'same');writeFileSync(join(second,'x'),'same');
  symlinkSync(first,link,process.platform==='win32'?'junction':'dir');
  const closure=freezeInputs({...input,files:[...input.files,{path:join(link,'x'),sha256:sha256('same')}]});
  rmSync(link);symlinkSync(second,link,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>closure.verify(),/Declared input changed/);
});
