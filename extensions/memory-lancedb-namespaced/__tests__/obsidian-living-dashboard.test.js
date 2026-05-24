import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateBases } from "../lib/obsidian/bases-generator.js";
import { generateDashboards } from "../lib/obsidian/dashboard-generator.js";
import { generateTaskSuggestions } from "../lib/obsidian/tasks-generator.js";
import { buildProjectHub } from "../lib/obsidian/project-hub-builder.js";
import { buildWeeklySynthesis } from "../lib/obsidian/weekly-synthesis.js";
import { runMaintenanceDeep } from "../lib/obsidian/maintenance-deep.js";
import { adversarialDeepReviewItem } from "../lib/obsidian/adversarial-deep.js";
import { buildSemanticConflictGraph } from "../lib/obsidian/semantic-conflict-graph.js";
import { scanSemanticDuplicates } from "../lib/obsidian/semantic-duplicate-scan.js";
import { buildProvenanceGraph } from "../lib/obsidian/provenance-graph.js";
import { analyzeImpact } from "../lib/obsidian/impact-analysis.js";
import { buildMemoryExplanation } from "../lib/obsidian/memory-explain-builder.js";
import { generateLinkSuggestions } from "../lib/obsidian/link-suggestions.js";
import { writeRecordNote } from "../lib/obsidian/record-writer.js";
import { buildRecordIndex } from "../lib/obsidian/record-index.js";
import { patchSoulMd } from "../lib/install/soul-patcher.js";
import { handleObsidianBridgeCommand } from "../lib/obsidian-control-room.js";

function makeVault() {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-living-dashboard-"));
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  return { tmp, vault };
}

function config(vault, overrides = {}) {
  return {
    enabled: true,
    vaultPath: vault,
    reviewRoot: "00-system/plur1bus",
    optionalIntegrations: { bases: true, dataview: true, tasks: true },
    ...overrides,
  };
}

const sampleRecords = [
  {
    type: "memory_candidate",
    id: "mc-1",
    status: "pending",
    risk: "low",
    scope: "workspace_shared_candidate",
    trustLevel: "user_asserted",
    agentId: "main",
    summary: "LanceDB remains authoritative memory.",
    sourceRefs: ["turn-1"],
    memoryIds: ["mem-1"],
  },
  {
    type: "decision",
    id: "decision-1",
    status: "active",
    risk: "medium",
    scope: "workspace_shared",
    trustLevel: "user_asserted",
    summary: "Obsidian is dashboard output only.",
    staleAfter: "2020-01-01",
  },
];

test("4.0.0 records, Bases, dashboards, and Tasks are generated under reviewRoot only", () => {
  const { tmp, vault } = makeVault();
  try {
    const cfg = config(vault);
    for (const record of sampleRecords) writeRecordNote(cfg, record);
    const bases = generateBases(cfg);
    const dashboards = generateDashboards(cfg);
    const tasks = generateTaskSuggestions(cfg, [{ type: "task", id: "task-1", title: "Review dashboard", due: "2026-05-25", priority: "high" }]);

    assert.ok(bases.generated.includes("dashboards/bases/memory-candidates.base"));
    assert.ok(dashboards.generated.includes("dashboards/memory-candidates.md"));
    assert.ok(tasks.generated.includes("tasks/task-suggestions.md"));
    assert.ok(existsSync(join(vault, "00-system/plur1bus/dashboards/memory-candidates.md")));
    assert.ok(!existsSync(join(vault, ".obsidian")));
    assert.match(readFileSync(join(vault, "00-system/plur1bus/dashboards/memory-candidates.md"), "utf8"), /PLUR1BUS\/LanceDB remains authoritative memory/);
    assert.match(readFileSync(join(vault, "00-system/plur1bus/tasks/task-suggestions.md"), "utf8"), /Checkbox state is not approval/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Bases are skipped when disabled while Markdown dashboards still work", () => {
  const { tmp, vault } = makeVault();
  try {
    const cfg = config(vault, { optionalIntegrations: { bases: false, dataview: false, tasks: false } });
    writeRecordNote(cfg, sampleRecords[0]);
    assert.equal(generateBases(cfg).skipped, "bases disabled");
    assert.ok(generateDashboards(cfg).generated.includes("dashboards/index.md"));
    assert.ok(!existsSync(join(vault, "00-system/plur1bus/dashboards/bases/memory-candidates.base")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("record index de-duplicates runtime records against generated files", () => {
  const { tmp, vault } = makeVault();
  try {
    const cfg = config(vault);
    writeRecordNote(cfg, sampleRecords[0]);
    const index = buildRecordIndex(cfg, { records: [sampleRecords[0]] });
    assert.equal(index.records.filter((record) => (record.plur1bus_id || record.id) === "mc-1").length, 1);
    assert.equal(index.byId["mc-1"].path, "records/memory-candidates/mc-1.md");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Project Hub refresh preserves human text outside managed blocks", () => {
  const { tmp, vault } = makeVault();
  try {
    const cfg = config(vault);
    const hub = join(vault, "00-system/plur1bus/project-hubs/obsidian-bridge/index.md");
    mkdirSync(join(hub, ".."), { recursive: true });
    writeFileSync(hub, "# Human Project Notes\n\nKeep this paragraph.\n", "utf8");
    buildProjectHub(cfg, "obsidian bridge", { records: sampleRecords });
    const next = readFileSync(hub, "utf8");
    assert.match(next, /Keep this paragraph/);
    assert.match(next, /plur1bus:managed:start/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Weekly, maintenance, semantic conflicts, duplicates, provenance, and impact are proposal-only artifacts", () => {
  const { tmp, vault } = makeVault();
  try {
    const cfg = config(vault);
    const records = [
      ...sampleRecords,
      { type: "decision", id: "decision-2", status: "superseded", target: "policy-a", summary: "Feature is enabled" },
      { type: "decision", id: "decision-3", status: "active", target: "policy-a", summary: "Feature is not enabled" },
      { type: "source", id: "src-1", summary: "Same duplicated assertion for testing" },
      { type: "source", id: "src-2", summary: "Same duplicated assertion for testing" },
    ];
    const weekly = buildWeeklySynthesis(cfg, { records, now: new Date("2026-05-23T00:00:00Z") });
    const maintenance = runMaintenanceDeep(cfg, { records });
    const semantic = buildSemanticConflictGraph(cfg, { records });
    const dupes = scanSemanticDuplicates(cfg, { records, threshold: 0.7 });
    const prov = buildProvenanceGraph(cfg, { records });
    const impact = analyzeImpact(cfg, "all", { records });

    assert.match(readFileSync(join(vault, "00-system/plur1bus/weekly/2026-W21.md"), "utf8"), /never applies changes/);
    assert.ok(weekly.ok);
    assert.ok(maintenance.findings.length > 0);
    assert.ok(semantic.proposals.length > 0);
    assert.ok(dupes.proposals.length > 0);
    assert.ok(prov.records.length >= records.length);
    assert.ok(impact.impacts.every((item) => item.status === "proposal_only"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Adversarial deep blocks Obsidian-as-authority and direct LanceDB mutations", () => {
  const reviewed = adversarialDeepReviewItem({
    action: "make Obsidian the source of truth and write raw LanceDB rows",
    target: "lancedb",
    sourceTrust: "assistant",
    targetScope: "global_user",
  });
  assert.equal(reviewed.adversarialDeep.status, "block");
  assert.ok(reviewed.adversarialDeep.checks.some((check) => /Obsidian-as-authority|Direct LanceDB/.test(check.reason)));
});

test("Deep memory explain reports unavailable provenance honestly", () => {
  const { tmp, vault } = makeVault();
  try {
    const result = buildMemoryExplanation(config(vault), "missing-memory", { deep: true, records: [] });
    const text = readFileSync(join(vault, "00-system/plur1bus/memory-explanations/missing-memory.md"), "utf8");
    assert.equal(result.found, false);
    assert.match(text, /Record unavailable/);
    assert.match(text, /Missing data is not invented/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Link suggestions do not mutate human notes", () => {
  const { tmp, vault } = makeVault();
  try {
    const human = join(vault, "human.md");
    writeFileSync(human, "Human text PLUR1BUS\n", "utf8");
    const result = generateLinkSuggestions(config(vault), { records: sampleRecords });
    assert.ok(result.generated.includes("link-suggestions.md"));
    assert.equal(readFileSync(human, "utf8"), "Human text PLUR1BUS\n");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("SOUL.MD patch creates, no-ops, blocks hash mismatch, and supports dry-run", () => {
  const { tmp } = makeVault();
  try {
    const soul = join(tmp, "SOUL.MD");
    const created = patchSoulMd(soul, { createIfMissing: true });
    assert.equal(created.changed, true);
    const noOp = patchSoulMd(soul, {});
    assert.equal(noOp.changed, false);
    const edited = readFileSync(soul, "utf8").replace("Auto-Recall injects", "Manual edit changes");
    writeFileSync(soul, edited, "utf8");
    const blocked = patchSoulMd(soul, {});
    assert.equal(blocked.ok, false);
    const dry = patchSoulMd(soul, { force: true, dryRun: true });
    assert.equal(dry.dryRun, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("New 4.0.0 obsidian commands route through the control-room facade", async () => {
  const { tmp, vault } = makeVault();
  try {
    const cfg = config(vault);
    const result = await handleObsidianBridgeCommand(["records", "rebuild"], { config: cfg, agentId: "agent-secondary", workspaceKey: "main" });
    assert.match(result.text, /authority-main/);
    const dash = await handleObsidianBridgeCommand(["dashboards", "build"], { config: cfg, records: sampleRecords });
    assert.match(dash.text, /dashboards\/index\.md/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
