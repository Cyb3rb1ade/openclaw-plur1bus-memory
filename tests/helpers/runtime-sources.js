/**
 * tests/helpers/runtime-sources.js
 *
 * One place that knows where the plugin's runtime source files live.
 *
 * A dozen guards read `index.js` as *text* and assert on call sites rather
 * than behaviour. PR-03 moved most of those call sites into `engine/**` and
 * `adapter/openclaw/**`, and each move meant editing a hand-maintained list of
 * file paths in every one of those guards — Tasks 13 to 17 each edited the
 * same lists again. This helper holds the list once.
 *
 * `readRuntimeSources()` returns the file *contents*, not paths:
 *
 *   const { index, engine, adapter, all } = readRuntimeSources();
 *   assert.match(engine.captureTurn, /…/);
 *   assert.ok(all.some((source) => /…/.test(source)));
 *
 * `all` is `[index, ...every engine module, ...every adapter module]`, in that
 * order, and is what a guard should reduce over when a call site may live in
 * any of them.
 *
 * The map is checked against the tree on every call: adding a module under
 * `engine/` or `adapter/openclaw/` without listing it here throws, so a new
 * module cannot quietly fall outside every source guard.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Host-neutral engine modules, by short name. */
const ENGINE_PATHS = Object.freeze({
  assemblePromptContext: "engine/recall/assemble-prompt-context.js",
  captureTurn: "engine/capture/capture-turn.js",
  checkpointStore: "engine/checkpoint/checkpoint-store.js",
  events: "engine/events.js",
  internalJobBodies: "engine/jobs/internal-job-bodies.js",
  jobLedger: "engine/jobs/job-ledger.js",
  jobRegistry: "engine/jobs/job-registry.js",
  jobSpecs: "engine/jobs/job-specs.js",
  memoryTools: "engine/tools/memory-tools.js",
  minimalMaintenance: "engine/recall/minimal-maintenance.js",
  plur1busCommand: "engine/commands/plur1bus-command.js",
  recallResult: "engine/recall/recall-result.js",
});

/** OpenClaw adapter modules, by short name. */
const ADAPTER_PATHS = Object.freeze({
  captureHook: "adapter/openclaw/register-capture-hook.js",
  commands: "adapter/openclaw/register-commands.js",
  cron: "adapter/openclaw/register-cron.js",
  gateway: "adapter/openclaw/register-gateway.js",
  joinRecall: "adapter/openclaw/join-recall.js",
  maintenanceHook: "adapter/openclaw/register-maintenance-hook.js",
  promptSupplements: "adapter/openclaw/register-prompt-supplements.js",
  recallHook: "adapter/openclaw/register-recall-hook.js",
  tools: "adapter/openclaw/register-tools.js",
  turnRoute: "adapter/openclaw/register-turn-route.js",
});

function listJsFiles(relativeDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".js")) out.push(next);
    }
  };
  walk(relativeDir);
  return out.sort();
}

function assertComplete(known) {
  const onDisk = [...listJsFiles("engine"), ...listJsFiles("adapter/openclaw")];
  const missing = onDisk.filter((path) => !known.has(path));
  if (missing.length > 0) {
    throw new Error(
      `tests/helpers/runtime-sources.js is out of date: ${missing.join(", ")} `
      + "is not listed, so the source guards would silently skip it. Add it to "
      + "ENGINE_PATHS or ADAPTER_PATHS.",
    );
  }
}

function read(relativePath) {
  return readFileSync(join(ROOT, ...relativePath.split("/")), "utf8");
}

/**
 * Read `index.js` and every engine and adapter module as text.
 *
 * @returns {{ index: string, engine: Record<string, string>, adapter: Record<string, string>, all: string[] }}
 */
export function readRuntimeSources() {
  assertComplete(new Set([...Object.values(ENGINE_PATHS), ...Object.values(ADAPTER_PATHS)]));
  const index = read("index.js");
  const engine = {};
  for (const [name, path] of Object.entries(ENGINE_PATHS)) engine[name] = read(path);
  const adapter = {};
  for (const [name, path] of Object.entries(ADAPTER_PATHS)) adapter[name] = read(path);
  return {
    index,
    engine,
    adapter,
    all: [index, ...Object.values(engine), ...Object.values(adapter)],
  };
}

/**
 * Absolute path of a runtime source, for tests that need the path rather
 * than the contents.
 *
 * @param {string} relativePath Repo-relative path, e.g. `engine/tools/memory-tools.js`.
 * @returns {string} Absolute path.
 */
export function runtimeSourcePath(relativePath) {
  const absolute = join(ROOT, ...relativePath.split("/"));
  if (relative(ROOT, absolute).startsWith(`..${sep}`)) throw new Error(`outside the repo: ${relativePath}`);
  return absolute;
}
