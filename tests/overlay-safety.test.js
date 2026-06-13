// tests/overlay-safety.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OverlayGenerator } from "../lib/overlay-generator.js";
import { InterpretationOverlayStore } from "../lib/interpretation-overlay.js";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

describe("overlay safety", () => {
  it("default-off: generator does nothing when disabled", async () => {
    let called = false;
    const generator = new OverlayGenerator({
      enabled: false,
      llm: async () => { called = true; return "x"; },
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "x" },
      conversationContext: "x",
      relevanceScore: 0.99,
    });
    assert.strictEqual(result, null);
    assert.strictEqual(called, false);
  });

  it("LLM failure does not break recall", async () => {
    let called = false;
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => { called = true; throw new Error("llm down"); },
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "x" },
      conversationContext: "Since then, everything changed.",
      relevanceScore: 0.99,
    });
    assert.strictEqual(result, null);
    assert.strictEqual(called, true, "LLM must be reached before failure is tolerated");
  });

  it("generated overlays never mutate factual memory (only append JSONL)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-safety-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      const generator = new OverlayGenerator({
        enabled: true,
        llm: async () => JSON.stringify({ shiftType: "meaning", shiftDescription: "shift", confidence: 0.9 }),
        overlayStore: store,
      });
      const overlay = await generator.generate({
        memory: { id: "m1", text: "Original fact." },
        conversationContext: "Since then, the meaning has shifted.",
        relevanceScore: 0.9,
      });
      await store.append(overlay);

      const content = readFileSync(store.filePath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      assert.strictEqual(lines.length, 1);
      const record = JSON.parse(lines[0]);
      assert.strictEqual(record.targetMemoryId, "m1");
      assert.strictEqual(record.status, "provisional");
      assert.ok(!content.includes("Original fact."), "factual text must not be rewritten");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("provisional overlays are not rendered in recall context", async () => {
    const memory = { id: "m1", category: "decision", source: "dm", display: "We chose Postgres.", memoryStrength: 1.0 };
    const overlay = {
      id: "ov1",
      targetMemoryId: "m1",
      shiftType: "meaning",
      shiftDescription: "Postgres is now the default.",
      createdAt: new Date().toISOString(),
      status: "provisional",
      confidence: 0.9,
      provenance: { triggerMemoryIds: ["m1"] },
    };
    const context = formatRelevantMemoriesContext([memory], { overlays: [overlay] });
    assert.ok(!context.includes("<interpretation-overlay"), "provisional overlay must not render");
  });
});
