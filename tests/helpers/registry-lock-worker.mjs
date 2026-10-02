// tests/helpers/registry-lock-worker.mjs — TEST ONLY: one contender for the shared bindings-registry lock
// (binding.mjs withRegistryLock). Inside the lock it creates <home>/hosts/inside with O_EXCL (a second holder at the
// same time cannot) and logs a double entry when that fails; every `dieEvery`-th entry it removes the marker and exits
// while still holding the lock, as a killed installer would (its pid is then dead and the lock stale after 1 s).
// Usage: node registry-lock-worker.mjs <plur1bus home> <id> <dieEvery> <untilMs>
import { appendFileSync, closeSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";

import { withRegistryLock } from "../../scripts/dist/installer/hermes/binding.mjs";

const [home, id, dieEvery, until] = process.argv.slice(2);
const marker = join(home, "hosts", "inside");
let n = 0;
while (Date.now() < Number(until)) {
  try {
    withRegistryLock(home, () => {
      let fd;
      try {
        fd = openSync(marker, "wx");
      } catch {
        appendFileSync(join(home, "doubles.log"), `${id} DOUBLE ${Date.now()}\n`);
        return;
      }
      const t = Date.now();
      while (Date.now() - t < 2) {
        // hold it briefly
      }
      closeSync(fd);
      n++;
      appendFileSync(join(home, "entries.log"), `${id}\n`);
      rmSync(marker, { force: true });
      if (n % Number(dieEvery) === 0) {
        appendFileSync(join(home, "deaths.log"), `${id}\n`);
        process.exit(3); // dies holding the lock: the next holder must break it as stale
      }
    });
  } catch {
    // deadline: try again
  }
}
