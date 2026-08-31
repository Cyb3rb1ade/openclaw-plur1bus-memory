import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const EXPECTED_VERSION = "7.5.0";
const EXPECTED_OPENCLAW_VERSION = "2026.9.1-beta.1";
const EXPECTED_OPENCLAW_COMMIT = "1d96e5aee2d49cde999ed055eda113e2523a7b5c";
const EXPECTED_UPSTREAM_VERSION = "7.4.10";
const EXPECTED_UPSTREAM_TAG = "v7.4.10";
const EXPECTED_UPSTREAM_TAG_OBJECT = "f6cf0e75b4f8df509cac7b68bc437a25d650af73";
const EXPECTED_UPSTREAM_COMMIT = "c0a8a4c28ff1cb9c632e185f21f4502d67d1b605";
const EXPECTED_UPSTREAM_TREE = "dbdbc17ce194f4389b0399abdc8fcd80acf7095d";
const EXPECTED_UPSTREAM_RELEASED_AT = "2026-08-28T23:43:38Z";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("7.5.0 release identity is synchronized and targets exact OpenClaw 2026.9.1 beta", async () => {
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
    packageJson.files.includes("docs/compatibility-openclaw-2026.9.1-beta.1.md"),
    "the exact-host compatibility contract must ship in the npm package",
  );
  assert.ok(
    packageJson.files.includes("CHANGELOG.md"),
    "the synchronized 7.5.0 changelog must ship in the npm package",
  );
});

test("7.5.0 documents its exact upstream base, native integration, immutable models, and data preservation", async () => {
  const compatibility = await readFile(
    new URL("../docs/compatibility-openclaw-2026.9.1-beta.1.md", import.meta.url),
    "utf8",
  );

  assert.match(compatibility, new RegExp(EXPECTED_OPENCLAW_VERSION.replaceAll(".", "\\.")));
  assert.match(compatibility, new RegExp(EXPECTED_OPENCLAW_COMMIT));
  assert.match(compatibility, new RegExp(EXPECTED_UPSTREAM_VERSION.replaceAll(".", "\\.")));
  assert.match(compatibility, new RegExp(EXPECTED_UPSTREAM_TAG.replaceAll(".", "\\.")));
  assert.match(compatibility, new RegExp(EXPECTED_UPSTREAM_TAG_OBJECT));
  assert.match(compatibility, new RegExp(EXPECTED_UPSTREAM_COMMIT));
  assert.match(compatibility, new RegExp(EXPECTED_UPSTREAM_TREE));
  assert.match(compatibility, new RegExp(EXPECTED_UPSTREAM_RELEASED_AT));
  assert.doesNotMatch(compatibility, /had not yet published a `v7\.4\.10` Git tag or GitHub Release/);
  assert.match(compatibility, /registerGatewayMethod/);
  assert.match(compatibility, /registerCli/);
  assert.match(compatibility, /gateway-runtime/);
  assert.match(compatibility, /614241f622f53c4eeff9890bdc4f31cfecc418b3/);
  assert.match(compatibility, /ab036b023d30b4d1138c4c3bfa9f0c445ab455d6/);
  assert.match(compatibility, /9cfeff2df7d40d1b78e75e5e9cebec92a99813c9/);
  assert.match(compatibility, /c44ebc43de724ae8816668bb44d2e728e17faa18/);
  assert.match(compatibility, /non-destructive/i);
  assert.match(compatibility, /no OpenClaw runtime files are patched/i);
  assert.match(compatibility, /one durable embedding batch per\s+operator RPC/i);
  assert.match(compatibility, /confirmed migration remains resumable\s+after the original token TTL expires/i);
  assert.match(compatibility, /expired_migration_superseded/);
});

test("7.5.0 changelog records the bounded and resumable re-embedding contract", async () => {
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");

  assert.match(changelog, /genau einen dauerhaften Batch pro bestaetigtem Operator-RPC/);
  assert.match(changelog, /expired_migration_superseded/);
  assert.match(changelog, /Plan-Digest/);
  assert.doesNotMatch(changelog, /hoechstens vier Batches pro bestaetigtem Operator-Aufruf/);
});

test("7.5.0 tracks the exact OpenClaw compatibility document despite the docs denylist", async () => {
  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^!docs\/compatibility-openclaw-2026\.9\.1-beta\.1\.md$/mu);
});

test("7.5.0 package and installer contain no OpenClaw host patch", async () => {
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
