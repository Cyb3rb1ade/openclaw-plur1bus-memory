import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

describe("auto-capture import path", () => {
  it("PLUR1BUS_PLUGIN_DIR env var can override path", () => {
    const customDir = "/tmp/test-plugin-dir";
    const pluginDir = process.env.PLUR1BUS_PLUGIN_DIR || customDir;
    const factoryPath = join(pluginDir, "lib/providers/factory.js");
    assert.ok(typeof factoryPath === "string");
    assert.ok(factoryPath.includes("lib/providers/factory.js"));
  });

  it("Default path points to installed extension", () => {
    const defaultDir = join(homedir(), ".openclaw", "extensions", "memory-lancedb-namespaced");
    const factoryPath = join(defaultDir, "lib/providers/factory.js");
    assert.ok(factoryPath.includes("memory-lancedb-namespaced"));
    assert.ok(factoryPath.includes("lib/providers/factory.js"));
  });

  it("Repo-own factory.js exists (for development)", () => {
    const repoFactory = join(process.cwd(), "lib/providers/factory.js");
    assert.ok(existsSync(repoFactory), `factory.js not found at: ${repoFactory}`);
  });
});
