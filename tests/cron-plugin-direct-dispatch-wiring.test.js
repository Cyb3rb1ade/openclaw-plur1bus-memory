import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { readRuntimeSources } from "./helpers/runtime-sources.js";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");

describe("native cron direct-dispatch wiring", () => {
  it("ships no host patch script at all: the retired entrypoint is gone from the tree", () => {
    // 7.5.0 retired host patching; the script stayed in the tree, shipped in
    // no package, until the atlas re-read noted it. Removed for good.
    assert.equal(existsSync(path.join(repoRoot, "patches/apply-memory-patches.sh")), false);
    assert.equal(existsSync(path.join(repoRoot, "patches")), false);
  });

  it("does not copy or execute any OpenClaw host patch during installation", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts/install-memory-system.sh"),
      "utf8",
    );

    assert.doesNotMatch(source, /PATCHES_CRON_DIRECT_SCRIPT/);
    assert.doesNotMatch(source, /apply-cron-plugin-direct-dispatch\.mjs/);
    assert.doesNotMatch(source, /apply-memory-patches\.sh/);
    assert.doesNotMatch(source, /apply-plur1bus-user-hotfix\.sh/);
    assert.doesNotMatch(source, /PLUR1BUS_SKIP_HOST_PATCH/);
    assert.match(source, /Keine OpenClaw-Host-Patches erforderlich oder zulässig/);
  });

  it("ships and registers only capability-gated native integration", () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const { index: indexSource, adapter } = readRuntimeSources();
    const runtimeSource = readFileSync(
      path.join(repoRoot, "lib/setup/feature-cron-plugin-runtime.js"),
      "utf8",
    );
    // PR-03i moved the two feature-cron registrations into the OpenClaw
    // adapter; the pure logic they call stays in index.js. G1 (M1b-1 Task 11)
    // then moved the five pre-register() api-taking functions themselves
    // (including reconcileUnsafeDirectCronsWithService, whose body contains
    // the cron.list/cron.update calls) into adapter/openclaw/host-probes.js.
    const cronSource = adapter.cron;
    const hostProbesSource = adapter.hostProbes;

    assert.ok(!packageJson.files.includes("patches/apply-cron-plugin-direct-dispatch.mjs"));
    assert.doesNotMatch(indexSource, /applyCronPluginDirectDispatchPatch/);
    assert.doesNotMatch(indexSource, /resolveOpenClawDistDir/);
    assert.doesNotMatch(runtimeSource, /apply-cron-plugin-direct-dispatch/);
    assert.match(indexSource, /inspectCronNativeCapabilities\(api\)/);
    assert.match(cronSource, /force: !cronDirectDispatchReady/);
    assert.match(cronSource, /cronDirectDispatchReady \? 90_000 : 0/);
    assert.match(cronSource, /await reconcileUnsafeDirectCronsWithService\(api, gatewayContext\)/);
    assert.match(hostProbesSource, /cron\.list\(\{ includeDisabled: true \}\)/);
    assert.match(hostProbesSource, /Promise\.resolve\(cron\.update\(job\.id/);
    assert.match(cronSource, /api\.on\(\s*"before_agent_reply"/);
    assert.match(cronSource, /guardUnsafeDirectCronTurn/);
    assert.match(indexSource, /guardUnsafeDirectCronTurn/);
  });

  it("requires native command dispatch and has no mutation fallback", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts/setup-feature-crons.mjs"),
      "utf8",
    );

    assert.match(source, /probeNativeCronCommandDispatchImpl\(openclawImpl\)/);
    assert.doesNotMatch(source, /applyCronPluginDirectDispatchPatch/);
    assert.doesNotMatch(source, /isCronPluginDirectDispatchReady/);
    assert.doesNotMatch(source, /legacy-patch/);
    assert.match(source, /planNativeFeaturePayloadMigration/);
    assert.match(source, /"--command-argv"/);
    assert.match(source, /native-command-capability-unavailable/);
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
