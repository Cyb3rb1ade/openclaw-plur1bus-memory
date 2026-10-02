// tests/helpers/lock-interop-worker.mjs — TEST ONLY: a Node contender for the shared bindings-registry lock
// (binding.mjs withRegistryLock) in tests/dist-hermes-lock-interop.test.js; the same event protocol as
// lock-interop-worker.py: E (entered), after assertHeld() L (lock lost, nothing written) or W (the guarded
// read-modify-write of <home>/counter ran), then X (left); every `dieEvery`-th hold D, then SIGKILL while holding.
// Usage: node lock-interop-worker.mjs <plur1bus home> <id> <dieEvery> <untilMs>
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RegistryLockLost, withRegistryLock } from "../../scripts/dist/installer/hermes/binding.mjs";
import { sleepSync } from "../../scripts/dist/installer/fsutil.mjs";

const [home, id, dieEvery, until] = process.argv.slice(2);
const events = join(home, "events.log");
const counter = join(home, "counter");
const log = (kind, seq) => appendFileSync(events, `${kind} ${id} ${seq}\n`);
let seq = 0;
while (Date.now() < Number(until)) {
  try {
    withRegistryLock(home, ({ assertHeld }) => {
      seq++;
      log("E", seq);
      sleepSync(2);
      try {
        assertHeld();
      } catch (err) {
        if (!(err instanceof RegistryLockLost)) throw err;
        log("L", seq);
        log("X", seq);
        return;
      }
      if (seq % Number(dieEvery) === 0) {
        log("D", seq);
        process.kill(process.pid, "SIGKILL"); // dies holding the lock (TerminateProcess on Windows)
      }
      const n = existsSync(counter) ? Number(readFileSync(counter, "utf8") || "0") : 0;
      writeFileSync(counter, String(n + 1));
      log("W", seq);
      log("X", seq);
    });
  } catch (err) {
    if (err?.code !== "LOCK_TIMEOUT") throw err;
  }
}
