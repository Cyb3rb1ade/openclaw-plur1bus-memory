import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDeployDir } from "../scripts/lib/find-deploy-dir.mjs";

let dir;
let savedEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "find-deploy-dir-test-"));
  savedEnv = { PLUR1BUS_DEPLOY: process.env.PLUR1BUS_DEPLOY, OPENCLAW_HOME: process.env.OPENCLAW_HOME };
  delete process.env.PLUR1BUS_DEPLOY;
  delete process.env.OPENCLAW_HOME;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedEnv.PLUR1BUS_DEPLOY === undefined) delete process.env.PLUR1BUS_DEPLOY;
  else process.env.PLUR1BUS_DEPLOY = savedEnv.PLUR1BUS_DEPLOY;
  if (savedEnv.OPENCLAW_HOME === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = savedEnv.OPENCLAW_HOME;
});

describe("findDeployDir", () => {
  it("prefers PLUR1BUS_DEPLOY when set, regardless of anything else", () => {
    process.env.PLUR1BUS_DEPLOY = "/some/explicit/path";
    process.env.OPENCLAW_HOME = join(dir, "openclaw-home");
    assert.strictEqual(findDeployDir(dir), "/some/explicit/path");
  });

  it("honors OPENCLAW_HOME instead of falling back to the literal production default", () => {
    const openclawHome = join(dir, "openclaw-home");
    process.env.OPENCLAW_HOME = openclawHome;
    const result = findDeployDir(dir);
    assert.strictEqual(result, join(openclawHome, "extensions", "memory-lancedb-namespaced"));
    assert.notStrictEqual(result, "/root/.openclaw/extensions/memory-lancedb-namespaced");
  });

  it("picks the extensions/<pluginId> candidate over an openclaw-plur1bus-memory checkout when both exist, warning on stderr", () => {
    const openclawHome = join(dir, "openclaw-home");
    const repoCheckout = join(openclawHome, "openclaw-plur1bus-memory");
    const extDir = join(openclawHome, "extensions", "memory-lancedb-namespaced");
    mkdirSync(repoCheckout, { recursive: true });
    mkdirSync(extDir, { recursive: true });
    process.env.OPENCLAW_HOME = openclawHome;
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      assert.strictEqual(findDeployDir(dir), extDir);
    } finally {
      console.error = originalError;
    }
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], new RegExp(extDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(errors[0], new RegExp(repoCheckout.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("picks the extensions candidate alone when only it exists (checkout absent)", () => {
    const openclawHome = join(dir, "openclaw-home");
    const extDir = join(openclawHome, "extensions", "memory-lancedb-namespaced");
    mkdirSync(extDir, { recursive: true });
    process.env.OPENCLAW_HOME = openclawHome;
    assert.strictEqual(findDeployDir(dir), extDir);
  });

  it("falls back to extensions/<pluginId> read from openclaw.plugin.json when no checkout exists", () => {
    const openclawHome = join(dir, "openclaw-home");
    process.env.OPENCLAW_HOME = openclawHome;
    const repoDir = join(dir, "repo");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "openclaw.plugin.json"), JSON.stringify({ id: "my-custom-plugin-id" }));
    const extDir = join(openclawHome, "extensions", "my-custom-plugin-id");
    mkdirSync(extDir, { recursive: true });
    assert.strictEqual(findDeployDir(repoDir), extDir);
  });

  it("returns the first candidate (extensions/<pluginId> path) even when neither exists yet", () => {
    const openclawHome = join(dir, "openclaw-home");
    process.env.OPENCLAW_HOME = openclawHome;
    const result = findDeployDir(dir);
    assert.strictEqual(result, join(openclawHome, "extensions", "memory-lancedb-namespaced"));
  });
});
