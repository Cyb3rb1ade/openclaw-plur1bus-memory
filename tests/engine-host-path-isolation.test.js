import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createStubHost } from "../lib/host-services.js";
import { hostConfigPath, hostStateDir, resetHostPaths } from "../lib/host-paths.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const config = {
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: false, autoRecall: false,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
};

test("an engine without path overrides uses its host's state and config paths", () => {
  // A broken default must only touch a throw-away home, including on Windows.
  const home = makeTempDir("engine-neutral-home-");
  const stateDir = makeTempDir("engine-neutral-state-");
  const source = `
    import assert from "node:assert/strict";
    import { join } from "node:path";
    import { createEngine } from "./engine/create-engine.js";
    import { internalsOf } from "./engine/internals.js";
    import { createStubHost } from "./lib/host-services.js";
    import { hostStateDir, hostConfigPath } from "./lib/host-paths.js";
    const stateDir = process.argv[1];
    const configPath = join(stateDir, "host-config.json");
    const host = createStubHost({ stateDir, configPath: () => configPath });
    const engine = createEngine(host, ${JSON.stringify(config)});
    try {
      assert.equal(internalsOf(engine).baseDbPath, join(stateDir, "memory", "lancedb-namespaced"));
      assert.equal(hostStateDir(), stateDir);
      assert.equal(hostConfigPath(), configPath);
    } finally { await engine.close(); }
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", source, stateDir], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8", timeout: 15_000,
  });
});

test("explicit database paths and lazy adapter path overrides retain precedence", async (t) => {
  const stateDir = makeTempDir("engine-adapter-paths-");
  const baseDbPath = join(stateDir, "explicit-store");
  let home = join(stateDir, "generation-a");
  let path = join(stateDir, "config-a.json");
  const host = createStubHost({
    stateDir,
    pathOverrides: { openclawHome: () => home, configPathOverride: () => path },
  });
  const engine = createEngine(host, { ...config, baseDbPath });
  t.after(async () => { await engine.close(); resetHostPaths(); });
  assert.equal(internalsOf(engine).baseDbPath, baseDbPath);
  assert.equal(hostStateDir(), home);
  assert.equal(hostConfigPath(), path);
  home = join(stateDir, "generation-b");
  path = join(stateDir, "config-b.json");
  assert.equal(hostStateDir(), home);
  assert.equal(hostConfigPath(), path);
});

test("an adapter can supply its historical database default without an engine host name", async (t) => {
  const stateDir = makeTempDir("engine-legacy-default-state-");
  const defaultMemoryPath = join(makeTempDir("engine-legacy-default-store-"), "db");
  const engine = createEngine(createStubHost({ stateDir, capabilities: { defaultMemoryPath } }), config);
  t.after(async () => { await engine.close(); resetHostPaths(); });
  assert.equal(internalsOf(engine).baseDbPath, defaultMemoryPath);
});

test("an adapter's home-only override retains its lazy config-file default", async (t) => {
  const stateDir = makeTempDir("engine-home-only-");
  let home = join(stateDir, "a");
  const engine = createEngine(createStubHost({ stateDir, pathOverrides: { openclawHome: () => home } }), {
    ...config, baseDbPath: join(stateDir, "db"),
  });
  t.after(async () => { await engine.close(); resetHostPaths(); });
  assert.equal(hostConfigPath(), join(home, "openclaw.json"));
  home = join(stateDir, "b");
  assert.equal(hostConfigPath(), join(home, "openclaw.json"));
});

test("real plugin registration keeps the historical DB default when host home differs", () => {
  const home = makeTempDir("engine-plugin-home-");
  const stateDir = join(home, "alternate-host-state");
  // Stop at the path resolver, before any store is initialized. This checks
  // the actual adapter-to-engine construction path without registering a host.
  const source = `
    import assert from "node:assert/strict";
    import { homedir } from "node:os";
    import { join } from "node:path";
    import { registerPlur1bus } from "./adapter/openclaw/plugin.js";
    const stop = new Error("path captured");
    let received;
    assert.throws(() => registerPlur1bus({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      config: {}, pluginConfig: ${JSON.stringify(config)}, registrationMode: "discover",
      resolvePath(path) { received = path; throw stop; },
    }), error => error === stop);
    assert.equal(received, join(homedir(), ".openclaw", "memory", "lancedb-namespaced"));
    assert.notEqual(received, join(process.env.OPENCLAW_HOME, "memory", "lancedb-namespaced"));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, HOME: home, USERPROFILE: home, OPENCLAW_HOME: stateDir },
    encoding: "utf8", timeout: 15_000,
  });
});
