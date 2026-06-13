import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OverlayGenerator } from "../lib/overlay-generator.js";
import { InterpretationOverlayStore } from "../lib/interpretation-overlay.js";
import { ContradictionDetector } from "../lib/contradiction-detector.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("OverlayGenerator auto-contradiction handling", () => {
  it("supersedes an existing meaning overlay when the new one contradicts it", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-ogen-contra-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      await store.append({
        targetMemoryId: "m1",
        shiftType: "meaning",
        shiftDescription: "We use Postgres.",
        triggerContext: "We use Postgres.",
      });

      const generator = new OverlayGenerator({
        enabled: true,
        llm: async () => JSON.stringify({
          shiftType: "meaning",
          shiftDescription: "We switched to MySQL.",
          confidence: 0.9,
        }),
        contradictionLlm: async () => "yes",
        autoResolveContradictions: true,
        overlayStore: store,
        workspaceDir: tmpDir,
      });

      const overlay = await generator.generate({
        memory: { id: "m1", text: "We decided to use Postgres." },
        conversationContext: "Since then, we switched to MySQL.",
        relevanceScore: 0.9,
      });

      assert.ok(overlay);
      assert.match(overlay.supersedes, UUID_RE);
      assert.strictEqual(overlay.status, "active");
      assert.strictEqual(overlay.autoContradiction.overlayA, overlay.id);
      assert.strictEqual(overlay.autoContradiction.overlayB, overlay.supersedes);

      await store.append(overlay);
      const active = await store.loadForTargets(["m1"]);
      assert.strictEqual(active.length, 1);
      assert.strictEqual(active[0].id, overlay.id);
      assert.strictEqual(active[0].shiftDescription, "We switched to MySQL.");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("supersedes the most recent of multiple contradictory overlays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-gen-contra-multi-"));
    try {
      const store = new InterpretationOverlayStore(dir);
      const oldOverlay = {
        id: "11111111-1111-1111-1111-111111111111",
        targetMemoryId: "m1",
        shiftType: "meaning",
        shiftDescription: "Old.",
        triggerContext: "a",
        createdAt: "2026-01-01T00:00:00.000Z",
        dedupeKey: "old",
      };
      const recentOverlay = {
        id: "22222222-2222-2222-2222-222222222222",
        targetMemoryId: "m1",
        shiftType: "meaning",
        shiftDescription: "Recent.",
        triggerContext: "b",
        createdAt: "2026-06-01T00:00:00.000Z",
        dedupeKey: "recent",
      };
      await store.append(oldOverlay);
      await store.append(recentOverlay);

      let callCount = 0;
      const generator = new OverlayGenerator({
        llm: async () => JSON.stringify({ shiftType: "meaning", shiftDescription: "New.", confidence: 0.9, confidenceDelta: 0 }),
        enabled: true,
        overlayStore: store,
        contradictionLlm: async () => "yes",
        autoResolveContradictions: true,
      });

      const overlay = await generator.generate({
        memory: { id: "m1", text: "memory" },
        conversationContext: "Since then, everything changed.",
        relevanceScore: 0.9,
      });

      assert.ok(overlay);
      assert.strictEqual(overlay.supersedes, recentOverlay.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not supersede when there is no contradiction", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-ogen-contra-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      await store.append({
        targetMemoryId: "m1",
        shiftType: "meaning",
        shiftDescription: "We use Postgres.",
        triggerContext: "We use Postgres.",
      });

      const generator = new OverlayGenerator({
        enabled: true,
        llm: async () => JSON.stringify({
          shiftType: "meaning",
          shiftDescription: "We upgraded to Postgres 16.",
          confidence: 0.9,
        }),
        contradictionLlm: async () => "no",
        autoResolveContradictions: true,
        overlayStore: store,
        workspaceDir: tmpDir,
      });

      const overlay = await generator.generate({
        memory: { id: "m1", text: "We decided to use Postgres." },
        conversationContext: "Since then, we upgraded Postgres.",
        relevanceScore: 0.9,
      });

      assert.ok(overlay);
      assert.strictEqual(overlay.supersedes, undefined);
      assert.strictEqual(overlay.autoContradiction, undefined);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips contradiction checks for non-meaning shift types", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-ogen-contra-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      await store.append({
        targetMemoryId: "m1",
        shiftType: "meaning",
        shiftDescription: "We use Postgres.",
        triggerContext: "We use Postgres.",
      });

      let contradictionCalled = false;
      const generator = new OverlayGenerator({
        enabled: true,
        llm: async () => JSON.stringify({
          shiftType: "confidence",
          shiftDescription: "I am less certain now.",
          confidence: 0.9,
          confidenceDelta: -0.5,
        }),
        contradictionLlm: async () => {
          contradictionCalled = true;
          return "yes";
        },
        autoResolveContradictions: true,
        overlayStore: store,
        workspaceDir: tmpDir,
      });

      const overlay = await generator.generate({
        memory: { id: "m1", text: "We decided to use Postgres." },
        conversationContext: "Now I am less certain.",
        relevanceScore: 0.9,
      });

      assert.ok(overlay);
      assert.strictEqual(overlay.shiftType, "confidence");
      assert.strictEqual(contradictionCalled, false);
      assert.strictEqual(overlay.supersedes, undefined);
      assert.strictEqual(overlay.autoContradiction, undefined);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes a contradiction audit record only after the overlay is appended", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-ogen-contra-"));
    const store = new InterpretationOverlayStore(tmpDir);

    try {
      await store.append({
        targetMemoryId: "m1",
        shiftType: "meaning",
        shiftDescription: "We use Postgres.",
        triggerContext: "We use Postgres.",
      });

      const generator = new OverlayGenerator({
        enabled: true,
        llm: async () => JSON.stringify({
          shiftType: "meaning",
          shiftDescription: "We switched to MySQL.",
          confidence: 0.9,
        }),
        contradictionLlm: async () => "yes",
        autoResolveContradictions: true,
        overlayStore: store,
        workspaceDir: tmpDir,
      });

      const overlay = await generator.generate({
        memory: { id: "m1", text: "We decided to use Postgres." },
        conversationContext: "Since then, we switched to MySQL.",
        relevanceScore: 0.9,
      });

      assert.ok(overlay);
      assert.ok(overlay.autoContradiction);
      assert.strictEqual(overlay.autoContradiction.overlayA, overlay.id);
      assert.strictEqual(overlay.autoContradiction.overlayB, overlay.supersedes);

      await store.append(overlay);

      const detector = new ContradictionDetector({ workspaceDir: tmpDir });
      await detector.persistContradiction(overlay.autoContradiction);

      const content = readFileSync(join(tmpDir, "contradictions.jsonl"), "utf8");
      const record = JSON.parse(content.split("\n").filter(Boolean)[0]);
      assert.strictEqual(record.recordType, "contradiction");
      assert.strictEqual(record.overlayA, overlay.id);
      assert.strictEqual(record.overlayB, overlay.supersedes);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
