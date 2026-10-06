import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

async function readJson(rel) {
  return JSON.parse(await readFile(new URL(rel, import.meta.url), "utf8"));
}

test("dev OpenClaw pin is the lowest 2026.8.x with patched undici; build baseline and runtime deps stay put", async () => {
  const packageJson = await readJson("../package.json");
  const lock = await readJson("../package-lock.json");
  const installed = require(join(dirname(dirname(require.resolve("openclaw"))), "package.json"));

  assert.equal(packageJson.version, "7.18.4");
  assert.deepEqual(packageJson.engines, { node: ">=24.16.0 <25 || >=26.1.0" });
  assert.deepEqual(packageJson.dependencies, {
    "@lancedb/lancedb": "^0.26.2",
    "apache-arrow": "18.1.0",
    openai: "^6.27.0",
  });
  assert.equal(packageJson.openclaw.build.openclawVersion, "2026.8.2");
  assert.equal(packageJson.openclaw.build.pluginSdkVersion, "2026.8.2");
  assert.equal(packageJson.devDependencies.openclaw, "2026.8.33");
  assert.equal(lock.packages[""].devDependencies.openclaw, "2026.8.33");
  assert.equal(lock.packages["node_modules/openclaw"].version, "2026.8.33");
  assert.equal(installed.version, "2026.8.33");
  assert.equal(lock.packages["node_modules/openclaw"].dev, true);
  assert.equal(packageJson.overrides["brace-expansion"], "5.0.12");
  assert.equal(packageJson.overrides["fast-uri"], "3.1.8");
  assert.equal(packageJson.overrides.hono, "4.13.7");
  assert.equal(packageJson.overrides["ip-address"], "10.7.1");
  assert.equal(packageJson.overrides["@huggingface/transformers"].sharp, "0.35.5");
  assert.equal(lock.packages["node_modules/brace-expansion"].version, "5.0.12");
  assert.equal(lock.packages["node_modules/fast-uri"].version, "3.1.8");
  assert.equal(lock.packages["node_modules/hono"].version, "4.13.7");
  assert.equal(lock.packages["node_modules/ip-address"].version, "10.7.1");
  assert.equal(lock.packages["node_modules/undici"].version, "8.10.2");
});
