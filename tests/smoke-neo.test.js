import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NEO_JSONL_FILES,
  NEO_JSON_FILES,
  isInjectedContextText,
  sanitizePathPart,
  normalizeNeoScope,
  normalizeNeoStatus,
  escapeMemoryText,
  createNeoStore,
} from "../lib/neo-arch.js";

const TEST_DIR = mkdtempSync(join(tmpdir(), "plur1bus-neo-smoke-"));
mkdirSync(TEST_DIR, { recursive: true });

describe("neo-arch constants & helpers", () => {
  it("has defined JSONL files", () => {
    assert.ok(Array.isArray(NEO_JSONL_FILES), "NEO_JSONL_FILES should be an array");
    assert.ok(NEO_JSONL_FILES.length > 0, "should have at least one JSONL file");
  });

  it("has defined JSON files", () => {
    assert.ok(Array.isArray(NEO_JSON_FILES), "NEO_JSON_FILES should be an array");
    assert.ok(NEO_JSON_FILES.length > 0, "should have at least one JSON file");
  });

  it("detects injected context text", () => {
    assert.strictEqual(isInjectedContextText("<plur1bus-recall>foo</plur1bus-recall>"), true);
    assert.strictEqual(isInjectedContextText("RECALL SAFETY RULES"), true);
    assert.strictEqual(isInjectedContextText("regular user text"), false);
  });

  it("sanitizes path parts", () => {
    assert.strictEqual(sanitizePathPart("foo/bar"), "foo_bar");
    assert.strictEqual(sanitizePathPart(".."), "..");
    assert.strictEqual(sanitizePathPart(""), "default");
  });

  it("normalizes scope and status", () => {
    assert.strictEqual(normalizeNeoScope("agent_private"), "agent_private");
    assert.strictEqual(normalizeNeoScope("invalid", "workspace_shared"), "workspace_shared");
    assert.strictEqual(normalizeNeoStatus("active"), "active");
    assert.strictEqual(normalizeNeoStatus("invalid", "candidate"), "candidate");
  });

  it("escapes memory text", () => {
    const text = 'text with <html> & "quotes"';
    const escaped = escapeMemoryText(text);
    assert.ok(escaped.includes("&amp;"), "& should be escaped to &amp;");
    assert.ok(escaped.includes("&lt;"), "< should be escaped to &lt;");
    assert.ok(escaped.includes("&gt;"), "> should be escaped to &gt;");
  });
});

describe("neo-arch file I/O", () => {
  it("reads and writes JSONL events", () => {
    const filePath = join(TEST_DIR, "test-events.jsonl");
    const events = [
      { id: "evt-1", type: "retrieval", timestamp: Date.now() },
      { id: "evt-2", type: "store", timestamp: Date.now() },
    ];
    const lines = events.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(filePath, lines + "\n");

    const raw = readFileSync(filePath, "utf-8");
    const readEvents = raw.trim().split("\n").map((line) => JSON.parse(line));
    assert.strictEqual(readEvents.length, 2, "should read 2 events");
    assert.strictEqual(readEvents[0].id, "evt-1", "first event id should match");
  });

  it("reads and writes run state JSON", () => {
    const filePath = join(TEST_DIR, "run-state.json");
    const state = { lastRunAt: Date.now(), counters: { foo: 1 } };
    writeFileSync(filePath, JSON.stringify(state, null, 2));
    const read = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.strictEqual(read.counters.foo, 1, "counter should persist");
  });

  it("drains pending low-impact embedding queue entries", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-neo-drain-"));
    const store = createNeoStore(root, "workspace-test");
    const candidate = {
      id: "mem-low-001",
      workspaceKey: "workspace-test",
      agentId: "bernhardine",
      statement: "Low impact recipe note.",
      sourceTurnIds: ["turn-1"],
      status: "candidate",
      embeddingStatus: "pending",
      impact: "low",
    };
    store.appendCandidates([candidate]);
    store.appendEmbeddingQueue([candidate]);

    assert.equal(typeof store.drainEmbeddingQueue, "function");
    const result = store.drainEmbeddingQueue({ impact: "low", maxItems: 10 });

    assert.equal(result.processed, 1);
    assert.equal(result.pending, 0);
    assert.equal(store.readCandidates(10).at(-1).embeddingStatus, "fresh");
    assert.ok(
      readFileSync(store.paths.embeddings, "utf8").includes('"status":"done"'),
      "queue entry should be rewritten as done",
    );
  });
});

// temp dir left for OS cleanup
