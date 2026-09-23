/**
 * scripts/typecheck.mjs — run `tsc --noEmit` over types/.
 *
 * typescript is an optionalDependency (it is also a runtime optional dep of
 * lib/code-index/workspace-indexer.js). If it did not install, say so plainly;
 * set PLUR1BUS_TYPECHECK_OPTIONAL=1 to downgrade that to a warning.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

if (!existsSync(tsc)) {
  const message = "typecheck: typescript is not installed (optionalDependency); run `npm install typescript`";
  if (process.env.PLUR1BUS_TYPECHECK_OPTIONAL === "1") {
    console.warn(`${message} — skipped`);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

const result = spawnSync(tsc, ["--noEmit", "-p", join(root, "tsconfig.json")], {
  stdio: "inherit",
  cwd: root,
});
process.exit(result.status ?? 1);
