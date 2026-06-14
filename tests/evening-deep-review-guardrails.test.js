import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleObsidianBridgeCommand, runEveningDeepReview } from "../lib/obsidian-control-room.js";
import { buildRecordIndex } from "../lib/obsidian/record-index.js";

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-evening-guard-"));
  mkdirSync(join(dir, "plur1bus"), { recursive: true });
  return dir;
}

function sourceRecord(agentId, workspaceKey) {
  return {
    type: "source",
    id: `authority-${workspaceKey}`,
    status: "current",
    risk: "low",
    scope: "dashboard_only",
    trustLevel: "system_declared",
    origin: "plur1bus",
    agentId,
    summary: "PLUR1BUS/LanceDB remains authoritative memory.",
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
  };
}

function runAllowed(agentId, workspaceKey) {
  const vault = makeVault();
  return runEveningDeepReview(
    { vaultPath: vault, reviewRoot: "plur1bus" },
    {
      agentId,
      workspaceKey,
      records: [sourceRecord(agentId, workspaceKey)],
      items: [],
      now: new Date("2026-06-14T18:00:00.000Z"),
    },
  );
}

describe("evening deep review guardrails", () => {
  it("does not silently default missing context to main", () => {
    const vault = makeVault();
    const result = runEveningDeepReview(
      { vaultPath: vault, reviewRoot: "plur1bus" },
      { records: [sourceRecord("main", "main")], items: [] },
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "missing_evening_review_context");
  });

  it("rejects bernhardine agent with main workspace", () => {
    const result = runEveningDeepReview(
      { vaultPath: makeVault(), reviewRoot: "plur1bus" },
      { agentId: "bernhardine", workspaceKey: "main", records: [sourceRecord("bernhardine", "main")], items: [] },
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "workspace_agent_mismatch");
  });

  it("rejects heisenberg agent with main workspace", () => {
    const result = runEveningDeepReview(
      { vaultPath: makeVault(), reviewRoot: "plur1bus" },
      { agentId: "heisenberg", workspaceKey: "main", records: [sourceRecord("heisenberg", "main")], items: [] },
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "workspace_agent_mismatch");
  });

  it("allows main, bernhardine, and heisenberg with matching workspaces", () => {
    for (const workspace of ["main", "bernhardine", "heisenberg"]) {
      const result = runAllowed(workspace, workspace);
      assert.strictEqual(result.ok, true, workspace);
      assert.strictEqual(result.agentId, workspace);
      assert.strictEqual(result.workspaceKey, workspace);
    }
  });

  it("excludes generated analysis record types from deep-review input", () => {
    const index = buildRecordIndex(
      { vaultPath: makeVault(), reviewRoot: "plur1bus" },
      {
        records: [
          { plur1bus_id: "source-real", plur1bus_type: "source", scope: "external", path: "records/sources/source-real.md" },
          { plur1bus_id: "dup-a", plur1bus_type: "duplicate_candidate", path: "records/duplicate-candidates/dup-a.md" },
          { plur1bus_id: "impact-a", plur1bus_type: "impact_analysis", path: "records/impact-analysis/impact-a.md" },
          { plur1bus_id: "prov-a", plur1bus_type: "provenance", path: "records/provenance/prov-a.md" },
          { plur1bus_id: "source-dashboard", plur1bus_type: "source", scope: "dashboard_only", path: "records/sources/authority-main.md" },
        ],
        deepReviewInput: true,
        readExistingRecords: false,
      },
    );

    assert.deepStrictEqual(index.records.map((record) => record.plur1bus_id), ["source-real"]);
  });

  it("excludes recursive generated names and paths from deep-review input", () => {
    const index = buildRecordIndex(
      { vaultPath: makeVault(), reviewRoot: "plur1bus" },
      {
        records: [
          { plur1bus_id: "decision-real", plur1bus_type: "decision", path: "records/decisions/decision-real.md" },
          { plur1bus_id: "looks-real-dup", plur1bus_type: "decision", path: "records/decisions/dup-impact-a.md" },
          { plur1bus_id: "looks-real-prov", plur1bus_type: "decision", path: "records/provenance/prov-real.md" },
          { plur1bus_id: "impact-name", plur1bus_type: "project", path: "records/projects/impact-prov-a.md" },
        ],
        deepReviewInput: true,
        readExistingRecords: false,
      },
    );

    assert.deepStrictEqual(index.records.map((record) => record.plur1bus_id), ["decision-real"]);
  });

  it("command evening-review requires explicit command context", async () => {
    const result = await handleObsidianBridgeCommand(["evening-review"], {
      config: { vaultPath: makeVault(), reviewRoot: "plur1bus" },
      records: [sourceRecord("main", "main")],
      items: [],
    });

    const payload = JSON.parse(result.text);
    assert.strictEqual(payload.ok, false);
    assert.match(result.text, /missing_evening_review_context/);
  });

  it("command evening-review maps a known cron agent to its workspace", async () => {
    const result = await handleObsidianBridgeCommand(["evening-review"], {
      config: { vaultPath: makeVault(), reviewRoot: "plur1bus" },
      agentId: "bernhardine",
      records: [sourceRecord("bernhardine", "bernhardine")],
      items: [],
    });

    assert.match(result.text, /Abend-Review/);
    assert.doesNotMatch(result.text, /workspace_agent_mismatch|missing_evening_review_context/);
  });
});
