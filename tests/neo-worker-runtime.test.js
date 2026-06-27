import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNeoStore } from "../lib/neo-arch.js";
import { createNeoWorkerRuntime } from "../lib/neo-worker-runtime.js";

function makeRoot(prefix = "plur1bus-neo-worker-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function latestById(records) {
  const byId = new Map();
  for (const record of records) {
    if (record?.id) byId.set(record.id, record);
  }
  return [...byId.values()];
}

describe("neo worker runtime", () => {
  it("captures agent_end messages in a worker and returns counts", async () => {
    const rootDir = makeRoot("plur1bus-neo-worker-capture-");
    const runtime = createNeoWorkerRuntime();
    try {
      const result = await runtime.runNeoAgentEnd(
        {
          workspaceKey: "workspace-runtime",
          sessionId: "session-runtime-001",
          messages: [
            {
              role: "assistant",
              content: "I will capture Neo worker runtime facts in JSONL.",
            },
            {
              role: "user",
              content: "Always keep the worker runtime path enabled for Neo capture.",
            },
          ],
        },
        { agentId: "bernhardine" },
        {
          rootDir,
        },
      );

      assert.deepStrictEqual(result, {
        workspaceKey: "workspace-runtime",
        capture: {
          turns: 2,
          candidates: 2,
          reactions: 1,
          behaviorCards: 1,
        },
        drain: null,
      });

      const store = createNeoStore(rootDir, "workspace-runtime");
      assert.equal(readJsonl(store.paths.turns).length, 2);
      assert.equal(readJsonl(store.paths.candidates).length, 2);
      assert.equal(readJsonl(store.paths.reactions).length, 1);
      assert.equal(readJsonl(store.paths.behavior).length, 1);
      assert.equal(readJsonl(store.paths.embeddings).length, 5);
      assert.deepStrictEqual(store.readHooks(), {});
    } finally {
      await runtime.close();
    }
  });

  it("drains pending low-impact embedding queue entries when enabled", async () => {
    const rootDir = makeRoot("plur1bus-neo-worker-drain-");
    const runtime = createNeoWorkerRuntime();
    try {
      const result = await runtime.runNeoAgentEnd(
        {
          workspaceKey: "workspace-drain",
          sessionId: "session-drain-001",
          messages: [
            {
              role: "assistant",
              content: "The Neo worker drain should mark low impact capture records fresh.",
            },
            {
              role: "user",
              content: "Always run the drain outside the gateway main thread.",
            },
          ],
        },
        { agentId: "bernhardine" },
        {
          rootDir,
          embeddingDrainEnabled: true,
          embeddingDrainImpact: "low",
          embeddingDrainMaxItems: 20,
        },
      );

      assert.equal(result.workspaceKey, "workspace-drain");
      assert.deepStrictEqual(result.capture, {
        turns: 2,
        candidates: 2,
        reactions: 1,
        behaviorCards: 1,
      });
      assert.ok(result.drain);
      assert.equal(result.drain.processed, 5);
      assert.equal(result.drain.pending, 0);
      assert.equal(result.drain.skipped, 0);
      assert.equal(result.drain.parseErrors, 0);
      assert.ok(result.drain.queuePath.endsWith("embedding-queue.jsonl"));

      const store = createNeoStore(rootDir, "workspace-drain");
      assert.equal(latestById(readJsonl(store.paths.embeddings)).every((item) => item.status === "done"), true);
      assert.equal(latestById(store.readTurns(10)).every((turn) => turn.embeddingStatus === "fresh"), true);
      assert.equal(latestById(store.readCandidates(10)).every((candidate) => candidate.embeddingStatus === "fresh"), true);
      assert.equal(latestById(store.readBehaviorCards(10)).every((card) => card.embeddingStatus === "fresh"), true);
    } finally {
      await runtime.close();
    }
  });

  it("skips capture when messages are absent but can still drain", async () => {
    const rootDir = makeRoot("plur1bus-neo-worker-drain-only-");
    const store = createNeoStore(rootDir, "workspace-drain-only");
    const candidate = {
      id: "mem-drain-only-001",
      workspaceKey: "workspace-drain-only",
      agentId: "bernhardine",
      statement: "Low impact prequeued memory.",
      sourceTurnIds: ["turn-prequeued-001"],
      status: "candidate",
      embeddingStatus: "pending",
      impact: "low",
    };
    store.appendCandidates([candidate]);
    store.appendEmbeddingQueue([candidate]);

    const runtime = createNeoWorkerRuntime();
    try {
      const result = await runtime.runNeoAgentEnd(
        { workspaceKey: "workspace-drain-only", messages: [] },
        { agentId: "bernhardine" },
        {
          rootDir,
          embeddingDrainEnabled: true,
          embeddingDrainImpact: "low",
          embeddingDrainMaxItems: 10,
        },
      );

      assert.deepStrictEqual(result.capture, {
        turns: 0,
        candidates: 0,
        reactions: 0,
        behaviorCards: 0,
      });
      assert.equal(result.drain.processed, 1);
      assert.equal(result.drain.pending, 0);
      assert.equal(readJsonl(store.paths.turns).length, 0);
      assert.equal(store.readCandidates(10).at(-1).embeddingStatus, "fresh");
      assert.deepStrictEqual(store.readHooks(), {});
    } finally {
      await runtime.close();
    }
  });

  it("rejects worker errors and recreates the worker for the next job", async () => {
    const rootDir = makeRoot("plur1bus-neo-worker-error-");
    const runtime = createNeoWorkerRuntime();
    try {
      await assert.rejects(
        runtime.runNeoAgentEnd(
          { workspaceKey: "workspace-error", messages: [] },
          { agentId: "bernhardine" },
          { rootDir: "", embeddingDrainEnabled: true },
        ),
        /rootDir/,
      );

      const result = await runtime.runNeoAgentEnd(
        {
          workspaceKey: "workspace-error",
          sessionId: "session-after-error",
          messages: [{ role: "user", content: "Always recover the Neo worker after failed jobs." }],
        },
        { agentId: "bernhardine" },
        { rootDir },
      );

      assert.equal(result.workspaceKey, "workspace-error");
      assert.equal(result.capture.turns, 1);
      assert.equal(createNeoStore(rootDir, "workspace-error").readTurns(10).length, 1);
    } finally {
      await runtime.close();
    }
  });

  it("terminates an aborted worker job and recreates the worker for the next job", async () => {
    const rootDir = makeRoot("plur1bus-neo-worker-abort-");
    const runtime = createNeoWorkerRuntime();
    try {
      const controller = new AbortController();
      const pending = runtime.runNeoAgentEnd(
        {
          workspaceKey: "workspace-abort",
          sessionId: "session-abort",
          messages: [{ role: "user", content: "Always abort Neo worker jobs cleanly when requested." }],
        },
        { agentId: "bernhardine" },
        { rootDir, signal: controller.signal },
      );
      controller.abort();

      await assert.rejects(pending, /aborted|terminated/);

      const result = await runtime.runNeoAgentEnd(
        {
          workspaceKey: "workspace-abort",
          sessionId: "session-after-abort",
          messages: [{ role: "user", content: "Always recreate the Neo worker after abort." }],
        },
        { agentId: "bernhardine" },
        { rootDir },
      );

      assert.equal(result.workspaceKey, "workspace-abort");
      assert.equal(result.capture.turns, 1);
    } finally {
      await runtime.close();
    }
  });
});
