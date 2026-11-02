import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { createStubHost } from "../lib/host-services.js";
import { createBackgroundMemoryScheduler } from "../lib/runtime-scheduler.js";
import { hashEmbedder } from "./helpers/hash-embedder.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const PRIVATE_ERROR = "Private orchard note at https://capture.invalid/private-detail";
const AGENT = "private-capture-agent";
const TEXT = "The orchard irrigation schedule starts every Tuesday at dawn.";
const BATCH_LOG = "memory-lancedb-namespaced: batch embed failed, falling back to individual embeddings operation=capture stage=batch-embedding errorCode=batch-embedding-failed";
const LATE_LOG = "memory-lancedb-namespaced: timed-out capture settled with error operation=capture stage=late-settlement errorCode=capture-late-error";

function rejection(kind) {
  let reads = 0;
  if (kind === "Error") {
    const error = new Error(PRIVATE_ERROR);
    error.name = PRIVATE_ERROR;
    error.code = PRIVATE_ERROR;
    return { error, reads: () => reads };
  }
  if (kind === "object") return {
    error: { name: PRIVATE_ERROR, message: PRIVATE_ERROR, code: PRIVATE_ERROR, toString: () => PRIVATE_ERROR },
    reads: () => reads,
  };
  const error = {};
  for (const key of ["name", "message", "code", "stack", "toString", Symbol.toPrimitive]) {
    Object.defineProperty(error, key, { get() { reads++; throw new Error("Error inspection must not run"); } });
  }
  return { error, reads: () => reads };
}

function recordingLogger() {
  const entries = [];
  const logger = Object.fromEntries(["info", "warn", "error", "debug"].map((level) => [level, (message) => entries.push({ level, message: String(message) })]));
  return { entries, logger };
}

async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Capture callback did not settle")), 2_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("capture content-free failure diagnostics (#277)", () => {
  for (const kind of ["Error", "object", "hostile getters"]) {
    it(`batch ${kind}: logs a closed diagnostic and still persists the individual-embedding fallback`, async (t) => {
      const root = makeTempDir("capture-log-batch-");
      const workspaceDir = join(root, "workspace");
      mkdirSync(workspaceDir, { recursive: true });
      const { entries, logger } = recordingLogger();
      const failure = rejection(kind);
      const embeddings = hashEmbedder();
      const embed = embeddings.embed.bind(embeddings);
      const individual = [];
      let batches = 0;
      embeddings.embedBatch = async () => { batches++; throw failure.error; };
      embeddings.embed = async (text, options) => { individual.push(text); return embed(text, options); };
      const engine = createEngine(createStubHost({ stateDir: join(root, "state"), workspaceDir: async () => workspaceDir, logger }), {
        baseDbPath: join(root, "db"),
        embedding: { provider: "local-transformers", local: { dimensions: 384 } },
        autoCapture: true, autoRecall: false,
        neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
        merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
        metaCognition: { enabled: false }, temporalContext: { enabled: false },
        runtime: { captureTimeoutMs: 10_000 },
      }, { internals: { embeddings } });
      t.after(() => engine.close({ budgetMs: 5_000 }));
      const principal = { agentId: AGENT, channel: "telegram", accountId: "default", chat: { id: "capture-chat", kind: "direct" }, trust: "proved" };
      const agent = { origin: "user", background: false };
      const report = await engine.capture({
        agentId: AGENT, principal, agent, runId: "capture-fallback", sessionKey: `agent:${AGENT}:main`,
        messages: [{ role: "user", content: TEXT }], incognito: false, signal: AbortSignal.timeout(10_000),
      }).done;
      assert.deepEqual(report, { stored: 1, skipped: 0 });
      assert.equal(batches, 1);
      assert.ok(individual.includes(TEXT), "the individual embedder receives the capture after the batch failure");
      const cards = await engine.memory.list({ since: 0, limit: 100 }, principal, agent);
      assert.ok(cards.items.some((card) => card.text === TEXT), "the real memory store contains the fallback capture");
      assert.deepEqual(entries.filter((entry) => entry.message.includes("batch embed failed")), [{ level: "warn", message: BATCH_LOG }]);
      assert.ok(entries.every((entry) => !entry.message.includes(PRIVATE_ERROR)));
      assert.equal(failure.reads(), 0, "logging must not access arbitrary error fields or coercion hooks");
    });

    it(`late ${kind}: logs a closed diagnostic and releases the timed-out callback's slot`, async (t) => {
      const { entries, logger } = recordingLogger();
      const failure = rejection(kind);
      const scheduler = createBackgroundMemoryScheduler({
        config: { captureTimeoutMs: 20, maxConcurrentCapturePerAgent: 1, pressureGateEnabled: false, eventLoopLagSnapshot: false },
        logger,
      });
      const firstGate = Promise.withResolvers();
      const firstStarted = Promise.withResolvers();
      const secondStarted = Promise.withResolvers();
      t.after(() => firstGate.resolve());
      const first = scheduler.enqueueCapture(AGENT, { timeoutMs: 20 }, async () => {
        firstStarted.resolve();
        await firstGate.promise;
      });
      await within(firstStarted.promise);
      const second = scheduler.enqueueCapture(AGENT, { timeoutMs: 5_000 }, async () => secondStarted.resolve());
      assert.deepEqual(await within(first), { ok: false, timedOut: true, background: false });
      assert.equal(scheduler.status().capture.active, 1);
      assert.equal(scheduler.status().capture.queuedTotal, 1, "the late callback still owns the same-agent slot");
      firstGate.reject(failure.error);
      await within(secondStarted.promise);
      assert.deepEqual(await within(second), { ok: true, background: false });
      assert.equal(scheduler.status().capture.active, 0);
      assert.equal(scheduler.status().capture.queuedTotal, 0);
      const late = entries.filter((entry) => entry.message.includes("timed-out capture settled with error"));
      assert.deepEqual(late, [{ level: "debug", message: LATE_LOG }]);
      assert.ok(late.every((entry) => !entry.message.includes(AGENT) && !entry.message.includes(PRIVATE_ERROR)));
      assert.equal(failure.reads(), 0, "late diagnostic cannot prevent accounting cleanup by inspecting an error");
    });
  }
});
