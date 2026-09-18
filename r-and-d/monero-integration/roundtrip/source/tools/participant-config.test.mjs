import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,renameSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {pinParticipantConfig} from './participant-config.mjs';

function temporary(){return mkdtempSync(join(tmpdir(),'participant-config-test-'));}

test('pins exact participant-config bytes and path, then rejects moved or changed authority',()=>{
  const root=temporary(),selected=join(root,'selected'),moved=join(root,'moved');
  mkdirSync(selected);
  const bytes=Buffer.from('{"index":7,"key":"benign-key"}\n','utf8');
  const file=join(selected,'participant.json');
  writeFileSync(file,bytes,{flag:'wx'});
  const pin=pinParticipantConfig(file);
  assert.equal(pin.file,file);
  assert.doesNotThrow(()=>pin.verify());

  renameSync(selected,moved);
  assert.throws(()=>pin.verify());

  mkdirSync(selected);
  writeFileSync(file,bytes,{flag:'wx'});
  assert.doesNotThrow(()=>pin.verify());
  writeFileSync(file,'{"index":7,"key":"benign-key","changed":"yes"}\n');
  assert.throws(()=>pin.verify(),/bytes drift/);
  writeFileSync(file,bytes);
  assert.doesNotThrow(()=>pin.verify());
});

test('actual child rejects a wrong expected digest before parsing config authority',()=>{
  const root=temporary(),file=join(root,'invalid-authority.json');
  writeFileSync(file,'benign-but-not-json\n',{flag:'wx'});
  const moduleUrl=pathToFileURL(fileURLToPath(new URL('./participant-config.mjs',import.meta.url))).href;
  const program=`import {readParticipantConfig} from ${JSON.stringify(moduleUrl)};try{readParticipantConfig();process.exit(3);}catch(error){if(!/Participant configuration digest mismatch/.test(error.message))process.exit(2);process.stdout.write('digest-rejected');}`;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',program],{
    cwd:root,
    env:{...process.env,PARTICIPANT_CONFIG:file,PARTICIPANT_CONFIG_SHA256:'0'.repeat(64)},
    encoding:'utf8',
    windowsHide:true,
    timeout:3_000,
    maxBuffer:8*1024,
  });
  assert.equal(child.error,undefined);
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stdout,'digest-rejected');
});
