/**
 * scripts/typecheck.mjs — run `tsc --noEmit` over types/.
 *
 * typescript is an optionalDependency (it is also a runtime optional dep of
 * lib/code-index/workspace-indexer.js). If it did not install, say so plainly;
 * set PLUR1BUS_TYPECHECK_OPTIONAL=1 to downgrade that to a warning.
 *
 * The compiler is located with require.resolve rather than by probing
 * node_modules/.bin: the shim there is absent under some hoisted or
 * pnpm-style layouts (a false "not installed"), and on Windows it is a .cmd
 * that spawnSync refuses to execute without a shell. Resolving the package
 * and running its tsc entry point with this same node binary avoids both.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** @returns {string | null} absolute path to a runnable tsc entry point. */
function resolveTsc() {
  let pkgDir;
  try {
    // typescript's main is <pkgDir>/lib/typescript.js.
    pkgDir = dirname(dirname(require.resolve("typescript")));
  } catch {
    return null;
  }
  // Node's resolver falls back to the global folders ($HOME/.node_modules,
  // $PREFIX/lib/node) after exhausting the node_modules chain. A global
  // TypeScript of some other version silently checking a frozen contract is
  // worse than a loud miss, so say which compiler is in use when it is not the
  // pinned one. Still run it: a hoisted monorepo layout is legitimately above
  // this package's own root.
  if (!pkgDir.startsWith(join(root, "node_modules"))) {
    console.warn(`typecheck: using TypeScript from ${pkgDir} (outside ${join(root, "node_modules")}); the pinned optionalDependency is not installed here`);
  }
  for (const candidate of [join(pkgDir, "bin", "tsc"), join(pkgDir, "lib", "tsc.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const tsc = resolveTsc();

if (!tsc) {
  const message = "typecheck: typescript is not installed (optionalDependency); run `npm install typescript`";
  if (process.env.PLUR1BUS_TYPECHECK_OPTIONAL === "1") {
    console.warn(`${message} — skipped`);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsc, "--noEmit", "-p", join(root, "tsconfig.json")], {
  stdio: "inherit",
  cwd: root,
});

if (result.error) {
  console.error(`typecheck: could not run ${tsc}: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`typecheck: tsc terminated by signal ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
