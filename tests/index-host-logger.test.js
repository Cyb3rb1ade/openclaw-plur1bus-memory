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

// Five functions took their own `api` parameter — the real OpenClaw plugin
// capability surface (they also called `api.registerGatewayMethod`,
// `api.registerCli`, `runtimeIfUsable(api)`, etc., none of which HostServices
// exposes) — and were declared at module top level, *before* `register()`
// ran, so `host` did not exist in their scope. G1 (M1b-1 Task 11) moved all
// five out of index.js into adapter/openclaw/host-probes.js (outside this
// test's scope by design), so index.js no longer contains any `api.logger`
// or `runtimeIfUsable(api)` reads at all, and no exemption list is needed
// any more.
const HOST_LOGGER_EXEMPT_FUNCTIONS = [];

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
// calling `runtimeIfUsable(api)` directly. `resolveNeoHooksConfig` had the
// same structural problem (its own `api` parameter, no `host` in scope) and
// moved to adapter/openclaw/host-probes.js alongside the other four in G1
// (M1b-1 Task 11), so no exemption is needed here either.
const HOST_RUNTIME_EXEMPT_FUNCTIONS = [...HOST_LOGGER_EXEMPT_FUNCTIONS];

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
