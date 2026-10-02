// tests/helpers/lock-interop-worker.mjs — TEST ONLY: a Node contender for the shared bindings-registry lock
// (binding.mjs withRegistryLock) in tests/dist-hermes-lock-interop.test.js; the same event protocol as
// lock-interop-worker.py: E (entered), after assertHeld() L (lock lost, nothing written) or W (the guarded
// read-modify-write of <home>/counter ran, a few ms after the check), then X (left); every `dieEvery`-th hold (0 =
// never) D, then SIGKILL while holding. Each event is one appendFileSync (libuv opens O_APPEND, FILE_APPEND_DATA on
// Windows: one atomic append). Stops when `untilMs` passes or the stop file exists.
// Usage: node lock-interop-worker.mjs <plur1bus home> <id> <dieEvery> <untilMs> <stop file>
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RegistryLockLost, withRegistryLock } from "../../scripts/dist/installer/hermes/binding.mjs";
import { sleepSync } from "../../scripts/dist/installer/fsutil.mjs";

const [home, id, dieEvery, until, stop] = process.argv.slice(2);
const events = join(home, "events.log");
const counter = join(home, "counter");
const log = (kind, seq) => appendFileSync(events, `${kind} ${id} ${seq}\n`);
let seq = 0;
while (Date.now() < Number(until) && !existsSync(stop)) {
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
      if (Number(dieEvery) && seq % Number(dieEvery) === 0) {
        log("D", seq);
        process.kill(process.pid, "SIGKILL"); // dies holding the lock (TerminateProcess on Windows)
      }
      sleepSync(3); // the write itself takes a moment: a holder displaced now must never write
      const n = existsSync(counter) ? Number(readFileSync(counter, "utf8") || "0") : 0;
      writeFileSync(counter, String(n + 1));
      log("W", seq);
      log("X", seq);
    });
  } catch (err) {
    if (err?.code !== "LOCK_TIMEOUT") throw err;
  }
}
