import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const EXPECTED_VERSION = "7.4.9";
const EXPECTED_OPENCLAW_VERSION = "2026.8.1-beta.3";
const EXPECTED_OPENCLAW_COMMIT = "5831b80721f802072b0ec1893b30a16cf42d538c";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("7.4.9 release identity is synchronized and targets exact OpenClaw beta-3", async () => {
  const packageJson = await readJson("../package.json");
  const packageLock = await readJson("../package-lock.json");
  const manifest = await readJson("../openclaw.plugin.json");

  assert.equal(packageJson.version, EXPECTED_VERSION);
  assert.equal(packageLock.version, EXPECTED_VERSION);
  assert.equal(packageLock.packages[""].version, EXPECTED_VERSION);
  assert.equal(manifest.version, EXPECTED_VERSION);
  assert.equal(packageJson.openclaw.build.openclawVersion, EXPECTED_OPENCLAW_VERSION);
  assert.equal(packageJson.openclaw.build.pluginSdkVersion, EXPECTED_OPENCLAW_VERSION);
  assert.equal(packageJson.openclaw.compat.minGatewayVersion, EXPECTED_OPENCLAW_VERSION);
  assert.equal(packageJson.openclaw.compat.pluginApi, `>=${EXPECTED_OPENCLAW_VERSION}`);
  assert.ok(
    packageJson.files.includes("docs/compatibility-openclaw-2026.8.1-beta.3.md"),
    "the exact-host compatibility contract must ship in the npm package",
  );
});

test("7.4.9 documents native integration, immutable models, and data preservation", async () => {
  const compatibility = await readFile(
    new URL("../docs/compatibility-openclaw-2026.8.1-beta.3.md", import.meta.url),
    "utf8",
  );

  assert.match(compatibility, new RegExp(EXPECTED_OPENCLAW_VERSION.replaceAll(".", "\\.")));
  assert.match(compatibility, new RegExp(EXPECTED_OPENCLAW_COMMIT));
  assert.match(compatibility, /registerGatewayMethod/);
  assert.match(compatibility, /registerCli/);
  assert.match(compatibility, /gateway-runtime/);
  assert.match(compatibility, /614241f622f53c4eeff9890bdc4f31cfecc418b3/);
  assert.match(compatibility, /9cfeff2df7d40d1b78e75e5e9cebec92a99813c9/);
  assert.match(compatibility, /c44ebc43de724ae8816668bb44d2e728e17faa18/);
  assert.match(compatibility, /non-destructive/i);
  assert.match(compatibility, /no OpenClaw runtime files are patched/i);
});

test("7.4.9 package and installer contain no OpenClaw host patch", async () => {
  const packageJson = await readJson("../package.json");
  const installer = await readFile(
    new URL("../scripts/install-memory-system.sh", import.meta.url),
    "utf8",
  );

  assert.equal(
    packageJson.files.some((entry) => entry.includes("patches/")),
    false,
  );
  assert.doesNotMatch(installer, /apply-(?:cron-plugin-direct-dispatch|memory-patches)/);
  await assert.rejects(
    access(new URL("../patches/apply-cron-plugin-direct-dispatch.mjs", import.meta.url)),
  );
});
