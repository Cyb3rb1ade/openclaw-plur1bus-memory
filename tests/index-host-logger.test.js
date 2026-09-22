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

function exemptLineNumbers(source) {
  const lines = source.split("\n");
  const exempt = new Set();
  for (const [startMarker, endMarker] of HOST_LOGGER_EXEMPT_FUNCTIONS) {
    const start = lines.findIndex((line) => line.includes(startMarker));
    assert.notEqual(start, -1, `marker not found: ${startMarker}`);
    const end = lines.findIndex((line, i) => i > start && line.includes(endMarker));
    assert.notEqual(end, -1, `marker not found: ${endMarker}`);
    for (let i = start; i < end; i += 1) exempt.add(i);
  }
  return exempt;
}

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
    assert.match(source, /createHostServices\s*\(\s*api\s*\)/);
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
});
