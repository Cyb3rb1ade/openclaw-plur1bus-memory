/**
 * tests/host-paths.test.js — G1 (spec 3.4 (2)).
 *
 * lib/ path defaults on the engine graph come from host-bound overrides; with
 * the adapter's env-backed overrides bound, every rewired site returns what
 * its old process.env read returned.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import { bindHostPaths, hostConfigPath, hostConfigPathOverride, hostHomeOverride, hostStateDir, hostStateDirOverride, resetHostPaths } from "../lib/host-paths.js";
import { createHostServices, createStubHost, envHostPaths } from "../lib/host-services.js";

afterEach(() => resetHostPaths());

describe("lib/host-paths", () => {
  it("unbound defaults never read the environment", () => {
    const previous = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = "/should/not/be/read";
    try {
      bindHostPaths({});
      assert.equal(hostStateDir(), join(homedir(), ".openclaw"));
      assert.equal(hostConfigPath(), join(homedir(), ".openclaw", "openclaw.json"));
      assert.equal(hostHomeOverride(), undefined);
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_HOME; else process.env.OPENCLAW_HOME = previous;
    }
  });

  it("the adapter's env-backed overrides reproduce the old reads, per call", () => {
    const env = {};
    bindHostPaths(envHostPaths(env));
    assert.equal(hostStateDir(), join(homedir(), ".openclaw"));
    env.OPENCLAW_HOME = "/srv/oc";
    assert.equal(hostStateDir(), "/srv/oc");
    assert.equal(hostConfigPath(), "/srv/oc/openclaw.json");
    env.OPENCLAW_CONFIG_PATH = "/etc/oc.json";
    assert.equal(hostConfigPath(), "/etc/oc.json");
    assert.equal(hostConfigPathOverride(), "/etc/oc.json");
    env.OPENCLAW_STATE_DIR = "/var/oc";
    assert.equal(hostStateDirOverride(), "/var/oc");
    assert.equal(hostHomeOverride(), "/srv/oc");
  });
});

describe("HostServices 1.3.0 members", () => {
  it("createHostServices supplies configPath, routing and pathOverrides", async () => {
    const host = createHostServices({ logger: {} }, { stateDir: "/srv/oc", routing: async () => ({ marker: 1 }) });
    assert.equal(typeof host.configPath, "function");
    assert.match(host.configPath(), /openclaw\.json$/);
    assert.deepEqual(await host.routing(), { marker: 1 });
    assert.equal(typeof host.pathOverrides.openclawHome, "function");
  });

  it("createStubHost has a configPath under its stateDir and no routing", () => {
    const host = createStubHost({ stateDir: "/tmp/stub-state" });
    assert.equal(host.configPath(), "/tmp/stub-state/openclaw.json");
    assert.equal(host.routing, undefined);
    assert.equal(host.pathOverrides, undefined);
  });
});
