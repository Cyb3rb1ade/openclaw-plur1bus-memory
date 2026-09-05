import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('native Hermes desktop plugin preserves profile, lifecycle and scoped action boundaries', () => {
  execFileSync(process.execPath, ['--experimental-vm-modules',
    fileURLToPath(new URL('../hermes-dashboard/plur1bus/desktop/test-harness.mjs', import.meta.url))],
  { stdio: 'pipe', timeout: 15000 });
});
