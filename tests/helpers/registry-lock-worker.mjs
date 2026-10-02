// tests/helpers/registry-lock-worker.mjs — TEST ONLY: one contender for the shared bindings-registry lock
// (binding.mjs withRegistryLock) in the JS-only contention test of tests/dist-hermes-install.test.js. Per hold it
// appends to <home>/events.log (tests/helpers/lock-events.mjs format, with a timestamp): E (entered), then it calls
// assertHeld(): L when that refuses (RegistryLockLost; nothing is written), else W after the guarded write (one line
// appended to <home>/entries.log, a few ms after the check), then X (left). Every `dieEvery`-th hold (0 = never) it
// logs D after the check and exits while still holding the lock, as a killed installer would (its pid is then dead
// and the lock stale after 1 s). Each line is one appendFileSync: libuv opens O_APPEND (FILE_APPEND_DATA on Windows),
// so every append is atomic across processes.
// Usage: node registry-lock-worker.mjs <plur1bus home> <id> <dieEvery> <untilMs>
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { sleepSync } from "../../scripts/dist/installer/fsutil.mjs";
import { RegistryLockLost, withRegistryLock } from "../../scripts/dist/installer/hermes/binding.mjs";

const [home, id, dieEvery, until] = process.argv.slice(2);
const log = (kind, seq) => appendFileSync(join(home, "events.log"), `${kind} ${id} ${seq} ${Date.now()}\n`);
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
        log("L", seq); // displaced (FR-L1): the write is refused
        log("X", seq);
        return;
      }
      if (Number(dieEvery) && seq % Number(dieEvery) === 0) {
        log("D", seq);
        process.exit(3); // dies holding the lock, before writing: the next holder must break it as stale
      }
      sleepSync(3); // the guarded write itself takes a moment
      appendFileSync(join(home, "entries.log"), `${id} ${seq}\n`);
      log("W", seq);
      log("X", seq);
    });
  } catch (err) {
    if (err?.code !== "LOCK_TIMEOUT") throw err;
  }
}
