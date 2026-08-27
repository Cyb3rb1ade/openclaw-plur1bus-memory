import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { connect } from "@lancedb/lancedb";

import {
  createLanceGenerationBackend,
  stableNonVectorRowHash,
} from "../lib/reembedding/lance-backend.js";

const rows = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    vector: [0.1, 0.2, 0.3],
    text: "first memory",
    agentId: "agent-a",
    workspaceId: "workspace:v1:alpha",
    status: "active",
    createdAt: 100,
    validFrom: 50,
    validUntil: 0,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    vector: [0.4, 0.5, 0.6],
    text: "archived memory",
    agentId: "agent-a",
    workspaceId: "workspace:v1:alpha",
    status: "archived",
    createdAt: 200,
    validFrom: 150,
    validUntil: 190,
  },
];

describe("quarantined LanceDB reembedding generations", () => {
  let root;
  let activeRoot;
  let stateRoot;
  let sourceTable;
  let sourceDb;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "plur1bus-reembedding-lance-"));
    activeRoot = join(root, "active");
    stateRoot = join(root, "state");
    sourceDb = await connect(join(activeRoot, "agent-a"));
    sourceTable = await sourceDb.createTable("memories", rows);
  });

  afterEach(async () => {
    await sourceTable?.close?.();
    await sourceDb?.close?.();
    rmSync(root, { recursive: true, force: true });
  });

  it("copies every non-vector field exactly and never mutates the source", async () => {
    const sourceVersionBefore = await sourceTable.version();
    const backend = createLanceGenerationBackend({
      stateRoot,
      activeRoot,
      activeGeneration: "generation-active",
      activeFingerprint: { dimensions: 3, fingerprintId: "embedding:v1:sha256:source" },
    });
    try {
      const inventory = await backend.inventoryActiveGeneration();
      assert.equal(inventory.length, 1);
      assert.equal(inventory[0].tables[0].rowCount, 2);
      assert.equal(inventory[0].tables[0].dimensions, 3);

      await backend.createQuarantinedGeneration({
        generation: "generation-target",
        fingerprintId: "embedding:v1:sha256:target",
        dimensions: 4,
        tables: inventory[0].tables,
      });
      const sourceRows = await backend.readSourceBatch("agent-a/memories", { offset: 0, limit: 10 });
      const migrated = sourceRows.map((row, index) => ({
        ...row,
        vector: [index, index + 0.1, index + 0.2, index + 0.3],
      }));
      await backend.writeTargetBatch("generation-target", "agent-a/memories", migrated);
      const readBack = await backend.readBackTargetRows(
        "generation-target",
        "agent-a/memories",
        rows.map((row) => row.id),
      );

      assert.deepStrictEqual(
        readBack.map(stableNonVectorRowHash),
        sourceRows.map(stableNonVectorRowHash),
      );
      assert.equal(await sourceTable.version(), sourceVersionBefore);
      assert.deepStrictEqual((await sourceTable.query().toArray()).map((row) => row.text).sort(), rows.map((row) => row.text).sort());
      const validation = await backend.validateGeneration("generation-target");
      assert.deepStrictEqual(validation, { tables: 1, rows: 2, dimensions: 4 });
    } finally {
      await backend.close();
    }
  });

  it("refuses existing generations, unsafe ids, duplicate rows, and invalid vectors", async () => {
    const backend = createLanceGenerationBackend({
      stateRoot,
      activeRoot,
      activeGeneration: "generation-active",
      activeFingerprint: { dimensions: 3, fingerprintId: "embedding:v1:sha256:source" },
    });
    try {
      const tables = (await backend.inventoryActiveGeneration())[0].tables;
      await backend.createQuarantinedGeneration({
        generation: "generation-target",
        fingerprintId: "embedding:v1:sha256:target",
        dimensions: 4,
        tables,
      });
      await assert.rejects(
        backend.createQuarantinedGeneration({ generation: "generation-target", dimensions: 4, tables }),
        /already exists/,
      );
      await assert.rejects(
        backend.createQuarantinedGeneration({ generation: "../escape", dimensions: 4, tables }),
        /generation id/,
      );
      await assert.rejects(
        backend.writeTargetBatch("generation-target", "agent-a/memories", [
          { ...rows[0], vector: [0, 1, 2, 3] },
          { ...rows[0], vector: [0, 1, 2, 3] },
        ]),
        /duplicate target row id/,
      );
      await assert.rejects(
        backend.writeTargetBatch("generation-target", "agent-a/memories", [
          { ...rows[0], vector: [0, 1, Number.NaN, 3] },
        ]),
        /finite target vector/,
      );
    } finally {
      await backend.close();
    }
  });
});
