import assert from "node:assert/strict";
import test from "node:test";

import { applySemanticLensToRecall, authorizedLensHydrator } from "../lib/semantic-lens-index.js";

// The index of a shared workspace (main + its subagents) lists main's private
// ids. Index membership must grant no access: hydration goes through checkAccess.
const EMPTY_ALIASES = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });
const ctxFor = (agentId) => ({ agentId, workspaceIdentity: "workspace:v1:shared", workspaceAliases: EMPTY_ALIASES });

const OWN = { id: "own-1", text: "Paris trip planning with the museum tickets", scope: "agent-private", agentId: "developer", storedBy: "developer", status: "active" };
const FOREIGN = { id: "foreign-1", text: "Paris trip planning private budget museum", scope: "agent-private", agentId: "main", storedBy: "main", status: "active" };
const LEGACY = { id: "legacy-1", text: "Paris trip museum notes", scope: "agent-private", agentId: "", storedBy: "developer", status: "active" };
const ROWS = new Map([OWN, FOREIGN, LEGACY].map((row) => [row.id, row]));

test("authorizedLensHydrator returns own rows and refuses other agents' private rows", async () => {
  const hydrate = authorizedLensHydrator(async (id) => ROWS.get(id) ?? null, ctxFor("developer"));
  assert.equal((await hydrate("own-1"))?.id, "own-1");
  assert.equal(await hydrate("foreign-1"), null);
  assert.equal((await hydrate("legacy-1"))?.id, "legacy-1", "storedBy still binds legacy rows without agentId");
  assert.equal(await hydrate("missing"), null);
});

test("the Lens never appends a foreign private row listed in the shared index", async () => {
  const index = {
    version: 1,
    memoryToCommunity: { "base-1": "c1", "own-1": "c1", "foreign-1": "c1" },
    communities: {
      c1: { id: "c1", size: 3, representativeMemoryIds: ["foreign-1", "own-1"], bridgeMemoryIds: [], fadedCandidateMemoryIds: [] },
    },
  };
  const base = [{ entry: { id: "base-1", text: "Paris trip planning museum" }, score: 0.9 }];
  const result = await applySemanticLensToRecall(base, {
    index,
    getMemoryById: authorizedLensHydrator(async (id) => ROWS.get(id) ?? null, ctxFor("developer")),
    semanticLens: { timeoutMs: 1000 },
  });
  assert.deepEqual(result.lensMemories.map((m) => m.entry.id), ["own-1"]);
});

test("the recall hook hydrates Lens rows through the authorized lookup", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(source, /getMemoryById: authorizedLensHydrator\(\(memoryId\) => db\.getById\(memoryId\), memoryCtx\)/);
  assert.doesNotMatch(source, /getMemoryById: async \(memoryId\) => db\.getById\(memoryId\)/);
});
