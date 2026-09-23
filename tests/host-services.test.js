/**
 * tests/host-services.test.js — PR-02.
 *
 * The important cases are the partial-logger ones: index.js mixes
 * `api.logger.warn(...)` with `api.logger?.info?.(...)`, and many host stubs
 * pass a partial logger. Once the optional chains become `host.logger.info(...)`
 * a partial logger must still no-op rather than throw.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createHostServices, createStubHost, normalizeLogger, resolveStateDir } from "../lib/host-services.js";

describe("normalizeLogger", () => {
  it("fills every missing method with a no-op", () => {
    const logger = normalizeLogger({});
    for (const method of ["info", "warn", "error", "debug"]) {
      assert.equal(typeof logger[method], "function");
      assert.equal(logger[method]("x"), undefined);
    }
  });

  it("keeps the methods the host does supply, bound to it", () => {
    const seen = [];
    const source = { prefix: "p", info(message) { seen.push(`${this.prefix}:${message}`); } };
    const logger = normalizeLogger(source);
    logger.info("hello");
    logger.warn("ignored");
    assert.deepEqual(seen, ["p:hello"]);
  });

  it("tolerates null and undefined", () => {
    assert.equal(normalizeLogger(null).error("x"), undefined);
    assert.equal(normalizeLogger(undefined).debug("x"), undefined);
  });
});

describe("createHostServices", () => {
  it("never throws on a partial or absent logger", () => {
    assert.equal(createHostServices({ logger: {} }).logger.info("x"), undefined);
    assert.equal(createHostServices({}).logger.warn("x"), undefined);
    assert.equal(createHostServices().logger.error("x"), undefined);
  });

  it("re-probes the runtime on every read instead of caching it", () => {
    let runtime = null;
    const api = { get runtime() { return runtime; } };
    const host = createHostServices(api);
    assert.equal(host.runtime, null);
    runtime = { config: { current: () => ({ a: 1 }) } };
    assert.equal(host.runtime, runtime);
  });

  it("returns null for a runtime proxy that throws on property access", () => {
    const api = {
      runtime: new Proxy({}, { get() { throw new Error("restricted registration"); } }),
    };
    const host = createHostServices(api);
    assert.equal(host.runtime, null);
  });

  it("exposes llm only when the runtime has a complete() function", () => {
    assert.equal(createHostServices({ runtime: {} }).llm, undefined);
    assert.equal(createHostServices({ runtime: { llm: {} } }).llm, undefined);
    const llm = { complete: async () => ({ text: "" }) };
    assert.equal(createHostServices({ runtime: { llm } }).llm, llm);
  });

  it("reads the host config through config()", () => {
    assert.deepEqual(createHostServices({ config: { agents: {} } }).config(), { agents: {} });
    assert.deepEqual(createHostServices({}).config(), {});
  });

  it("resolves a workspace dir through the runtime and undefined without one", async () => {
    assert.equal(await createHostServices({}).workspaceDir("a"), undefined);
    const api = {
      config: { marker: true },
      runtime: { agent: { resolveAgentWorkspaceDir: (config, agentId) => `/ws/${agentId}/${config.marker}` } },
    };
    assert.equal(await createHostServices(api).workspaceDir("agent-1"), "/ws/agent-1/true");
  });

  it("awaits an async resolveAgentWorkspaceDir, as every real host provides", async () => {
    const api = {
      config: { marker: true },
      runtime: {
        agent: {
          async resolveAgentWorkspaceDir(config, agentId) {
            return `/ws/${agentId}/${config.marker}`;
          },
        },
      },
    };
    const result = createHostServices(api).workspaceDir("agent-2");
    assert.ok(result instanceof Promise);
    assert.equal(await result, "/ws/agent-2/true");
  });

  it("carries the four platform capabilities", () => {
    const host = createHostServices({});
    for (const name of ["securePath", "ipcAddress", "isUnsafeLink", "canonicalIdentityPath"]) {
      assert.equal(typeof host.platform[name], "function", name);
    }
  });

  it("uses OPENCLAW_HOME for the state dir and never process.env.HOME", () => {
    assert.equal(resolveStateDir({ OPENCLAW_HOME: "/srv/state" }), "/srv/state");
    const withoutHome = resolveStateDir({ HOME: "/should/not/be/used" });
    assert.doesNotMatch(withoutHome, /should\/not\/be\/used/);
    assert.match(withoutHome, /\.openclaw$/);
  });
});

describe("createStubHost", () => {
  it("is inert and complete by default", async () => {
    const host = createStubHost();
    assert.equal(host.logger.info("x"), undefined);
    assert.equal(host.runtime, null);
    assert.equal(host.llm, undefined);
    assert.deepEqual(host.config(), {});
    assert.equal(await host.workspaceDir("a"), undefined);
    assert.equal(typeof host.clock(), "number");
    assert.equal(typeof host.platform.securePath, "function");
  });

  it("applies overrides, including a partial logger", () => {
    const lines = [];
    const host = createStubHost({
      logger: { warn: (m) => lines.push(m) },
      stateDir: "/tmp/stub-state",
      config: () => ({ k: 1 }),
      runtime: { config: { current: () => ({}) } },
    });
    host.logger.warn("w");
    host.logger.debug("ignored");
    assert.deepEqual(lines, ["w"]);
    assert.equal(host.stateDir, "/tmp/stub-state");
    assert.deepEqual(host.config(), { k: 1 });
    assert.equal(typeof host.runtime.config.current, "function");
  });
});
