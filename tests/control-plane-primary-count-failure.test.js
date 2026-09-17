import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createControlPlaneHealthInspector, createControlPlaneHealthScan } from "../lib/control-plane-health.js";
import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";
import { CONTROL_UI_PATH, createControlUiHttpHandler } from "../lib/setup/control-ui-plugin-runtime.js";

const root = { id: "default", path: "/not-read/private", dimensions: 768 };
const options = (overrides = {}) => ({
  namespaceRoots: [root],
  listPartitions: async () => ["main"],
  inspectRows: async () => 7,
  primaryAgentIds: () => ["main", "absent"],
  measureStorage: async () => ({ bytes: 0, complete: true }),
  ...overrides,
});
const scan = (overrides) => createControlPlaneHealthScan(options(overrides))();

describe("primary-agent counts distinguish unavailable from measured zero (#155)", () => {
  it("keeps a failed count unknown but a successfully enumerated absence zero", async () => {
    const result = await scan({ inspectRows: async () => { throw new Error("secret-backend-error"); } });
    assert.equal(result.status, "degraded");
    assert.deepEqual(result.cards.byPrimaryAgent, [{ id: "absent", cards: 0 }, { id: "main", cards: null }]);
    assert.equal(result.lastError.code, "partition_count_failed");
    assert.doesNotMatch(JSON.stringify(result), /secret-backend-error|not-read/);
  });

  it("marks all roster counts unknown if a private namespace cannot be enumerated", async () => {
    const result = await scan({ listPartitions: async () => { throw new Error("offline"); } });
    assert.deepEqual(result.cards.byPrimaryAgent, [{ id: "absent", cards: null }, { id: "main", cards: null }]);
    assert.equal(result.lastError.code, "partition_list_failed");
  });

  it("does not turn capped partitions into zero and preserves known siblings", async () => {
    let reads = 0;
    const result = await scan({
      listPartitions: async () => ["main", "second", "third"],
      primaryAgentIds: () => ["main", "second", "third", "absent"],
      inspectRows: async () => { reads += 1; return 7; },
      maxPartitions: 1,
    });
    assert.equal(reads, 1);
    assert.deepEqual(result.cards.byPrimaryAgent, [
      { id: "absent", cards: 0 }, { id: "main", cards: 7 },
      { id: "second", cards: null }, { id: "third", cards: null },
    ]);
    assert.equal(result.lastError.code, "partition_limit_reached");
  });

  for (const failedFirst of [false, true]) {
    it(`never presents a partial namespace sum as a complete count (failedFirst=${failedFirst})`, async () => {
      const roots = [root, { ...root, id: "legacy", path: "/not-read/legacy" }];
      if (failedFirst) roots.reverse();
      const result = await scan({
        namespaceRoots: roots,
        inspectRows: async ({ namespaceId }) => {
          if (namespaceId === "legacy") throw new Error("offline");
          return 7;
        },
      });
      assert.deepEqual(result.cards.byPrimaryAgent, [{ id: "absent", cards: 0 }, { id: "main", cards: null }]);
    });
  }

  it("does not infer absence when any namespace listing fails or no roots exist", async () => {
    const result = await scan({
      namespaceRoots: [root, { ...root, id: "legacy", path: "/not-read/legacy" }],
      listPartitions: async ({ basePath }) => {
        if (basePath.endsWith("legacy")) throw new Error("offline");
        return ["main"];
      },
    });
    const unknown = [{ id: "absent", cards: null }, { id: "main", cards: null }];
    assert.deepEqual(result.cards.byPrimaryAgent, unknown);
    assert.deepEqual((await scan({ namespaceRoots: [] })).cards.byPrimaryAgent, unknown);
  });

  it("preserves complete zero and sum results despite unrelated shared-pool failure", async () => {
    const result = await scan({
      namespaceRoots: [root, { ...root, id: "legacy" }],
      sharedRoots: { workspace: root },
      listPartitions: async ({ kind }) => {
        if (kind === "workspace") throw new Error("offline shared pool");
        return ["main"];
      },
    });
    assert.deepEqual(result.cards.byPrimaryAgent, [{ id: "absent", cards: 0 }, { id: "main", cards: 14 }]);
  });

  it("preserves null through both projections and renders unavailable, not zero or no agent", async () => {
    const inspector = createControlPlaneHealthInspector({
      scan: createControlPlaneHealthScan(options({ inspectRows: async () => { throw new Error("sentinel-private-error-155"); } })),
    });
    const health = await inspector.snapshot();
    assert.equal(health.cards.byPrimaryAgent.find((entry) => entry.id === "main")?.cards, null);
    const projection = buildControlPlaneProjection({ health });
    assert.deepEqual(projection.memoryHealth.cards.byPrimaryAgent, health.cards.byPrimaryAgent);
    const response = { setHeader() {}, end(body) { this.body = body; } };
    await createControlUiHttpHandler({ getProjection: async () => projection })({ method: "GET", url: CONTROL_UI_PATH }, response);
    const primarySection = response.body.split("<h3>Cards by primary agent</h3>")[1].split("</article>")[0];
    assert.match(primarySection, /<code>main<\/code><strong>Unavailable<\/strong>/);
    assert.match(primarySection, /<code>absent<\/code><strong>0<\/strong>/);
    assert.doesNotMatch(primarySection, /No channel-bound agent|<code>main<\/code><strong>0/);
    assert.doesNotMatch(response.body, /sentinel-private-error-155|not-read/);
  });

  it("still rejects invalid numeric counts and null in groups that do not allow it", async () => {
    const health = await scan();
    for (const value of [-1, "0", undefined, NaN]) {
      const invalid = { ...health, cards: { ...health.cards, byPrimaryAgent: [{ id: "main", cards: value }] } };
      assert.equal(buildControlPlaneProjection({ health: invalid }).memoryHealth.status, "unavailable");
    }
    const invalid = { ...health, cards: { ...health.cards, byAgent: [{ id: "main", cards: null }] } };
    assert.equal(buildControlPlaneProjection({ health: invalid }).memoryHealth.status, "unavailable");
  });
});
