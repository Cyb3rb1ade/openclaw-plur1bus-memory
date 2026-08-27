import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createGenerationRuntimeProbe } from "../lib/reembedding/runtime-probe.js";

const fingerprint = Object.freeze({ provider: "openai", model: "target", dimensions: 3 });

describe("generation runtime probe", () => {
  it("stores, recalls, audits, and removes one synthetic memory through the target runtime", async () => {
    const events = [];
    const rows = new Map();
    const probe = createGenerationRuntimeProbe({
      readActiveSelection: () => ({ generation: "generation-target" }),
      embedTarget: async ({ text, purpose }) => {
        events.push(`embed:${purpose}:${text.includes("probe")}`);
        return [1, 0, 0];
      },
      withTargetDb: async ({ generation, agentId, dimensions }, operation) => {
        assert.equal(generation, "generation-target");
        assert.equal(agentId, "plur1bus-reembedding-probe");
        assert.equal(dimensions, 3);
        return operation({
          store: async (row) => { events.push("store"); rows.set(row.id, row); },
          search: async () => { events.push("search"); return [...rows.values()].map((entry) => ({ entry, score: 1 })); },
          delete: async (id) => { events.push("delete"); rows.delete(id); },
        });
      },
      appendAudit: (entry) => { events.push(`audit:${entry.event}`); return true; },
      createId: () => "86db0fe4-922c-4ea2-9259-ea35ef10537d",
      now: () => 1234,
    });

    assert.deepStrictEqual(await probe({
      expectedGeneration: "generation-target",
      fingerprint,
    }), { readiness: true, store: true, recall: true });
    assert.deepStrictEqual(events, [
      "embed:passage:true",
      "store",
      "embed:query:true",
      "search",
      "audit:reembedding.synthetic_probe_delete",
      "delete",
    ]);
    assert.equal(rows.size, 0);
  });

  it("fails closed on selection drift and still removes a stored row after recall failure", async () => {
    let storedId = null;
    let deletedId = null;
    const probe = createGenerationRuntimeProbe({
      readActiveSelection: () => ({ generation: "generation-target" }),
      embedTarget: async () => [1, 0, 0],
      withTargetDb: async (_target, operation) => operation({
        store: async (row) => { storedId = row.id; },
        search: async () => [],
        delete: async (id) => { deletedId = id; },
      }),
      appendAudit: () => true,
      createId: () => "86db0fe4-922c-4ea2-9259-ea35ef10537d",
    });

    await assert.rejects(
      probe({ expectedGeneration: "wrong", fingerprint }),
      /active generation selection drift/,
    );
    await assert.rejects(
      probe({ expectedGeneration: "generation-target", fingerprint }),
      /did not recall/,
    );
    assert.equal(deletedId, storedId);
  });

  it("does not perform an unaudited destructive cleanup", async () => {
    let deleted = false;
    const probe = createGenerationRuntimeProbe({
      readActiveSelection: () => ({ generation: "generation-target" }),
      embedTarget: async () => [1, 0, 0],
      withTargetDb: async (_target, operation) => operation({
        store: async () => {},
        search: async () => [{ entry: { id: "86db0fe4-922c-4ea2-9259-ea35ef10537d" }, score: 1 }],
        delete: async () => { deleted = true; },
      }),
      appendAudit: () => false,
      createId: () => "86db0fe4-922c-4ea2-9259-ea35ef10537d",
    });

    await assert.rejects(
      probe({ expectedGeneration: "generation-target", fingerprint }),
      /audit write failed/,
    );
    assert.equal(deleted, false);
  });
});
