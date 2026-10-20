import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { connect } from "@lancedb/lancedb";

import {
  createLanceGenerationBackend,
  stableNonVectorRowHash,
} from "../lib/reembedding/lance-backend.js";
import { makeTempDir } from "./helpers/temp-dir.js";

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
    root = makeTempDir("plur1bus-reembedding-lance-");
    activeRoot = join(root, "active");
    stateRoot = join(root, "state");
    sourceDb = await connect(join(activeRoot, "agent-a"));
    sourceTable = await sourceDb.createTable("memories", rows);
  });

  it("honors the inventory AbortSignal on the real Lance backend without creating a target generation", async () => {
    const backend = createLanceGenerationBackend({
      stateRoot,
      activeRoot,
      activeGeneration: "generation-active",
      activeFingerprint: { dimensions: 3, fingerprintId: "embedding:v1:sha256:source" },
    });
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled inventory"));
    try {
      await assert.rejects(
        backend.inventoryActiveGeneration({ signal: controller.signal }),
        (error) => error?.name === "AbortError",
      );
    } finally {
      await backend.close();
    }
  });

  it("honors an abort that arrives after a live Lance schema read", async () => {
    const controller = new AbortController();
    const backend = createLanceGenerationBackend({
      stateRoot,
      activeRoot,
      activeGeneration: "generation-active",
      activeFingerprint: { dimensions: 3, fingerprintId: "embedding:v1:sha256:source" },
      connect: async (path) => {
        const db = await connect(path);
        return new Proxy(db, {
          get(target, property, receiver) {
            if (property === "openTable") {
              return async (name) => {
                const table = await target.openTable(name);
                return new Proxy(table, {
                  get(tableTarget, tableProperty, tableReceiver) {
                    if (tableProperty === "schema") {
                      return async () => {
                        const schema = await tableTarget.schema();
                        controller.abort(new Error("operator cancelled after schema"));
                        return schema;
                      };
                    }
                    const value = Reflect.get(tableTarget, tableProperty, tableReceiver);
                    return typeof value === "function" ? value.bind(tableTarget) : value;
                  },
                });
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
    try {
      await assert.rejects(
        backend.inventoryActiveGeneration({ signal: controller.signal }),
        (error) => error?.name === "AbortError",
      );
    } finally {
      await backend.close();
    }
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
      const recalled = await backend.searchTarget(
        "generation-target",
        "agent-a/memories",
        migrated[0].vector,
        { limit: 2 },
      );
      assert.equal(recalled[0].id, migrated[0].id);
      assert.equal(await sourceTable.version(), sourceVersionBefore);
      assert.deepStrictEqual((await sourceTable.query().toArray()).map((row) => row.text).sort(), rows.map((row) => row.text).sort());
      const validation = await backend.validateGeneration("generation-target");
      assert.deepStrictEqual(validation, { tables: 1, rows: 2, dimensions: 4 });
    } finally {
      await backend.close();
    }
  });

  it("refreshes a cached source table before inventorying or reading external writes", async () => {
    const backend = createLanceGenerationBackend({
      stateRoot,
      activeRoot,
      activeGeneration: "generation-active",
      activeFingerprint: { dimensions: 3, fingerprintId: "embedding:v1:sha256:source" },
    });
    const externallyWritten = {
      ...rows[0],
      id: "33333333-3333-4333-8333-333333333333",
      text: "memory written through the active runtime",
    };
    try {
      const initial = await backend.inventoryActiveGeneration();
      assert.equal(initial[0].tables[0].rowCount, 2);

      await sourceTable.add([externallyWritten]);

      const refreshed = await backend.inventoryActiveGeneration();
      assert.equal(refreshed[0].tables[0].rowCount, 3);
      const sourceRows = await backend.readSourceBatch("agent-a/memories", { offset: 0, limit: 10 });
      assert.deepEqual(
        sourceRows.map((row) => row.id).sort(),
        [...rows.map((row) => row.id), externallyWritten.id].sort(),
      );
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

  describe("retrying an interrupted generation creation", () => {
    const fingerprintId = `embedding:v1:sha256:${"b".repeat(64)}`;
    const identity = {
      provider: "openai",
      model: "target-model",
      revision: "rev-1",
      dimension: 4,
      normalization: "l2",
      prefixScheme: "none",
      instruction: "",
      dtype: "fp32",
    };
    const newBackend = (extra = {}) => createLanceGenerationBackend({
      stateRoot,
      activeRoot,
      activeGeneration: "generation-active",
      activeFingerprint: { dimensions: 3, fingerprintId: "embedding:v1:sha256:source" },
      ...extra,
    });
    const create = (backend, tables) => backend.createQuarantinedGeneration({
      generation: "generation-target",
      fingerprintId,
      dimensions: 4,
      identity,
      tables,
    });

    it("completes a generation directory that crashed before any table or manifest existed", async () => {
      mkdirSync(join(stateRoot, "generations", "generation-target"), { recursive: true });
      const backend = newBackend();
      try {
        const tables = (await backend.inventoryActiveGeneration())[0].tables;
        const manifest = await create(backend, tables);
        assert.equal(manifest.generation, "generation-target");
        assert.deepStrictEqual((await backend.describeGeneration("generation-target")).tables["agent-a/memories"].sourceRows, 2);
        await assert.rejects(create(backend, tables), /already exists/);
      } finally {
        await backend.close();
      }
    });

    it("completes a generation whose table was created but whose manifest was never written", async () => {
      let failIdentityOnce = true;
      const flaky = newBackend({
        connect: async (path) => {
          const db = await connect(path);
          return new Proxy(db, {
            get(target, property, receiver) {
              if (property === "createTable") {
                return async (name, ...args) => {
                  if (name === "_embedding_identity" && failIdentityOnce) {
                    failIdentityOnce = false;
                    throw new Error("simulated crash while creating the identity table");
                  }
                  return target.createTable(name, ...args);
                };
              }
              const value = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      });
      let tables;
      try {
        tables = (await flaky.inventoryActiveGeneration())[0].tables;
        await assert.rejects(create(flaky, tables), /simulated crash/);
      } finally {
        await flaky.close();
      }
      assert.equal(existsSync(join(stateRoot, "generations", "generation-target", "generation.json")), false);

      const backend = newBackend();
      try {
        await create(backend, tables);
        const migrated = (await backend.readSourceBatch("agent-a/memories", { offset: 0, limit: 10 }))
          .map((row, index) => ({ ...row, vector: [index, 1, 2, 3] }));
        await backend.writeTargetBatch("generation-target", "agent-a/memories", migrated);
        assert.deepStrictEqual(await backend.validateGeneration("generation-target"), { tables: 1, rows: 2, dimensions: 4 });
      } finally {
        await backend.close();
      }
    });

    it("refuses to adopt a manifest-less directory that already holds target rows", async () => {
      const first = newBackend();
      let tables;
      try {
        tables = (await first.inventoryActiveGeneration())[0].tables;
        await create(first, tables);
        const migrated = (await first.readSourceBatch("agent-a/memories", { offset: 0, limit: 10 }))
          .map((row, index) => ({ ...row, vector: [index, 1, 2, 3] }));
        await first.writeTargetBatch("generation-target", "agent-a/memories", migrated);
      } finally {
        await first.close();
      }
      rmSync(join(stateRoot, "generations", "generation-target", "generation.json"));
      const backend = newBackend();
      try {
        await assert.rejects(create(backend, tables), /not empty|already exists/);
      } finally {
        await backend.close();
      }
    });

    it("refuses a generation path that is a symlink", async () => {
      const elsewhere = join(root, "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      const backend = newBackend();
      symlinkSync(elsewhere, join(stateRoot, "generations", "generation-target"));
      try {
        const tables = (await backend.inventoryActiveGeneration())[0].tables;
        await assert.rejects(create(backend, tables), /Path traversal blocked|already exists|unsafe/);
      } finally {
        await backend.close();
      }
    });
  });

  it("preserves the configured writer namespace inside a target generation", async () => {
    const backend = createLanceGenerationBackend({
      stateRoot,
      activeRoot,
      activeNamespace: "lab",
      activeGeneration: "legacy-active",
      activeFingerprint: { dimensions: 3, fingerprintId: "embedding:v1:sha256:source" },
    });
    try {
      const tables = (await backend.inventoryActiveGeneration())[0].tables;
      await backend.createQuarantinedGeneration({
        generation: "generation-named",
        fingerprintId: "embedding:v1:sha256:target",
        dimensions: 4,
        tables,
      });
      const sourceRows = await backend.readSourceBatch("agent-a/memories", { offset: 0, limit: 10 });
      await backend.writeTargetBatch("generation-named", "agent-a/memories", sourceRows.map((row) => ({
        ...row,
        vector: [1, 2, 3, 4],
      })));
      const namedDb = await connect(join(stateRoot, "generations", "generation-named", "lab", "agent-a"));
      const namedTable = await namedDb.openTable("memories");
      assert.equal(await namedTable.countRows(), sourceRows.length);
      await namedTable.close();
      await namedDb.close();
    } finally {
      await backend.close();
    }
  });

  it("migrates private and shared pools while excluding control-plane directories", async () => {
    const colocatedRoot = join(root, "colocated");
    const privateDb = await connect(join(colocatedRoot, "agent-a"));
    const privateTable = await privateDb.createTable("memories", rows);
    const workspaceKey = `w-${"a".repeat(62)}`;
    const userKey = `u-${"b".repeat(62)}`;
    const workspaceDb = await connect(join(colocatedRoot, ".plur1bus-shared", "workspaces", workspaceKey));
    const workspaceTable = await workspaceDb.createTable("memories", [{ ...rows[0], id: "33333333-3333-4333-8333-333333333333" }]);
    const userDb = await connect(join(colocatedRoot, ".plur1bus-shared", "users", userKey));
    const userTable = await userDb.createTable("memories", [{ ...rows[1], id: "44444444-4444-4444-8444-444444444444" }]);
    mkdirSync(join(colocatedRoot, "control"), { recursive: true });
    mkdirSync(join(colocatedRoot, "generations"), { recursive: true });
    const backend = createLanceGenerationBackend({
      stateRoot: colocatedRoot,
      activeRoot: colocatedRoot,
      activeSharedBaseDir: colocatedRoot,
      activeGeneration: "legacy-active",
      activeSelection: { mode: "legacy" },
      activeFingerprint: { dimensions: 3, fingerprintId: "embedding:v1:sha256:source" },
    });
    try {
      const inventory = await backend.inventoryActiveGeneration();
      assert.deepEqual(inventory[0].tables.map(({ tableId }) => tableId), [
        `agent-a/memories`,
        `shared/users/${userKey}/memories`,
        `shared/workspaces/${workspaceKey}/memories`,
      ]);
      await backend.createQuarantinedGeneration({
        generation: "generation-all",
        fingerprintId: "embedding:v1:sha256:target",
        dimensions: 4,
        tables: inventory[0].tables,
      });
      for (const descriptor of inventory[0].tables) {
        const sourceRows = await backend.readSourceBatch(descriptor.tableId, { limit: 10 });
        await backend.writeTargetBatch("generation-all", descriptor.tableId, sourceRows.map((row) => ({
          ...row,
          vector: [1, 2, 3, 4],
        })));
      }
      assert.deepEqual(await backend.validateGeneration("generation-all"), { tables: 3, rows: 4, dimensions: 4 });
      const migratedWorkspace = await connect(join(
        colocatedRoot, "generations", "generation-all", ".plur1bus-shared", "workspaces", workspaceKey,
      ));
      const migratedUser = await connect(join(
        colocatedRoot, "generations", "generation-all", ".plur1bus-shared", "users", userKey,
      ));
      assert.equal(await (await migratedWorkspace.openTable("memories")).countRows(), 1);
      assert.equal(await (await migratedUser.openTable("memories")).countRows(), 1);
      await migratedWorkspace.close();
      await migratedUser.close();
    } finally {
      await backend.close();
      await privateTable.close();
      await privateDb.close();
      await workspaceTable.close();
      await workspaceDb.close();
      await userTable.close();
      await userDb.close();
    }
  });
});
