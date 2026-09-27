/**
 * tests/recall-pipeline-read-only.test.js — E5 Task 9: `runRecallPipeline`
 * with `readOnly: true` searches exactly as before but persists nothing: the
 * canonical KNOWLEDGE.md embedding cache is not written.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MemoryDB } from "../engine/store/memory-db.js";
import { runRecallPipeline } from "../lib/recall-pipeline.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const DIM = 4;
const unit = () => [1, 0, 0, 0];
const embeddings = { dim: DIM, embed: async () => unit(), embedQuery: async () => unit() };
const silent = { info() {}, warn() {}, error() {}, debug() {} };

function workspaceWithKnowledge() {
  const workspaceDir = makeTempDir("rpro-ws-");
  mkdirSync(join(workspaceDir, "memory"), { recursive: true });
  writeFileSync(join(workspaceDir, "memory", "KNOWLEDGE.md"), "# Knowledge\n\n## Garden\n\nThe garden gate sticks in wet weather.\n\n## Kitchen\n\nThe kitchen tap drips at night.\n");
  return workspaceDir;
}

describe("runRecallPipeline readOnly (E5 Task 9)", () => {
  it("readOnly does not persist the canonical cache; the default still does", async () => {
    const db = new MemoryDB(join(makeTempDir("rpro-db-"), "agent-g"), DIM);
    try {
      await db.store({ id: "m1", text: "The garden gate sticks when it rains.", vector: unit(), category: "fact", createdAt: Date.now(), storedBy: "agent-g" });
      const run = (workspaceDir, readOnly) => runRecallPipeline({
        query: "what about the garden gate",
        dbTable: db.table,
        embeddings,
        workspaceDir,
        canonicalEnabled: true,
        agentId: "agent-g",
        logger: silent,
        readOnly,
      });

      const readOnlyWs = workspaceWithKnowledge();
      const warm = await run(readOnlyWs, true);
      assert.ok(warm.canonical.length > 0, "the canonical search still ran");
      assert.equal(existsSync(join(readOnlyWs, ".adaptive-learning")), false, "no .adaptive-learning directory");

      const writingWs = workspaceWithKnowledge();
      const real = await run(writingWs, false);
      assert.ok(real.canonical.length > 0);
      assert.equal(existsSync(join(writingWs, ".adaptive-learning", "knowledge-cache.json")), true, "the cache file exists");
    } finally {
      await db.shutdown();
    }
  });
});
