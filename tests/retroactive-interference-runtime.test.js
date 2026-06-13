import { describe, it } from "node:test";
import assert from "node:assert";

describe("retroactive interference runtime module", () => {
  it("exports the expected apply function", async () => {
    const mod = await import("../lib/retroactive-interference.js");

    assert.strictEqual(typeof mod.applyRetroactiveInterference, "function");
  });

  it("keeps default missing-entry path as a safe no-op", async () => {
    const { applyRetroactiveInterference } = await import("../lib/retroactive-interference.js");
    let searched = false;
    const db = {
      async search() {
        searched = true;
        return [];
      },
    };

    const result = await applyRetroactiveInterference(db, null);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.affected, 0);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(searched, false);
  });

  it("does nothing when feature flag is off", async () => {
    const { applyRetroactiveInterference } = await import("../lib/retroactive-interference.js");
    let searched = false;
    const db = {
      async search() {
        searched = true;
        return [];
      },
    };

    const result = await applyRetroactiveInterference(db, { id: "new", vector: [0.1, 0.2] }, { enabled: false });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.affected, 0);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "disabled");
    assert.strictEqual(searched, false);
  });

  it("returns an error result instead of throwing when the interference path fails", async () => {
    const { applyRetroactiveInterference } = await import("../lib/retroactive-interference.js");
    const db = {
      async search() {
        throw new Error("search failed");
      },
      async update() {},
    };

    const result = await applyRetroactiveInterference(db, { id: "new", vector: [0.1, 0.2] });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.affected, 0);
    assert.match(result.error, /search failed/);
  });

  it("updates non-core similar memories and skips the new entry", async () => {
    const { applyRetroactiveInterference } = await import("../lib/retroactive-interference.js");
    const updates = [];
    const db = {
      async search() {
        return [
          { entry: { id: "new", vector: [0.1], memoryStrength: 0.8 } },
          { entry: { id: "old", vector: [0.2], memoryStrength: 0.8, createdAt: Date.now() } },
          { entry: { id: "core", vector: [0.3], memoryClass: "core", memoryStrength: 1 } },
        ];
      },
      async update(id, patch) {
        updates.push({ id, patch });
      },
    };

    const result = await applyRetroactiveInterference(db, { id: "new", vector: [0.1] }, { multiplier: 0.5, maxAffected: 5 });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.affected, 1);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].id, "old");
    assert.ok(updates[0].patch.memoryStrength < 0.8);
  });
});

describe("schicht15 tracker runtime exports", () => {
  it("exports computeContentHash required by index.js", async () => {
    const mod = await import("../lib/jobs/schicht15-tracker.js");

    assert.strictEqual(typeof mod.computeContentHash, "function");
    assert.strictEqual(mod.computeContentHash(" hello \n"), mod.computeContentHash("hello"));
    assert.strictEqual(mod.computeContentHash("   "), null);
  });
});

describe("plugin runtime import", () => {
  it("imports index.js without missing retroactive-interference module failure", async () => {
    const mod = await import("../index.js");

    assert.ok(mod);
  });
});
