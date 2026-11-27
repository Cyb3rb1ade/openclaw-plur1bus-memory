import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers/temp-dir.js";

import { plainScanVector } from "../engine/store/memory-db.js";
import { runSemanticDiscoveryBatches } from "../engine/runtime/semantic-discovery.js";
import { computeContentHash } from "../lib/obsidian/link-index.js";
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

function record(n) {
  return {
    id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    type: "memory",
    vector: [n % 7, 1, 0.5],
    text: `memory number ${n}`,
    summary: "",
    scope: "agent-private",
    agentId: "main",
    storedBy: "main",
  };
}

test("plainScanVector turns Arrow-like, typed and plain vectors into arrays", () => {
  assert.deepEqual(plainScanVector([1, 2]), [1, 2]);
  assert.deepEqual(plainScanVector(new Float32Array([1, 2])), [1, 2]);
  assert.deepEqual(plainScanVector({ toArray: () => new Float32Array([3, 4]) }), [3, 4]);
  assert.equal(plainScanVector(null), null);
  assert.equal(plainScanVector(new Float32Array(0)), null);
});

test("unchanged rows do not use up the nightly budget, new rows behind them are still found", async () => {
  const vault = makeTempDir("plur1bus-sem-budget-");
  const rows = Array.from({ length: 1200 }, (_, i) => record(i + 1));
  // 1150 rows are already indexed with their current hash; the 50 new ones come last.
  const entries = {};
  for (const row of rows.slice(0, 1150)) {
    entries[row.id] = { similar: [], contentHash: computeContentHash(row), firstDiscoveredAt: "2026-06-14T00:00:00.000Z", lastCheckedAt: "2026-06-14T00:00:00.000Z" };
  }
  mkdirSync(join(vault, ".plur1bus"), { recursive: true });
  writeFileSync(join(vault, ".plur1bus", "link-index.json"), JSON.stringify({ version: 1, entries }));

  let searches = 0;
  const db = {
    async *scanActiveBatches({ batchSize, withVectors }) {
      assert.equal(withVectors, true, "discovery must request vectors");
      for (let i = 0; i < rows.length; i += batchSize) yield rows.slice(i, i + batchSize);
    },
    async search() { searches += 1; return []; },
  };
  const result = await runSemanticDiscoveryBatches({
    db,
    semVaultCfg: { vaultPath: vault, graphLinks: { semanticDiscovery: { batchSize: 500, maxPerRun: 500 } } },
    pool: {},
    logger: null,
    defaultAgentId: "main",
    mutationPolicy: POLICY,
  });

  assert.equal(result.processed, 50);
  assert.equal(result.unchanged, 1150);
  assert.equal(searches, 50);
  const written = JSON.parse(readFileSync(join(vault, ".plur1bus", "link-index.json"), "utf8"));
  assert.equal(Object.keys(written.entries).length, 1200);
});
