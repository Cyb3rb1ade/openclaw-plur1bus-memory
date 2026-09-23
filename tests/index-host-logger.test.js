/**
 * tests/index-host-logger.test.js — PR-02b.
 *
 * index.js must reach the host logger through HostServices, and a host with a
 * partial logger must not make registration throw. The second test is the one
 * that matters: before normalizeLogger, `api.logger?.info?.(...)` no-opped for
 * such a host and `host.logger.info(...)` would have thrown.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import plugin from "../index.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// These four functions are declared at module top level, *before* `register()`
// runs, and each takes its own `api` parameter — the real OpenClaw plugin
// capability surface (they also call `api.registerGatewayMethod`,
// `api.registerCli`, `runtimeIfUsable(api)`, etc., none of which HostServices
// exposes). `host` does not exist in their scope, and three of them
// (`inspectCronNativeCapabilities`, `reconcileUnsafeDirectCronsWithService`,
// `runDeferredFeatureCronBootstrap`) are called directly by other test files
// with a hand-built `api` stub, bypassing `register()`/`host` entirely. Their
// `api.logger` reads are therefore intentionally out of scope for PR-02b.
const HOST_LOGGER_EXEMPT_FUNCTIONS = [
  ["function inspectCronNativeCapabilities(api) {", "function guardUnsafeDirectCronTurn(event, context, { hostReady } = {}) {"],
  ["async function reconcileUnsafeDirectCronsWithService(api, gatewayContext) {", "async function runDeferredFeatureCronBootstrap(api, {"],
  ["async function runDeferredFeatureCronBootstrap(api, {", "function parseFeatureCronBootstrapLastPlanCreateCount(stdout) {"],
  ["function makeReactionsCapabilityChecker(api) {", "export function parseConfirmationCommand(args) {"],
];

function exemptLineNumbers(source, exemptFunctions = HOST_LOGGER_EXEMPT_FUNCTIONS) {
  const lines = source.split("\n");
  const exempt = new Set();
  for (const [startMarker, endMarker] of exemptFunctions) {
    const start = lines.findIndex((line) => line.includes(startMarker));
    assert.notEqual(start, -1, `marker not found: ${startMarker}`);
    const end = lines.findIndex((line, i) => i > start && line.includes(endMarker));
    assert.notEqual(end, -1, `marker not found: ${endMarker}`);
    for (let i = start; i < end; i += 1) exempt.add(i);
  }
  return exempt;
}

// PR-02c: index.js reaches the host runtime through `host.runtime` instead of
// calling `runtimeIfUsable(api)` directly. The same four pre-register
// api-surface helpers above are exempt (no `host` in their scope), plus a
// fifth: `resolveNeoHooksConfig`. It is also declared at module top level
// before `register()` and takes its own `api` parameter, but it was never
// added to HOST_LOGGER_EXEMPT_FUNCTIONS because it already read
// `api?.logger` (optional chaining) rather than `api.logger`, so PR-02b's
// regex never flagged it. It has the identical structural problem here:
// `host` does not exist in its scope.
const HOST_RUNTIME_EXEMPT_FUNCTIONS = [
  ...HOST_LOGGER_EXEMPT_FUNCTIONS,
  ["function resolveNeoHooksConfig(api, commandConfig) {", "function formatJsonCommandResult(value) {"],
];

describe("PR-02b host logger", () => {
  it("index.js no longer reads api.logger outside the pre-register api-surface helpers", () => {
    const source = readFileSync(join(root, "index.js"), "utf8");
    const lines = source.split("\n");
    const exempt = exemptLineNumbers(source);
    const hits = lines
      .map((line, i) => [i, line])
      .filter(([i, line]) => !exempt.has(i) && /(?<![.\w$])api\s*\.\s*logger/.test(line));
    assert.deepEqual(hits.map(([i, line]) => `${i + 1}: ${line.trim()}`), []);
  });

  it("index.js constructs HostServices", () => {
    const source = readFileSync(join(root, "index.js"), "utf8");
    assert.match(source, /createHostServices\s*\(\s*api\s*,/);
  });

  it("registers against a host whose logger has only one method", () => {
    const warned = [];
    const api = {
      pluginConfig: { baseDbPath: makeTempDir("plur1bus-partial-logger-"), autoCapture: false, autoRecall: false },
      config: {},
      logger: { warn: (message) => warned.push(message) },
      resolvePath: (value) => value,
      registerCommand() {},
      registerTool() {},
      registerService() {},
      on() { return { dispose() {} }; },
    };
    assert.doesNotThrow(() => plugin.register(api, {}));
  });

  it("index.js reaches the host runtime through HostServices", () => {
    const source = readFileSync(join(root, "index.js"), "utf8");
    const lines = source.split("\n");
    const exempt = exemptLineNumbers(source, HOST_RUNTIME_EXEMPT_FUNCTIONS);
    const hits = lines
      .map((line, i) => [i, line])
      .filter(([i, line]) => !exempt.has(i) && /runtimeIfUsable\s*\(\s*api\s*\)/.test(line));
    assert.deepEqual(hits.map(([i, line]) => `${i + 1}: ${line.trim()}`), []);
    assert.match(source, /host\.runtime/);
  });
});
