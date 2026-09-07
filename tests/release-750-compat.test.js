import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const EXPECTED_VERSION = "7.12.2";
// Built and runtime-verified against the stable host the package targets, not
// against a beta no user runs. The installed-host loader test exercises this
// exact OpenClaw, so a build-metadata drift would silently change what that
// contract is measured against.
const EXPECTED_BUILD_OPENCLAW_VERSION = "2026.8.2";
const EXPECTED_PRIMARY_OPENCLAW_VERSION = "2026.8.1";
// 7.5.6: the additional target is the 2026.9.1 stable release, verified against
// its own loader and the full suite. The former beta wording described a
// release nobody runs and is gone from the contract.
const EXPECTED_ADDITIONAL_OPENCLAW_VERSION = "2026.9.1";
const EXPECTED_BUILD_OPENCLAW_COMMIT = "0965053fe6b9341776df147a6934b7485c60b5ca";
const EXPECTED_UPSTREAM_VERSION = "7.4.10";
const EXPECTED_UPSTREAM_TAG = "v7.4.10";
const EXPECTED_UPSTREAM_TAG_OBJECT = "f6cf0e75b4f8df509cac7b68bc437a25d650af73";
const EXPECTED_UPSTREAM_COMMIT = "c0a8a4c28ff1cb9c632e185f21f4502d67d1b605";
const EXPECTED_UPSTREAM_TREE = "dbdbc17ce194f4389b0399abdc8fcd80acf7095d";
const EXPECTED_UPSTREAM_CONTENT_PARENT = "0e7eb3c3d0f77c23d9e8adb94ac285fd424b3d80";
const EXPECTED_UPSTREAM_RELEASED_AT = "2026-08-28T23:43:38Z";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("7.5.0 release identity retains its build baseline and declares the stable OpenClaw floor", async () => {
  const packageJson = await readJson("../package.json");
  const packageLock = await readJson("../package-lock.json");
  const manifest = await readJson("../openclaw.plugin.json");

  assert.equal(packageJson.version, EXPECTED_VERSION);
  assert.equal(packageLock.version, EXPECTED_VERSION);
  assert.equal(packageLock.packages[""].version, EXPECTED_VERSION);
  assert.equal(manifest.version, EXPECTED_VERSION);
  assert.equal(packageJson.openclaw.build.openclawVersion, EXPECTED_BUILD_OPENCLAW_VERSION);
  assert.equal(packageJson.openclaw.build.pluginSdkVersion, EXPECTED_BUILD_OPENCLAW_VERSION);
  assert.equal(packageJson.openclaw.compat.minGatewayVersion, EXPECTED_PRIMARY_OPENCLAW_VERSION);
  assert.equal(packageJson.openclaw.compat.pluginApi, `>=${EXPECTED_PRIMARY_OPENCLAW_VERSION}`);
  assert.ok(
    packageJson.files.includes("docs/compatibility-openclaw.md"),
    "the host-neutral compatibility contract must ship in the npm package",
  );
  assert.ok(
    packageJson.files.includes("CHANGELOG.md"),
    "the synchronized 7.5.0 changelog must ship in the npm package",
  );
});

test("7.5.0 documents its host targets, exact upstream base, native integration, immutable models, and data preservation", async () => {
  const compatibility = await readFile(
    new URL("../docs/compatibility-openclaw.md", import.meta.url),
    "utf8",
  );

  assert.match(
    compatibility,
    new RegExp(`primary host target[\\s\\S]*${EXPECTED_PRIMARY_OPENCLAW_VERSION.replaceAll(".", "\\.")}`),
  );
  assert.match(
    compatibility,
    new RegExp(`additionally supported[\\s\\S]*${EXPECTED_ADDITIONAL_OPENCLAW_VERSION.replaceAll(".", "\\.")}`),
  );
  assert.match(compatibility, new RegExp(EXPECTED_BUILD_OPENCLAW_COMMIT));
  assert.match(compatibility, new RegExp(EXPECTED_UPSTREAM_VERSION.replaceAll(".", "\\.")));
  assert.match(compatibility, new RegExp(EXPECTED_UPSTREAM_TAG.replaceAll(".", "\\.")));
  assert.match(compatibility, new RegExp(EXPECTED_UPSTREAM_TAG_OBJECT));
  assert.match(compatibility, new RegExp(EXPECTED_UPSTREAM_COMMIT));
  assert.match(compatibility, new RegExp(EXPECTED_UPSTREAM_TREE));
  assert.match(
    compatibility,
    new RegExp(`content-identical second parent[\\s\\S]*${EXPECTED_UPSTREAM_CONTENT_PARENT}`),
  );
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
  assert.match(compatibility, /full runtime matrix was executed against OpenClaw 2026\.8\.2/i);
  assert.match(compatibility, /upgrade test also runs on 2026\.8\.2/i);
  assert.match(compatibility, /OpenClaw 2026\.9\.1 stable is additionally supported and verified/i);
  assert.match(compatibility, /## OpenClaw 2026\.9\.1/);
  assert.doesNotMatch(compatibility, /2026\.9\.1-beta\.1 is additionally supported/i);
  // 7.5.6: the 2026.9.1 evidence is a real loader run plus the full suite, not
  // an unexecuted beta smoke. What it does not cover is stated instead.
  assert.match(compatibility, /the full test suite, not a\s+second live re-embedding switch/i);
  assert.match(compatibility, /No live re-embedding switch and no Telegram ingress run were repeated on\s+2026\.9\.1/i);
  assert.doesNotMatch(compatibility, /findings there are recorded in KNOWN-ISSUES/i);
  assert.match(compatibility, /isIncognitoSessionKey[\s\S]*fail-closed/i);
  // The floor is a source-verified claim and must say so; it must not borrow
  // the 8.2 runtime evidence.
  assert.match(compatibility, /2026\.8\.1 is source-verified[\s\S]*runtime matrix has not been executed/i);
  assert.match(compatibility, /covered by the\s+source test suite, not by a runtime stage/i);
  assert.doesNotMatch(compatibility, /pending 2026\.8\.1 runtime evidence/i);
});

test("7.5.0 changelog records the bounded and resumable re-embedding contract", async () => {
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");

  assert.match(changelog, /genau einen dauerhaften Batch pro bestaetigtem Operator-RPC/);
  assert.match(changelog, /expired_migration_superseded/);
  assert.match(changelog, /Plan-Digest/);
  assert.doesNotMatch(changelog, /hoechstens vier Batches pro bestaetigtem Operator-Aufruf/);
});

test("7.5.0 tracks its host-neutral OpenClaw compatibility document despite the docs denylist", async () => {
  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^!docs\/compatibility-openclaw\.md$/mu);
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
