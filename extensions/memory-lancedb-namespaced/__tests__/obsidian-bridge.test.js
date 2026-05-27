import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_IGNORE_GLOBS,
  DEFAULT_INCLUDE_GLOBS,
  buildMemoryStorePayload,
  doctorObsidianBridge,
  formatMarkdownFrontmatter,
  initWorkspace,
  parseMarkdownFrontmatter,
  scanWorkspace,
  stableContentHash,
  syncWorkspace,
  validateBridgeCard,
} from "../lib/obsidian-bridge.js";

function makeWorkspace(tmp, id = "main") {
  const path = join(tmp, id);
  return {
    workspaceId: id,
    agentId: id,
    label: id,
    path,
    includeGlobs: ["memory/cards/**/*.md", "decisions/**/*.md", "memory/KNOWLEDGE.md"],
    ignoreGlobs: [".obsidian/**", ".adaptive-learning/**", "memory/archive/expired/**"],
    tombstoneOnDelete: true,
  };
}

function writeCard(workspace, relPath, body, extra = {}) {
  const abs = join(workspace.path, relPath);
  const fm = {
    plur1bus_type: "memory_card",
    workspace_id: workspace.workspaceId,
    agent_id: workspace.agentId,
    memory_id: "",
    category: "fact",
    importance: 0.8,
    scope: "workspace",
    source_kind: "obsidian",
    sync_status: "draft",
    content_hash: stableContentHash(body),
    ...extra,
  };
  writeFileSync(abs, formatMarkdownFrontmatter(fm, body), "utf8");
}

test("Obsidian card frontmatter roundtrips and hash ignores metadata", () => {
  const body = "Stable fact\n";
  const content = formatMarkdownFrontmatter({
    plur1bus_type: "memory_card",
    workspace_id: "main",
    agent_id: "main",
    category: "fact",
    importance: 0.9,
    scope: "workspace",
    source_kind: "obsidian",
    sync_status: "draft",
    content_hash: stableContentHash(body),
  }, body);
  const parsed = parseMarkdownFrontmatter(content);
  assert.equal(parsed.frontmatter.plur1bus_type, "memory_card");
  assert.equal(parsed.frontmatter.importance, 0.9);
  assert.equal(stableContentHash(parsed.body), stableContentHash(body));
});

test("Obsidian card validation allows exactly the bridge category subset", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-test-"));
  try {
    const workspace = makeWorkspace(tmp);
    initWorkspace(workspace, { dryRun: false });
    writeCard(workspace, "memory/cards/ok.md", "Allowed\n", { category: "preference" });
    writeCard(workspace, "memory/cards/bad.md", "Rejected\n", { category: "debug" });
    const scan = scanWorkspace(workspace);
    const ok = scan.files.find((file) => file.relPath.endsWith("ok.md"));
    const bad = scan.files.find((file) => file.relPath.endsWith("bad.md"));
    assert.deepEqual(validateBridgeCard(ok, workspace).errors, []);
    assert.ok(validateBridgeCard(bad, workspace).errors.some((error) => error.includes("invalid category")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("raw Obsidian sync proposes candidates and does not call memoryStore", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-test-"));
  try {
    const workspace = makeWorkspace(tmp);
    initWorkspace(workspace, { dryRun: false });
    writeCard(workspace, "memory/cards/fact.md", "The bridge proposes through PLUR1BUS review first.\n");
    const calls = [];
    const result = await syncWorkspace(workspace, {
      dryRun: false,
      memoryStore: async ({ payload }) => {
        calls.push(payload);
        return { details: { action: "stored", id: "mem-1" } };
      },
    });
    assert.equal(calls.length, 0);
    assert.ok(result.actions.some((action) => action.action === "approval_required"));
    const candidates = readFileSync(join(workspace.path, ".adaptive-learning/obsidian-bridge/candidates.jsonl"), "utf8");
    assert.match(candidates, /obsidian\.candidate/);
    assert.match(candidates, /untrusted_obsidian/);
    const updated = readFileSync(join(workspace.path, "memory/cards/fact.md"), "utf8");
    assert.match(updated, /sync_status: draft/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("approved apply path uses memoryStore callback instead of raw DB writes", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-test-"));
  try {
    const workspace = makeWorkspace(tmp);
    initWorkspace(workspace, { dryRun: false });
    writeCard(workspace, "memory/cards/fact.md", "Approved apply stores through memory_store.\n");
    const calls = [];
    const result = await syncWorkspace(workspace, {
      dryRun: false,
      applyApproved: true,
      approvedPaths: ["memory/cards/fact.md"],
      memoryStore: async ({ payload }) => {
        calls.push(payload);
        return { details: { action: "stored", id: "mem-1" } };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].category, "fact");
    assert.ok(result.actions.some((action) => action.action === "memory_stored"));
    const updated = readFileSync(join(workspace.path, "memory/cards/fact.md"), "utf8");
    assert.match(updated, /sync_status: synced/);
    assert.match(updated, /memory_id: mem-1/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("approved apply path without runtime callback queues memory_store requests", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-test-"));
  try {
    const workspace = makeWorkspace(tmp);
    initWorkspace(workspace, { dryRun: false });
    writeCard(workspace, "memory/cards/queued.md", "Queue this through approved runtime later.\n");
    await syncWorkspace(workspace, {
      dryRun: false,
      applyApproved: true,
      approvedPaths: ["memory/cards/queued.md"],
    });
    const queue = readFileSync(join(workspace.path, ".adaptive-learning/obsidian-bridge/store-queue.jsonl"), "utf8");
    assert.match(queue, /memory_store\.requested/);
    const updated = readFileSync(join(workspace.path, "memory/cards/queued.md"), "utf8");
    assert.match(updated, /sync_status: queued/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("tombstone is created when a synced card disappears", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-test-"));
  try {
    const workspace = makeWorkspace(tmp);
    initWorkspace(workspace, { dryRun: false });
    writeCard(workspace, "memory/cards/delete-me.md", "Delete should tombstone.\n");
    await syncWorkspace(workspace, {
      dryRun: false,
      applyApproved: true,
      approvedPaths: ["memory/cards/delete-me.md"],
      memoryStore: async () => ({ details: { action: "stored", id: "mem-delete" } }),
    });
    unlinkSync(join(workspace.path, "memory/cards/delete-me.md"));
    const result = await syncWorkspace(workspace, {
      dryRun: false,
      applyApproved: true,
      approvedPaths: ["memory/cards/delete-me.md"],
    });
    assert.ok(result.actions.some((action) => action.action === "tombstone"));
    assert.ok(existsSync(join(workspace.path, "memory/archive/expired")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ordinary Obsidian documents become untrusted proposals, not memory", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-test-"));
  try {
    const workspace = makeWorkspace(tmp);
    workspace.includeGlobs = ["**/*.md"];
    initWorkspace(workspace, { dryRun: false });
    writeFileSync(join(workspace.path, "projects/imported-doc.md"), "# Imported Doc\n\nA vault document may inform review.\n", "utf8");
    const calls = [];
    const result = await syncWorkspace(workspace, {
      dryRun: false,
      memoryStore: async ({ payload }) => {
        calls.push(payload);
      },
    });
    assert.equal(calls.length, 0);
    assert.ok(result.actions.some((action) => action.action === "obsidian_candidate_queued"));
    const candidates = readFileSync(join(workspace.path, ".adaptive-learning/obsidian-bridge/candidates.jsonl"), "utf8");
    assert.match(candidates, /projects\/imported-doc\.md/);
    assert.match(candidates, /review_source/);
    assert.match(candidates, /mutateMemory":false/);
    assert.match(candidates, /"payloadHash":"sha256:/);
    assert.match(candidates, /"sourceTrustLevel":"untrusted_obsidian"/);
    assert.match(candidates, /"applyPreview":/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("workspace isolation reports cross-workspace frontmatter", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-test-"));
  try {
    const primary = makeWorkspace(tmp, "primary");
    const secondary = makeWorkspace(tmp, "secondary");
    initWorkspace(primary, { dryRun: false });
    initWorkspace(secondary, { dryRun: false });
    writeCard(primary, "memory/cards/cross.md", "Wrong workspace.\n", { workspace_id: "secondary" });
    const report = await doctorObsidianBridge({
      enabled: false,
      dryRun: true,
      workspaces: [
        { workspace_id: "primary", agent_id: "agent-primary", path: primary.path },
        { workspace_id: "secondary", agent_id: "agent-secondary", path: secondary.path },
      ],
    });
    assert.equal(report.ok, false);
    assert.ok(report.reports[0].issues.some((issue) => issue.code === "invalid_frontmatter" && issue.message.includes("workspace_id")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("validated decisions become memory_store payloads", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-test-"));
  try {
    const workspace = makeWorkspace(tmp);
    initWorkspace(workspace, { dryRun: false });
    const body = "We decided to keep memory-core as slot owner.\n";
    writeFileSync(join(workspace.path, "decisions/slot-owner.md"), formatMarkdownFrontmatter({
      plur1bus_type: "decision",
      workspace_id: "main",
      agent_id: "main",
      category: "decision",
      importance: 0.9,
      scope: "workspace",
      source_kind: "obsidian",
      sync_status: "validated",
      content_hash: stableContentHash(body),
      validated: true,
    }, body), "utf8");
    const scan = scanWorkspace(workspace);
    const decision = scan.files.find((file) => file.relPath === "decisions/slot-owner.md");
    assert.equal(buildMemoryStorePayload(decision, workspace).category, "decision");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// P1: PLUR1BUS-generated output files must not be re-scanned as external edits
test("DEFAULT_IGNORE_GLOBS excludes evening-deep-review output files from vault scan", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-test-"));
  try {
    const path = join(tmp, "main");
    const workspace = {
      workspaceId: "main",
      agentId: "main",
      label: "main",
      path,
      includeGlobs: DEFAULT_INCLUDE_GLOBS,
      ignoreGlobs: DEFAULT_IGNORE_GLOBS,
      tombstoneOnDelete: true,
    };
    initWorkspace(workspace, { dryRun: false });
    writeFileSync(join(path, "evening-deep-review-2026-05-26-2105.md"), "# PLUR1BUS Evening Deep Review\nPLUR1BUS-generated artifact.\n", "utf8");
    const scan = scanWorkspace(workspace);
    assert.equal(
      scan.files.find((f) => f.relPath.includes("evening-deep-review")),
      undefined,
      "evening-deep-review-*.md files must be excluded by DEFAULT_IGNORE_GLOBS"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
