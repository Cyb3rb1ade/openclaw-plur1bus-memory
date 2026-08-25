import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");

describe("cron direct-dispatch patch wiring", () => {
  it("runs the host patch from the canonical memory patch entrypoint", () => {
    const source = readFileSync(
      path.join(repoRoot, "patches/apply-memory-patches.sh"),
      "utf8",
    );

    assert.match(source, /apply-cron-plugin-direct-dispatch\.mjs/);
    assert.match(source, /patch_cron_plugin_direct_dispatch \|\| rc=1/);
  });

  it("copies the host patch helper for remote installation", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts/install-memory-system.sh"),
      "utf8",
    );

    assert.match(
      source,
      /scp "\$PATCHES_CRON_DIRECT_SCRIPT" "\$\{SSH_HOST\}:\/tmp\/apply-cron-plugin-direct-dispatch\.mjs"/,
    );
    assert.match(
      source,
      /rm -f \/tmp\/apply-memory-patches\.sh \/tmp\/apply-cron-plugin-direct-dispatch\.mjs/,
    );
  });

  it("ships the patch in release packages and reapplies it during gateway registration", () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const indexSource = readFileSync(path.join(repoRoot, "index.js"), "utf8");

    assert.ok(packageJson.files.includes("patches/apply-cron-plugin-direct-dispatch.mjs"));
    assert.match(indexSource, /ensureCronDirectDispatchAtRegistration\(api\)/);
    assert.match(indexSource, /applyCronPluginDirectDispatchPatch/);
    assert.match(indexSource, /resolveOpenClawDistDir\(\)/);
    assert.match(indexSource, /force: !cronDirectDispatchReady/);
    assert.match(indexSource, /cronDirectDispatchReady \? 90_000 : 0/);
    assert.match(indexSource, /await reconcileUnsafeDirectCronsWithService\(api, gatewayContext\)/);
    assert.match(indexSource, /cron\.list\(\{ includeDisabled: true \}\)/);
    assert.match(indexSource, /Promise\.resolve\(cron\.update\(job\.id/);
    assert.match(indexSource, /api\.on\(\s*"before_agent_reply"/);
    assert.match(indexSource, /guardUnsafeDirectCronTurn/);
  });

  it("prefers native command dispatch and gates fallback setup on readiness", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts/setup-feature-crons.mjs"),
      "utf8",
    );

    assert.match(source, /probeNativeCronCommandDispatch\(openclawImpl\)/);
    assert.match(source, /ensureCronDirectDispatchImpl\(\{ apply: !opts\.dryRun, openclawImpl \}\)/);
    assert.match(source, /dispatch\?\.status === "native-command"/);
    assert.match(source, /planNativeFeaturePayloadMigration/);
    assert.match(source, /"--command-argv"/);
    assert.match(source, /host-direct-dispatch-unavailable/);
    assert.match(source, /planUnsafeDirectCronDisables\(existingJobs\)/);
    assert.match(source, /\["cron", "edit", job\.id, "--disable", "--name", job\.safetyName\]/);
  });

  it("documents mandatory conversation-hook access for the admission fallback", () => {
    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const configuration = readFileSync(path.join(repoRoot, "docs/configuration.md"), "utf8");

    assert.match(readme, /"hooks": \{\s*"allowConversationAccess": true\s*\}/);
    assert.match(configuration, /"hooks": \{\s*"allowConversationAccess": true\s*\}/);
    assert.match(readme, /mandatory[\s\S]{0,200}before_agent_reply/i);
  });
});
