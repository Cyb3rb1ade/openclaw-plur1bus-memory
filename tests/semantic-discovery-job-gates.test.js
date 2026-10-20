/**
 * tests/semantic-discovery-job-gates.test.js — engine-jobs audit F3 and F4.
 *
 * F3: the discover-semantic-links job only had its gate at cron installation.
 *     Switching obsidianBridge / semanticDiscovery off later left the existing
 *     cron writing memory notes and links.
 * F4: the rem-dream fire-and-forget discovery ran without a mutationPolicy and
 *     was therefore blocked every time (dead branch); the cron path builds one.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createInternalJobBodies } from "../engine/jobs/internal-job-bodies.js";
import { selectSemanticDiscoveryWorkspaces } from "../engine/runtime/semantic-discovery.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const POLICY = Object.freeze({ marker: "policy" });

function harness({ bridge, extra = {} } = {}) {
  const wsDir = makeTempDir("sem-gates-ws-");
  const calls = { discovery: [], policy: [] };
  const logs = [];
  const host = createStubHost();
  host.logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} };
  const bridgeCfg = {
    workspaces: [{ workspace_id: "w1", agent_id: "a", path: wsDir }],
    ...bridge,
    graphLinks: { ...(bridge?.graphLinks || {}), semanticDiscovery: { ...(bridge?.graphLinks?.semanticDiscovery || {}) } },
  };
  const run = createInternalJobBodies({
    host,
    cfg: {},
    obsidianBridgeCfg: bridgeCfg,
    selectSemanticDiscoveryWorkspaces,
    obsidianServiceMutationPolicy: (workspace, opts) => { calls.policy.push({ workspace, opts }); return POLICY; },
    runSemanticDiscoveryBatches: async (args) => { calls.discovery.push(args); return { processed: 0, skipped: 0, unchanged: 0, errors: 0 }; },
    pool: { withDb: async (_agent, fn) => fn({ init: async () => {} }) },
    formatJsonCommandResult: (value) => JSON.stringify(value),
    ...extra,
  });
  const jobCtx = (input) => ({
    input,
    skip: (reason, out) => ({ skippedWith: reason, out }),
    incomplete: (reason, out) => ({ incompleteWith: reason, out }),
    noteDiary() {}, notePendingKey() {}, setDiaryTarget() {},
    isAbandonedKey: () => false, hasCompletedKey: () => false, noteAbandonedKey() {}, markCompletedKey() {},
  });
  return { calls, logs, wsDir, run: (name, input) => run(name, jobCtx(input)) };
}

describe("discover-semantic-links runtime gate (F3)", () => {
  const input = () => ({ commandCtx: { agentId: "a" }, memoryCtx: {}, cronInternal: true });

  it("skips and writes nothing when obsidianBridge.enabled is false", async () => {
    const h = harness({ bridge: { enabled: false, graphLinks: { semanticDiscovery: { enabled: true } } } });
    const out = await h.run("discover-semantic-links", input());
    assert.equal(out.skippedWith, "semantic_discovery_disabled");
    assert.equal(h.calls.discovery.length, 0);
    assert.equal(h.calls.policy.length, 0, "not even a policy is built");
  });

  it("skips when graphLinks.semanticDiscovery.enabled is false", async () => {
    const h = harness({ bridge: { enabled: true, graphLinks: { semanticDiscovery: { enabled: false } } } });
    const out = await h.run("discover-semantic-links", input());
    assert.equal(out.skippedWith, "semantic_discovery_disabled");
    assert.equal(h.calls.discovery.length, 0);
  });

  it("runs, with the standing-confirmation policy, when both are enabled", async () => {
    const h = harness({ bridge: { enabled: true, graphLinks: { semanticDiscovery: { enabled: true } } } });
    await h.run("discover-semantic-links", input());
    assert.equal(h.calls.discovery.length, 1);
    assert.equal(h.calls.discovery[0].mutationPolicy, POLICY);
    assert.deepEqual(h.calls.policy[0].opts, { plan: ["semantic-discovery", "confirm"], actionConfirmed: true });
  });

  it("keeps running for an installation that never set the flags (the cron plan installs on the same !== false reading)", async () => {
    const h = harness({ bridge: {} });
    await h.run("discover-semantic-links", input());
    assert.equal(h.calls.discovery.length, 1);
  });
});

describe("rem-dream semantic discovery (F4)", () => {
  // acl_sink_missing: the REM pass itself is skipped, which is all this test
  // needs before the fire-and-forget discovery after the partition loop.
  const remExtra = () => ({
    mergingEnabled: true,
    remPatternLlmCfg: { kind: "direct-override" },
    normalizedEmbeddingCfg: { provider: "x" },
    createOwnerBoundNeoStore: () => ({ paths: { workspaceDir: "/nonexistent" } }),
    createOwnerBoundTarget: () => ({}),
    createOwnerBoundMemoryStore: () => ({}),
    sharedMemoryPool: {},
    resolveTemperamentName: () => "default",
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("passes the mutation policy of the configured workspace to the discovery", async () => {
    const h = harness({ bridge: { enabled: true, graphLinks: { semanticDiscovery: { enabled: true } } }, extra: remExtra() });
    await h.run("rem-dream", { commandCtx: { agentId: "a", workspaceDir: h.wsDir }, memoryCtx: { agentId: "a" }, cronInternal: true });
    await settle();
    assert.equal(h.calls.discovery.length, 1, h.logs.join("\n"));
    assert.equal(h.calls.discovery[0].mutationPolicy, POLICY);
    assert.equal(h.calls.policy[0].workspace.workspaceId, "w1");
    assert.equal(h.calls.policy[0].workspace.agentId, "a");
    assert.deepEqual(h.calls.policy[0].opts, { plan: ["semantic-discovery", "confirm"], actionConfirmed: true });
  });

  it("does not run when obsidianBridge is disabled", async () => {
    const h = harness({ bridge: { enabled: false, graphLinks: { semanticDiscovery: { enabled: true } } }, extra: remExtra() });
    await h.run("rem-dream", { commandCtx: { agentId: "a", workspaceDir: h.wsDir }, memoryCtx: { agentId: "a" }, cronInternal: true });
    await settle();
    assert.equal(h.calls.discovery.length, 0);
  });

  it("does not run in a directory that is not a configured Obsidian workspace of the agent", async () => {
    const h = harness({ bridge: { enabled: true, graphLinks: { semanticDiscovery: { enabled: true } } }, extra: remExtra() });
    await h.run("rem-dream", { commandCtx: { agentId: "a", workspaceDir: makeTempDir("sem-gates-other-") }, memoryCtx: { agentId: "a" }, cronInternal: true });
    await settle();
    assert.equal(h.calls.discovery.length, 0);
  });

  it("does not run when semanticDiscovery is not enabled (unchanged strict reading on this path)", async () => {
    const h = harness({ bridge: { enabled: true }, extra: remExtra() });
    await h.run("rem-dream", { commandCtx: { agentId: "a", workspaceDir: h.wsDir }, memoryCtx: { agentId: "a" }, cronInternal: true });
    await settle();
    assert.equal(h.calls.discovery.length, 0);
  });
});
