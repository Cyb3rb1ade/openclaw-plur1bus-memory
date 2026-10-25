import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('actual Python helper and wrapper offline integration',()=>{
 for (const file of ['telegram-speech-helper.test.py','telegram-speech-wrappers.test.py','telegram-speech-deploy.test.py','telegram-speech-routing.test.py']) {
  const result=spawnSync('python3',[new URL(file,import.meta.url).pathname],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
 }
});
