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
  formatNeoRecallContext,
  createNeoStore,
  captureNeoFromAgentEnd,
  routeNeoRecall,
  transitionRecordStatus,
} from "../lib/neo-arch.js";

const TEST_DIR = mkdtempSync(join(tmpdir(), "plur1bus-neo-smoke-"));
mkdirSync(TEST_DIR, { recursive: true });

function readJsonl(path) {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function latestById(records) {
  const byId = new Map();
  for (const record of records) {
    if (record?.id) byId.set(record.id, record);
  }
  return [...byId.values()];
}

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

  it("renders each neo recall record id at most once across lanes", () => {
    const duplicate = {
      id: "mem_c1831bfc268bcb3ae451",
      category: "project_fact",
      status: "active",
      statement: "Wiki-Ingest Task for Winston NotebookLM architecture technical constraints workspace facts recent turns",
      workspaceKey: "workspace-facts",
      origin: { trustLevel: "tool_observed", scope: "workspace_shared" },
      salience: 0.9,
      recency: 0.9,
    };

    const lanes = routeNeoRecall([duplicate, duplicate], "Winston NotebookLM Wiki-Ingest Task", {
      lanes: ["recent_turns", "workspace_facts", "architecture_decisions", "technical_constraints"],
      maxPerLane: 2,
      minScore: 0.08,
      requesterWorkspaceKey: "workspace-facts",
    });
    const out = formatNeoRecallContext(lanes, { idempotencyKey: "regression" });

    assert.strictEqual((out.match(/mem_c1831bfc268bcb3ae451/g) || []).length, 1);
    assert.match(out, /lane="workspace_facts"/);
  });

  it("dedupes neo recall record ids during formatting", () => {
    const memory = {
      id: "mem_2060048051c578719304",
      category: "release",
      statement: "PLUR1BUS v6.9.7 release announcement",
      origin: { trustLevel: "tool_observed" },
    };
    const lanes = {
      recent_turns: [
        { item: memory, score: 0.91 },
        { item: memory, score: 0.89 },
      ],
      architecture_decisions: [
        { item: { ...memory }, score: 0.88 },
        { item: { ...memory }, score: 0.87 },
      ],
      technical_constraints: [
        { item: { ...memory }, score: 0.86 },
        { item: { ...memory }, score: 0.85 },
      ],
      tooling_constraints: [
        { item: { ...memory }, score: 0.84 },
      ],
    };

    const out = formatNeoRecallContext(lanes, { idempotencyKey: "formatter-regression" });

    assert.strictEqual((out.match(/mem_2060048051c578719304/g) || []).length, 1);
    assert.match(out, /lane="recent_turns"/);
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

  it("drains pending low-impact embedding queue entries", async () => {
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
    store.appendEmbeddingQueue([candidate]);
    assert.equal(readJsonl(store.paths.embeddings).length, 1, "immediate pending replay should be deduped");

    assert.equal(typeof store.drainEmbeddingQueue, "function");
    const result = await store.drainEmbeddingQueue({ impact: "low", maxItems: 10, embedder: () => [0.25, 0.75], dimensions: 2 });

    assert.equal(result.processed, 1);
    assert.equal(result.pending, 0);
    assert.equal(store.readCandidates(10).at(-1).embeddingStatus, "fresh");
    assert.deepStrictEqual(store.readCandidates(10).at(-1).embedding, [0.25, 0.75]);
    assert.ok(
      readFileSync(store.paths.embeddings, "utf8").includes('"status":"done"'),
      "queue entry should be rewritten as done",
    );

    store.appendEmbeddingQueue([candidate]);
    const requeued = readJsonl(store.paths.embeddings);
    assert.equal(requeued.length, 3, "done queue entries should not suppress legitimate requeue");
    assert.equal(requeued.at(-1).status, "pending", "requeue should append a fresh pending entry");
  });

  it("captures identical agent_end events idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-neo-capture-"));
    const workspaceKey = "workspace-capture";
    const store = createNeoStore(root, workspaceKey);
    const event = {
      workspaceKey,
      sessionId: "session-stable-001",
      messages: [
        {
          role: "assistant",
          content: "I will configure the sync job with a hidden cron fallback.",
        },
        {
          role: "user",
          content: "No, never use hidden cron jobs. Keep the setup explicit.",
        },
      ],
    };
    const ctx = { agentId: "bernhardine" };

    const first = captureNeoFromAgentEnd(event, ctx, store);
    const countsAfterFirst = {
      turns: store.readTurns(50).length,
      candidates: store.readCandidates(50).length,
      reactions: readJsonl(store.paths.reactions).length,
      behaviorCards: store.readBehaviorCards(50).length,
      embeddings: readJsonl(store.paths.embeddings).length,
    };
    const second = captureNeoFromAgentEnd(event, ctx, store);

    assert.ok(first.turns.length > 0, "test should capture turns");
    assert.ok(first.candidates.length > 0, "test should capture candidates");
    assert.ok(first.reactions.length > 0, "test should capture reactions");
    assert.ok(first.behaviorCards.length > 0, "test should capture behavior cards");
    assert.deepStrictEqual(second.turns.map((turn) => turn.id), first.turns.map((turn) => turn.id));
    assert.deepStrictEqual(second.candidates.map((candidate) => candidate.id), first.candidates.map((candidate) => candidate.id));
    assert.deepStrictEqual(second.reactions.map((reaction) => reaction.id), first.reactions.map((reaction) => reaction.id));
    assert.deepStrictEqual(second.behaviorCards.map((card) => card.id), first.behaviorCards.map((card) => card.id));
    assert.deepStrictEqual(
      {
        turns: store.readTurns(50).length,
        candidates: store.readCandidates(50).length,
        reactions: readJsonl(store.paths.reactions).length,
        behaviorCards: store.readBehaviorCards(50).length,
        embeddings: readJsonl(store.paths.embeddings).length,
      },
      countsAfterFirst,
    );
  });

  it("does not enqueue duplicate capture records when replayed after drain", async () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-neo-capture-drain-"));
    const workspaceKey = "workspace-capture-drain";
    const store = createNeoStore(root, workspaceKey);
    const event = {
      workspaceKey,
      sessionId: "session-stable-drain-001",
      messages: [
        {
          role: "assistant",
          content: "I will store the current workspace state as a Neo shadow note.",
        },
        {
          role: "user",
          content: "Yes, keep that memory policy active for this workspace.",
        },
      ],
    };
    const ctx = { agentId: "bernhardine" };

    captureNeoFromAgentEnd(event, ctx, store);
    const firstDrain = await store.drainEmbeddingQueue({ impact: "low", maxItems: 50, embedder: () => [1, 0], dimensions: 2 });
    assert.ok(firstDrain.processed > 0, "test should process queue entries");
    const queueAfterDrain = readJsonl(store.paths.embeddings);
    assert.ok(latestById(queueAfterDrain).every((entry) => entry.status === "done"), "all initial latest entries should be done");

    captureNeoFromAgentEnd(event, ctx, store);
    assert.deepStrictEqual(readJsonl(store.paths.embeddings), queueAfterDrain);
  });

  it("dedupes memory candidates by normalized statement across different ids", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-neo-candidate-content-dedupe-"));
    const workspaceKey = "workspace-candidate-content-dedupe";
    const store = createNeoStore(root, workspaceKey);
    const first = {
      id: "mem_2060048051c578719304",
      workspaceKey,
      statement: "PLUR1BUS v6.9.7 release announcement",
      normalizedStatement: "PLUR1BUS v6.9.7 release announcement",
      category: "tooling_constraint",
      sourceTurnIds: ["turn-a"],
      status: "active",
      embeddingStatus: "pending",
    };
    const duplicateContent = {
      ...first,
      id: "mem_1703fd7c37a27ea872c2",
      sourceTurnIds: ["turn-b"],
    };

    const appended = store.appendCandidates([first, duplicateContent]);

    assert.deepStrictEqual(appended.map((candidate) => candidate.id), [first.id]);
    assert.deepStrictEqual(store.readCandidates(10).map((candidate) => candidate.id), [first.id]);
  });

  it("preserves candidate status transitions with duplicate statement text", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-neo-candidate-status-transition-"));
    const workspaceKey = "workspace-candidate-status-transition";
    const store = createNeoStore(root, workspaceKey);
    const candidate = {
      id: "mem_status_transition_001",
      workspaceKey,
      statement: "Promote this exact candidate without losing the update.",
      normalizedStatement: "Promote this exact candidate without losing the update.",
      category: "workspace_fact",
      status: "candidate",
      embeddingStatus: "pending",
    };
    const promoted = transitionRecordStatus(candidate, "promoted", {
      now: "2026-07-04T12:00:00.000Z",
    });

    store.appendCandidates([candidate]);
    const appended = store.appendCandidates([promoted]);
    store.pruneAll();
    const records = store.readCandidates(10);

    assert.deepStrictEqual(appended.map((record) => record.id), [candidate.id]);
    assert.equal(records.length, 2);
    assert.equal(records.at(-1).status, "promoted");
    assert.equal(records.at(-1).updatedAt, "2026-07-04T12:00:00.000Z");
  });

  it("uses ctx session identity for turn ids while deduping repeated candidate content", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-neo-ctx-session-"));
    const workspaceKey = "workspace-ctx-session";
    const store = createNeoStore(root, workspaceKey);
    const event = {
      workspaceKey,
      messages: [
        {
          role: "user",
          content: "Always keep ctx-only sessions isolated in Neo capture.",
        },
      ],
    };

    const first = captureNeoFromAgentEnd(event, { agentId: "bernhardine", sessionId: "ctx-session-a" }, store);
    const second = captureNeoFromAgentEnd(event, { agentId: "bernhardine", sessionId: "ctx-session-b" }, store);

    assert.notStrictEqual(first.turns[0].id, second.turns[0].id);
    assert.equal(store.readTurns(10).length, 2);
    assert.equal(store.readCandidates(10).length, 1);
  });

  it("keeps replay idempotent after the original id falls outside the JSONL tail window", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-neo-index-replay-"));
    const workspaceKey = "workspace-index-replay";
    const store = createNeoStore(root, workspaceKey);
    const event = {
      workspaceKey,
      sessionId: "session-index-replay-001",
      messages: [
        {
          role: "user",
          content: "Always keep Neo replay idempotency independent from tail windows.",
        },
      ],
    };
    const ctx = { agentId: "bernhardine" };

    const first = captureNeoFromAgentEnd(event, ctx, store);
    const originalTurnId = first.turns[0].id;
    store.appendTurns(
      Array.from({ length: 5105 }, (_, index) => ({
        id: `filler-turn-${index}`,
        workspaceKey,
        agentId: "bernhardine",
        sessionId: `filler-session-${index}`,
        turnIndex: index,
        role: "user",
        content: `filler content ${index}`,
        createdAt: new Date(0).toISOString(),
      })),
    );

    captureNeoFromAgentEnd(event, ctx, store);

    const occurrences = readJsonl(store.paths.turns)
      .filter((record) => record.id === originalTurnId)
      .length;
    assert.equal(occurrences, 1);
  });
});

// temp dir left for OS cleanup
