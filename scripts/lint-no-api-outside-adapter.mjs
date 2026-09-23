/**
 * scripts/lint-no-api-outside-adapter.mjs
 *
 * The OpenClaw plugin API surface may only be touched by the adapter. Engine
 * code reaches the host through `HostServices` (lib/host-services.js) instead.
 *
 * Allowed to reference `api.`:
 *   - index.js                                       (the plugin shell)
 *   - adapter/**                                     (the OpenClaw adapter)
 *   - lib/setup/*-plugin-runtime.js                  (gateway/CLI runtimes)
 *   - lib/runtime-shutdown.js                        (lifecycle + runtimeIfUsable)
 *   - lib/providers/openclaw-memory-embedding-adapters.js
 *   - lib/providers/scoped-embedding-ipc.js          (registerService seam)
 *   - lib/host-services.js                           (the seam itself)
 *
 * Everything else under lib/ and all of engine/ must be clean.
 *
 * Exits 1 and prints file:line for every violation.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Optional root argument. The repo is the default; the test suite points this
// at a tmpdir so its fixtures never touch the working tree (a crashed test run
// must not be able to leave a probe module behind that then fails `npm run
// lint` for everyone).
const root = process.argv[2]
  ? resolve(process.argv[2])
  : join(dirname(fileURLToPath(import.meta.url)), "..");

const SCANNED_ROOTS = ["lib", "engine"];

const ALLOWED_EXACT = new Set([
  "index.js",
  "lib/runtime-shutdown.js",
  "lib/host-services.js",
  "lib/providers/openclaw-memory-embedding-adapters.js",
  "lib/providers/scoped-embedding-ipc.js",
]);

const ALLOWED_PATTERNS = [
  /^adapter\//,
  /^lib\/setup\/[^/]+-plugin-runtime\.js$/,
];

/** `api.x` but not `foo.api.x`, not `myapi.x`, and not `https://api.host/…`. */
const API_REFERENCE = /(?<![.\w$/-])api\s*\./;

/**
 * Remove block comments and everything after a `//`. Crude on purpose: it also
 * truncates a line at a URL's `//`, which is exactly what we want, since a
 * hostname is never a reference to the plugin API.
 * @param {string} line Source line.
 * @returns {string} Line with comments removed.
 */
function stripComments(line) {
  return line.replace(/\/\*.*?\*\//g, " ").replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
}

function isAllowed(relativePath) {
  if (ALLOWED_EXACT.has(relativePath)) return true;
  return ALLOWED_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function* walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      yield full;
    }
  }
}

const violations = [];
for (const scanRoot of SCANNED_ROOTS) {
  const base = join(root, scanRoot);
  try {
    if (!statSync(base).isDirectory()) continue;
  } catch {
    continue;
  }
  for (const file of walk(base)) {
    const relativePath = relative(root, file).split(sep).join("/");
    if (isAllowed(relativePath)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (API_REFERENCE.test(stripComments(line))) violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
    });
  }
}

if (violations.length > 0) {
  console.error("The OpenClaw `api` surface is only reachable from the adapter.");
  console.error("Use the injected HostServices (lib/host-services.js) instead.\n");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(`\n${violations.length} violation(s)`);
  process.exit(1);
}
console.log("lint-no-api-outside-adapter: clean");
