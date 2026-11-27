/**
 * tests/log-error-messages.test.js — leak audit follow-up: error messages in log lines.
 *
 * LanceDB/Arrow, fetch, fs and host errors can echo a filter value, a row, a URL or a path in
 * `.message`. Log lines carry class, code, length and hash instead. Each driven test throws an
 * error with a unique marker in its message, captures the log and asserts the marker is absent
 * while class/hash are present. Return values and thrown errors keep the original message.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fetchWithRetry } from "../lib/fetch-with-timeout.js";
import { runClassifier as runCriticalClassifier } from "../lib/jobs/critical-classifier.js";
import { readPromotedKnowledgeIds } from "../lib/jobs/schicht15-tracker.js";
import { describeError, formatErrorForLog, summarizeJobResultForLog } from "../lib/log-redact.js";
import { runRecallPipeline } from "../lib/recall-pipeline.js";
import { describeErrorForLog, redactError, safeDebug, safeWarn, trySafeWarn } from "../lib/safe-logging.js";
import { makeEmbeddings, makeRow, mockTable } from "./helpers/golden-recall-harness.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const T = { timeout: 20_000 };
const HASHED = /Error textLen=\d+ sha=[0-9a-f]{12}/;

function captureLogger() {
  const calls = [];
  const rec = (level) => (...args) => {
    calls.push({ level, text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
  };
  return { calls, logger: { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") } };
}
const dump = (calls) => calls.map((c) => `${c.level}: ${c.text}`).join("\n");

describe("describeError / describeErrorForLog", () => {
  it("hides the message, keeps class, code and a short URL form", T, () => {
    const err = Object.assign(new TypeError("fetch failed for https://user:tok@api.example.com/v1/zzpathzz?key=zzsecretzz"), { code: "ECONNRESET" });
    for (const out of [describeError(err), describeErrorForLog(err)]) {
      assert.match(out, /^TypeError code=ECONNRESET textLen=\d+ sha=[0-9a-f]{12} urls=https:\/\/api\.example\.com pathHash=[0-9a-f]{12}$/);
      for (const m of ["zzpathzz", "zzsecretzz", "user:tok"]) assert.ok(!out.includes(m), m);
    }
  });

  it("keeps constant-like messages and caller-written string reasons readable", T, () => {
    assert.equal(describeError(new Error("E_TIMEOUT")), "Error E_TIMEOUT");
    assert.equal(describeError(new Error("llm_error")), "Error llm_error");
    assert.match(describeError(new Error("timeout")), HASHED, "a single plain word is not trusted");
    assert.equal(describeErrorForLog("embedding service not configured"), "embedding service not configured");
    assert.equal(describeErrorForLog("failed with token=abcdef1234567890 at https://h.example/a/b?q=1").includes("abcdef1234567890"), false);
    assert.ok(!describeErrorForLog("see https://h.example/zzpathzz?q=1").includes("zzpathzz"));
  });

  it("formatErrorForLog ignores foreign class and code values", T, () => {
    assert.match(formatErrorForLog({ name: "bad name with spaces", code: { x: 1 }, message: "m" }), /^Error textLen=1 sha=[0-9a-f]{12}$/);
  });

  it("redactError still returns the credential-redacted message for callers that need it", T, () => {
    const out = redactError(new Error("failed token=abcdef1234567890 zzkeepmessagezz")).message;
    assert.ok(out.includes("zzkeepmessagezz") && !out.includes("abcdef1234567890"));
  });
});

describe("safeWarn / safeDebug / trySafeWarn", () => {
  it("log class, code, length and hash of an Error, never its message", T, () => {
    const err = Object.assign(new Error("where agentId = 'zzfilterzz' failed"), { code: "ELANCE" });
    const { calls, logger } = captureLogger();
    safeWarn(logger, "scope-a", err, { agentId: "main" });
    trySafeWarn(logger, "scope-b", err);
    safeDebug(logger, "scope-c", err);
    const all = dump(calls);
    assert.equal(calls.length, 3);
    assert.match(all, /\[scope-a\] failed: Error code=ELANCE textLen=\d+ sha=[0-9a-f]{12}/);
    assert.match(all, /\[scope-b\] failed: Error code=ELANCE/);
    assert.match(all, /\[scope-c\] failed: Error code=ELANCE/);
    assert.ok(!all.includes("zzfilterzz"), all);
  });
});

describe("summarizeJobResultForLog enum keys (review of #233)", () => {
  it("does not keep a <platform>:<digits> peer id under reason or note", T, () => {
    const out = summarizeJobResultForLog({ reason: "telegram:12345678", note: "discord:99887766", job: "x" });
    assert.match(out.reason, /^textLen=\d+ sha=[0-9a-f]{12}$/);
    assert.match(out.note, /^textLen=\d+ sha=[0-9a-f]{12}$/);
    assert.equal(out.job, "x");
    assert.ok(!JSON.stringify(out).includes("12345678"));
  });

  it("allows ':' only for id keys and never for <platform>:<digits>", T, () => {
    const out = summarizeJobResultForLog({ agentId: "agent:main", id: "user:v1:abcdef", memoryId: "telegram:12345678" });
    assert.equal(out.agentId, "agent:main");
    assert.equal(out.id, "user:v1:abcdef");
    assert.match(out.memoryId, /^textLen=\d+ sha=[0-9a-f]{12}$/);
  });
});

describe("driven log paths", () => {
  it("fetchWithRetry logs the retry without the error message", T, async () => {
    const MARK = "zzfetchmarkerzz";
    const { calls, logger } = captureLogger();
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw Object.assign(new TypeError(`socket error ${MARK} at https://h.example/p?token=abc`), { code: "ECONNREFUSED" }); };
    try {
      await assert.rejects(
        fetchWithRetry("https://h.example/x", { method: "GET" }, { maxRetries: 1, backoffMs: 1, timeoutMs: 500, logger }),
        /fetch failed/,
      );
    } finally {
      globalThis.fetch = original;
    }
    const all = dump(calls);
    assert.match(all, /\[fetchRetry\] attempt 1 failed, retrying in 1ms: Error code=ECONNREFUSED textLen=\d+ sha=[0-9a-f]{12} urls=https:\/\/h\.example/);
    assert.ok(!all.includes(MARK), all);
  });

  it("critical classifier logs a DB failure without its message, the result keeps it", T, async () => {
    const MARK = "zzclassifierdbzz";
    const { calls, logger } = captureLogger();
    const db = { findRecentUnclassified: async () => { throw new Error(`lance: filter text = '${MARK}'`); } };
    const result = await runCriticalClassifier(db, "a", { logger, model: { complete: async () => ({ text: "fakt" }) } });
    assert.ok(String(result.error).includes(MARK), "the returned value is unchanged");
    const all = dump(calls);
    assert.match(all, /critical-classifier\[a\]: findRecentUnclassified failed: Error textLen=\d+ sha=[0-9a-f]{12}/);
    assert.ok(!all.includes(MARK), all);
  });

  it("recall pipeline logs a failing reranker without its message", T, async () => {
    const MARK = "zzrerankerrorzz";
    const { calls, logger } = captureLogger();
    const own = (o) => ({ ...makeRow(o), agentId: "agent-a", storedBy: "agent-a" });
    const rows = [own({ id: "r1", text: "alpha", distance: 0.1 }), own({ id: "r2", text: "beta", distance: 0.2 })];
    const result = await runRecallPipeline({
      agentId: "agent-a",
      query: "alpha",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      reranker: { async rerank() { throw new Error(`rerank api said ${MARK}`); } },
      topN: 5,
      recallMinScore: 0.1,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      logger,
    });
    assert.ok(result.memories.length > 0, "recall still answers without the reranker");
    const all = dump(calls);
    assert.match(all, /rerank failed.*Error textLen=\d+ sha=[0-9a-f]{12}/);
    assert.ok(!all.includes(MARK), all);
  });

  it("schicht15 tracker logs a corrupt state file without the parser's content snippet", T, () => {
    const MARK = "zzstatefilecontentzz";
    const dir = makeTempDir("l4-s15-");
    const warns = [];
    const original = console.warn;
    console.warn = (...args) => { warns.push(args.map(String).join(" ")); };
    try {
      writeFileSync(join(dir, "run-state.json"), `{ "promotedKnowledge": ${MARK} `, "utf8");
      readPromotedKnowledgeIds(dir, "ws", "a");
    } finally {
      console.warn = original;
      rmSync(dir, { recursive: true, force: true });
    }
    const all = warns.join("\n");
    assert.match(all, /\[schicht15-tracker\] readJson failed: SyntaxError textLen=\d+ sha=[0-9a-f]{12}/);
    assert.ok(!all.includes(MARK), all);
  });
});
