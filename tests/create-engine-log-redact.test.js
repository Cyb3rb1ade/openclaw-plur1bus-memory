/**
 * tests/create-engine-log-redact.test.js — create-engine.js must not log
 * memory text, provider URLs or raw error messages (N2 leftover in this file).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createStubHost } from "../lib/host-services.js";
import { describeText, redactUrl } from "../lib/log-redact.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const TIMEOUT = { timeout: 30_000 };
const MARKER = "zzCreateEngineLeakMarker_7F3A_oat";

function captureLogger() {
  const calls = [];
  const rec = (level) => (...args) => {
    calls.push({ level, text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
  };
  return { calls, logger: { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") } };
}

const dump = (calls) => calls.map((c) => `${c.level}: ${c.text}`).join("\n");

function flatEmbedder() {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const one = async () => vector();
  return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
}

function config(baseDbPath, extra = {}) {
  return {
    baseDbPath,
    embedding: { provider: "local-transformers", local: { dimensions: 384 }, ...extra.embedding },
    autoCapture: false, autoRecall: false,
    neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
    runtime: { recallTimeoutMs: 10_000 },
    duplicateThreshold: 0.5,
    ...extra,
  };
}

describe("create-engine.js log redaction", () => {
  it("does not log a fallback baseUrl, topology error text, or memory text", TIMEOUT, async () => {
    const { calls, logger } = captureLogger();
    const leakUrl = `https://user:${MARKER}@api.example.com:8443/v1/embeddings?key=${MARKER}`;
    const host = createStubHost({
      stateDir: makeTempDir("ce-redact-state-"),
      logger,
      runtime: {
        config: {
          current() {
            throw new Error(`topology boom ${MARKER}`);
          },
        },
      },
    });
    const engine = createEngine(
      host,
      config(join(makeTempDir("ce-redact-root-"), "lancedb-namespaced"), {
        embedding: {
          provider: "openai-compatible",
          model: "text-embedding-3-small",
          dimensions: 384,
          baseUrl: "https://api.example.com/v1",
          fallback: { baseUrl: leakUrl, model: "fallback-model" },
        },
      }),
      { internals: { embeddings: flatEmbedder() } },
    );
    await internalsOf(engine).storeMemoryFromToolParams(
      { agentId: "agent-a" },
      { text: "Projekt Alpha nutzt den Auth-Service.", category: "fact", origin: "imported" },
    );
    await internalsOf(engine).storeMemoryFromToolParams(
      { agentId: "agent-a" },
      { text: `Projekt Beta nutzt den Auth-Service. ${MARKER}`, category: "fact", origin: "imported" },
    );
    const log = dump(calls);
    assert.equal(log.includes(MARKER), false, log);
    assert.ok(log.includes("embedding fallback configured"), log);
    assert.ok(log.includes(redactUrl(leakUrl)), log);
    assert.ok(log.includes("account topology snapshot unavailable"), log);
    assert.ok(log.includes("[memory-merge-safety]"), log);
    assert.ok(log.includes(describeText(`Projekt Beta nutzt den Auth-Service. ${MARKER}`)), log);
    await engine.close({ budgetMs: 5_000 });
  });
});
