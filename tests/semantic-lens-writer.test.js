import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers/temp-dir.js";

import { runSemanticDiscoveryBatches } from "../engine/runtime/semantic-discovery.js";
import { applySemanticLensToRecall, clearSemanticLensIndexCache, loadSemanticLensIndex } from "../lib/semantic-lens-index.js";
import { buildSemanticLensIndex, saveSemanticLensIndex } from "../lib/semantic-lens-writer.js";
import { parseObsidianCommandPlan } from "../lib/obsidian-mutation-policy.js";

const POLICY = parseObsidianCommandPlan(["semantic-discovery", "confirm"], {
  memoryCtx: { agentId: "main", workspaceIdentity: "workspace:v1:main", workspaceId: "workspace:v1:main" },
  baseDbPath: "/store",
  mode: "apply",
  dryRun: false,
  allowWrite: true,
  vaultConfirmed: true,
  actionConfirmed: true,
}).mutationPolicy;

const row = (id, extra = {}) => ({ id, category: "fact", scope: "agent-private", agentId: "main", importance: 0.5, createdAt: 1_000, ...extra });

// Two triangles (a*, b*) joined by one edge a3–b1.
const RECORDS = [
  row("a1", { importance: 0.9, createdAt: 5_000 }), row("a2", { createdAt: 1_000 }), row("a3", { createdAt: 3_000 }),
  row("b1"), row("b2", { category: "preference" }), row("b3"),
];
const LINKS = {
  entries: {
    a1: { similar: ["a2", "a3"] },
    a2: { similar: ["a1", "a3"] },
    a3: { similar: ["a1", "a2", "b1"] },
    b1: { similar: ["b2", "b3", "a3"] },
    b2: { similar: ["b1", "b3"] },
    b3: { similar: ["b1", "b2"] },
  },
};

test("clusters the neighbour graph into stable communities with roles", () => {
  const index = buildSemanticLensIndex({ linkIndex: LINKS, records: RECORDS, workspaceId: "main", now: new Date("2026-11-23T00:00:00Z") });
  assert.equal(index.version, 1);
  assert.deepEqual(Object.keys(index.communities).sort(), ["lens-a1", "lens-b1"]);
  assert.equal(index.memoryToCommunity.a2, "lens-a1");
  assert.equal(index.memoryToCommunity.b3, "lens-b1");
  const a = index.communities["lens-a1"];
  assert.equal(a.size, 3);
  assert.deepEqual(a.representativeMemoryIds, ["a1", "a2", "a3"], "equally connected: most important first, then id");
  assert.deepEqual(a.bridgeMemoryIds, ["a3"]);
  assert.deepEqual(a.fadedCandidateMemoryIds, [], "representatives are never faded");
  assert.deepEqual(index.communities["lens-b1"].labels.category, ["fact", "preference"]);
  assert.deepEqual(index.stats, { memories: 6, linkedMemories: 6, edges: 7, communities: 2, members: 6 });

  const again = buildSemanticLensIndex({ linkIndex: LINKS, records: [...RECORDS].reverse(), workspaceId: "main", now: new Date("2026-11-23T00:00:00Z") });
  assert.deepEqual(again, index, "input order does not change the result");
});

test("faded candidates are the oldest members outside the representatives", () => {
  // A star of five around h, all linked to h only.
  const records = ["h", "s1", "s2", "s3", "s4", "s5"].map((id, i) => row(id, { createdAt: 10_000 - i * 1_000 }));
  const entries = { h: { similar: ["s1", "s2", "s3", "s4", "s5"] } };
  const index = buildSemanticLensIndex({ linkIndex: { entries }, records });
  const star = index.communities["lens-h"];
  assert.equal(star.size, 6);
  assert.equal(star.representativeMemoryIds[0], "h");
  assert.deepEqual(star.fadedCandidateMemoryIds, ["s5", "s4", "s3"].filter((id) => !star.representativeMemoryIds.includes(id)).slice(0, 3));
  assert.ok(star.fadedCandidateMemoryIds.length > 0);
});

test("memories no longer active drop out of the graph", () => {
  const index = buildSemanticLensIndex({ linkIndex: LINKS, records: RECORDS.filter((r) => r.id !== "a2" && r.id !== "b2"), workspaceId: "main" });
  assert.equal(index.memoryToCommunity.a2, undefined);
  assert.equal(index.memoryToCommunity.b2, undefined);
  for (const community of Object.values(index.communities)) {
    for (const id of [...community.representativeMemoryIds, ...community.bridgeMemoryIds, ...community.fadedCandidateMemoryIds]) {
      assert.notEqual(id, "a2");
      assert.notEqual(id, "b2");
    }
  }
});

test("the reader loads what the writer saves, and the Lens appends a community member", async () => {
  const vault = makeTempDir("plur1bus-lens-writer-");
  const index = buildSemanticLensIndex({ linkIndex: LINKS, records: RECORDS, workspaceId: "main" });
  assert.equal(saveSemanticLensIndex(vault, index, { mutationPolicy: null }).written, false, "no policy, no write");
  assert.equal(saveSemanticLensIndex(vault, index, { mutationPolicy: POLICY }).written, true);
  clearSemanticLensIndexCache();
  const loaded = loadSemanticLensIndex({ workspaceDir: vault });
  assert.equal(loaded?.index.communities["lens-a1"].size, 3);

  const texts = { a1: "Paris museum trip tickets", a2: "Paris museum trip budget", a3: "Paris museum trip hotel" };
  const result = await applySemanticLensToRecall(
    [{ entry: { id: "a2", text: texts.a2 }, score: 0.9 }],
    { workspaceDir: vault, getMemoryById: async (id) => (texts[id] ? { id, text: texts[id], status: "active" } : null), semanticLens: { timeoutMs: 1000 } },
  );
  assert.ok(result.lensMemories.length > 0);
  assert.ok(result.lensMemories.every((m) => ["a1", "a3"].includes(m.entry.id)));
});

test("the nightly discovery run writes the Lens index next to the link index", async () => {
  const vault = makeTempDir("plur1bus-lens-nightly-");
  const rows = RECORDS.map((r, i) => ({ ...r, type: "memory", text: `memory ${r.id}`, summary: "", vector: [i, 1, 0] }));
  const neighbours = Object.fromEntries(Object.entries(LINKS.entries).map(([id, e]) => [id, e.similar]));
  const db = {
    async *scanActiveBatches({ withVectors }) {
      yield rows.map((r) => (withVectors ? r : { ...r, vector: null }));
    },
    async search(vector) {
      const self = rows.find((r) => r.vector[0] === vector[0]);
      return neighbours[self.id].map((id) => ({ entry: { id }, score: 0.9 }));
    },
  };
  const result = await runSemanticDiscoveryBatches({
    db, semVaultCfg: { vaultPath: vault }, pool: {}, logger: null, defaultAgentId: "main", mutationPolicy: POLICY,
  });
  assert.equal(result.processed, 6);
  assert.deepEqual(result.lens, { written: true, communities: 2, members: 6, edges: 7 });
  const lensPath = join(vault, ".plur1bus", "semantic-lens-index.json");
  assert.ok(existsSync(lensPath));
  assert.equal(JSON.parse(readFileSync(lensPath, "utf8")).memoryToCommunity.b2, "lens-b1");
});
