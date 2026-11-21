import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The Telegram TTS wrappers are bash scripts for the Linux host. They use
// associative arrays (bash >= 4); macOS ships bash 3.2 and Windows has no
// POSIX shell on the default runner. Probe the capability instead of guessing.
function wrapperRuntimeMissing() {
  if (process.platform === 'win32') return 'Telegram TTS wrappers are POSIX bash scripts for the Linux host; not run on win32';
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (python.status !== 0) return 'python3 is not available on this runner';
  // Probe through python3 exactly as the wrapper tests start the scripts
  // (subprocess.run(['bash', …])): on macOS runners node and python can
  // resolve different `bash` binaries (Homebrew 5.x vs. system 3.2).
  const probe = 'import subprocess,sys; sys.exit(subprocess.run(["bash","-c","declare -A probe=([k]=v); [ \\"${probe[k]}\\" = v ]"]).returncode)';
  const bash = spawnSync('python3', ['-c', probe], { encoding: 'utf8' });
  if (bash.status !== 0) return 'Telegram TTS wrappers need bash >= 4 (associative arrays); the bash the wrapper tests start is older (macOS ships 3.2)';
  return false;
}

test('actual Python helper and wrapper offline integration', { skip: wrapperRuntimeMissing() }, () => {
 for (const file of ['telegram-speech-helper.test.py','telegram-speech-wrappers.test.py','telegram-speech-deploy.test.py','telegram-speech-routing.test.py']) {
  const result=spawnSync('python3',[fileURLToPath(new URL(file,import.meta.url))],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
 }
});
