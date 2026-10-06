/**
 * tests/log-no-content.test.js — L2 (N2 leak audit I-1..I-5).
 *
 * Plugin logs must carry ids, lengths, hashes and counts, never memory text,
 * user prompts, reminder text or a plain channel peer id. Each test drives the
 * real code with a unique marker and asserts the marker is absent from every
 * captured logger / console call and that the replacement fields are present.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";

import plugin, { MemoryDB } from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { runAfterthoughtJob } from "../lib/afterthought.js";
import { runReminderDispatch } from "../lib/jobs/reminder-dispatch.js";
import { registerTurnRouteHooks } from "../adapter/openclaw/register-turn-route.js";
import { createStubHost } from "../lib/host-services.js";
import { buildConflictSummaryFromLog } from "../engine/commands/command-helpers.js";
import { createInternalJobBodies } from "../engine/jobs/internal-job-bodies.js";
import {
  describeError,
  describeSessionKey,
  describeText,
  summarizeAfterthoughtResultForLog,
  summarizePersonaResultForLog,
  summarizeReminderResultForLog,
} from "../lib/log-redact.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function captureLogger() {
  const calls = [];
  const rec = (level) => (...args) => {
    calls.push({ level, text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
  };
  return { calls, logger: { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") } };
}
const dump = (calls) => calls.map((c) => `${c.level}: ${c.text}`).join("\n");

describe("lib/log-redact", () => {
  it("describeText reveals length and a hash only", () => {
    const out = describeText("zzsecretzz");
    assert.match(out, /^textLen=10 sha=[0-9a-f]{12}$/);
    assert.ok(!out.includes("secret"));
  });

  it("describeError keeps class and code, not the message body", () => {
    const err = Object.assign(new Error("secret path /tmp/zzsecretzz"), { name: "Error", code: "ENOENT" });
    const out = describeError(err);
    assert.match(out, /^Error code=ENOENT textLen=\d+ sha=[0-9a-f]{12}$/);
    assert.ok(!out.includes("secret"));
    assert.ok(!out.includes("/tmp/"));
    assert.equal(describeError(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" })).includes("ECONNRESET"), true);
  });

  it("describeSessionKey keeps agent, channel and kind but hashes the peer", () => {
    const out = describeSessionKey("agent:main:telegram:acc1:direct:123456789");
    assert.match(out, /^agent=main channel=telegram kind=direct peer=[0-9a-f]{12}$/);
    assert.ok(!out.includes("123456789"));
    assert.equal(describeSessionKey("agent:a:s").includes("agent:a:s"), false);
    assert.match(describeSessionKey("weird-key-987654"), /^sessionKeyHash=[0-9a-f]{12}$/);
    assert.equal(describeSessionKey(""), "none");
  });

  it("result summarizers drop text-bearing fields", () => {
    assert.deepEqual(summarizeAfterthoughtResultForLog({ text: "abcd", topic: "xy", skipped: false }), { skipped: false, textLen: 4, topicLen: 2 });
    assert.deepEqual(summarizePersonaResultForLog({ evolved: true, marker: "abc" }), { evolved: true, markerLen: 3 });
    const rem = summarizeReminderResultForLog({ dispatched: 1, details: [{ id: "i1", text: "hello", remindAt: 5, deliveryOk: false }] });
    assert.deepEqual(rem, { dispatched: 1, details: [{ id: "i1", textLen: 5, remindAt: 5, deliveryOk: false }] });
  });
});

describe("register-turn-route session key logging (I-2)", () => {
  it("never logs the plain peer id at any level", async () => {
    const PEER = "918273645";
    const { calls, logger } = captureLogger();
    const registrations = [];
    const api = { logger, on(name, handler, options) { registrations.push({ name, handler, options }); return { dispose() {} }; } };
    const host = createStubHost();
    host.logger = logger;
    for (const observed of ["none", "registered"]) {
      registerTurnRouteHooks({
        api,
        host,
        autoRecall: true,
        getMemoryTurnRoutes: async () => ({ observeReplyDispatch() {}, lastObserve: () => observed }),
        turnRouteState: {},
      });
    }
    for (const reg of registrations.filter((r) => r.name === "reply_dispatch")) {
      await reg.handler({ sessionKey: `agent:a:telegram:acc:direct:${PEER}`, runId: "r1" }, { dispatchKind: "agent" });
      await reg.handler({ ctx: { SessionKey: `agent:a:telegram:acc:direct:${PEER}` }, runId: "r2" }, { dispatchKind: "agent" });
    }
    const all = dump(calls);
    assert.ok(all.includes("reply_dispatch handler invoked"), "invocation line must be logged");
    assert.ok(all.includes("dispatch observe:"), "observe line must be logged");
    assert.ok(!all.includes(PEER), `peer id leaked:\n${all}`);
    assert.match(all, /sessionKey=agent=a channel=telegram kind=direct peer=[0-9a-f]{12}/);
    assert.match(all, /session=agent=a channel=telegram kind=direct peer=[0-9a-f]{12}/);
  });
});

describe("afterthought logging (I-3)", () => {
  const M = 60000;
  const T0 = 1750000000000;

  it("runAfterthoughtJob logs no part of the user prompt", async () => {
    const MARK = "zzpromptmarkerzz";
    const dir = makeTempDir("l2-at-");
    mkdirSync(join(dir, ".adaptive-learning"), { recursive: true });
    const entry = { timestamp: T0 - 45 * M, outcome: "asked_details", userPrompt: `wie richte ich ${MARK} ein?` };
    writeFileSync(join(dir, ".adaptive-learning", "reply-outcomes.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
    const { calls, logger } = captureLogger();
    const res = await runAfterthoughtJob({
      workspaceDir: dir,
      agentId: "a",
      llmCfg: { model: "x" },
      callLlm: async () => "Mir ist noch was eingefallen: probier rsync.",
      logger,
      now: T0,
      hour: 12,
    });
    try {
      assert.ok(res.text, "job must compose a follow-up");
      assert.ok(res.topic.includes(MARK), "the returned result (reply path) keeps the topic");
      const all = dump(calls);
      assert.match(all, /composed follow-up \(topic textLen=\d+ sha=[0-9a-f]{12}\)/);
      assert.ok(!all.includes(MARK), `prompt leaked:\n${all}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("internal job body logging (I-3, I-4)", () => {
  function makeRunner(host, overrides = {}) {
    const run = createInternalJobBodies({
      host,
      cfg: {},
      skillMinerEnabled: true,
      mergingEnabled: false,
      afterthoughtLlmCfg: { model: "x" },
      personaVoiceLlmCfg: { model: "x" },
      formatJsonCommandResult: (value) => JSON.stringify(value),
      callCommandLlm: async () => "Mir ist noch was eingefallen: probier rsync.",
      ...overrides,
    });
    return (name, input) => run(name, { input, skip: (_r, out) => out, incomplete: (_r, out) => out });
  }

  it("afterthought job body logs lengths, not topic or composed text", async () => {
    const MARK = "zzbodypromptzz";
    const dir = makeTempDir("l2-atb-");
    mkdirSync(join(dir, ".adaptive-learning"), { recursive: true });
    const now = Date.now();
    const entry = { timestamp: now - 45 * 60000, outcome: "asked_details", userPrompt: `wie richte ich ${MARK} ein?` };
    writeFileSync(join(dir, ".adaptive-learning", "reply-outcomes.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
    const { calls, logger } = captureLogger();
    const host = createStubHost();
    host.logger = logger;
    // Quiet hours are wall-clock based; pin the timezone to one where the hour is allowed.
    const hourNow = (tz) => Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now)) % 24;
    const tz = ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Auckland"].find((z) => hourNow(z) >= 9 && hourNow(z) <= 20);
    try {
      const out = await makeRunner(host, { cfg: { afterthought: { timezone: tz } } })("afterthought", {
        commandCtx: { agentId: "a", workspaceDir: dir },
        cronInternal: false,
      });
      assert.ok(String(out).includes("rsync"), `job must have composed a follow-up: ${out}`);
      const all = dump(calls);
      assert.match(all, /internal afterthought\[a\]: .*"textLen":\d+/);
      assert.ok(!all.includes(MARK), `prompt leaked:\n${all}`);
      assert.ok(!all.includes("rsync"), `composed text leaked:\n${all}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reminder-dispatch job body logs textLen, not the reminder text", async () => {
    const MARK = "zzremindermarkerzz";
    const dir = makeTempDir("l2-rem-");
    const now = Date.now();
    let data = [{ id: "11111111-1111-1111-1111-111111111111", text: `ruf ${MARK} an`, memoryKind: "reminder", storedBy: "a", workspaceKey: "ws-1", remindAt: now - 1000, reminderStatus: "scheduled" }];
    const db = {
      init: async () => {},
      table: {
        query() { return this; },
        where() { return this; },
        limit() { return this; },
        toArray: async () => data,
        update: async ({ where, values }) => {
          const m = where.match(/id\s*=\s*'([^']+)'/);
          data = data.map((r) => (r.id === (m && m[1]) ? { ...r, ...values } : r));
        },
      },
    };
    const { calls, logger } = captureLogger();
    const host = createStubHost();
    host.logger = logger;
    try {
      const out = await makeRunner(host, { pool: { withDb: async (_agent, fn) => fn(db) } })("reminder-dispatch", {
        commandCtx: { agentId: "a", workspaceDir: dir, workspaceKey: "ws-1" },
      });
      assert.ok(String(out).includes(MARK), "the command reply (not the log) keeps the reminder text");
      const all = dump(calls);
      assert.match(all, /internal reminder-dispatch\[a\]: .*"textLen":\d+/);
      assert.ok(all.includes("11111111-1111-1111-1111-111111111111"), "id stays loggable");
      assert.ok(!all.includes(MARK), `reminder text leaked:\n${all}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runReminderDispatch itself never logs reminder text", async () => {
    const MARK = "zzreminderdirectzz";
    const dir = makeTempDir("l2-rem2-");
    const now = Date.now();
    const rows = [{ id: "22222222-2222-2222-2222-222222222222", text: MARK, memoryKind: "reminder", storedBy: "a", workspaceKey: "ws-1", remindAt: now - 1000, reminderStatus: "scheduled" }];
    const db = { init: async () => {}, table: { query() { return this; }, where() { return this; }, limit() { return this; }, toArray: async () => rows, update: async () => {} } };
    const { calls, logger } = captureLogger();
    try {
      const res = await runReminderDispatch(db, "a", { workspaceDir: dir, workspaceKey: "ws-1", logger });
      assert.equal(res.dispatched, 1);
      assert.ok(!dump(calls).includes(MARK));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conflict-summary console.warn (I-5)", () => {
  it("malformed conflict-log lines are reported by length, not content", () => {
    const MARK = "zzconflictlinezz";
    const dir = makeTempDir("l2-cl-");
    mkdirSync(join(dir, ".adaptive-learning"), { recursive: true });
    writeFileSync(join(dir, ".adaptive-learning", "conflict-log.jsonl"), `{"timestamp":1}\nnot json ${MARK} text\n`, "utf8");
    const warns = [];
    const original = console.warn;
    console.warn = (...args) => { warns.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
    try {
      const summary = buildConflictSummaryFromLog(dir);
      assert.equal(summary.count, 1);
    } finally {
      console.warn = original;
      rmSync(dir, { recursive: true, force: true });
    }
    const all = warns.join("\n");
    assert.match(all, /malformed line/);
    assert.match(all, /"lineLength":\d+/);
    assert.ok(!all.includes(MARK), `line content leaked:\n${all}`);
  });
});

describe("memory-merge-safety logging (I-1)", () => {
  const VECTOR_DIM = 384;
  const makeVector = (offset = 0) => { const v = Array(VECTOR_DIM).fill(0.1); v[0] = 0.1 + offset; return v; };
  let basePath;
  let workspaceDir;
  let openclawHome;
  let originalHome;
  let originalCreate;
  let originalEmbed;
  let seq = 0;

  before(() => {
    basePath = makeTempDir("l2-merge-");
    workspaceDir = makeTempDir("l2-merge-ws-");
    openclawHome = makeTempDir("l2-merge-home-");
    originalHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openclawHome;
    mkdirSync(join(openclawHome, ".openclaw", "memory", "_archive"), { recursive: true });
    originalCreate = OpenAI.Chat.Completions.prototype.create;
    originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => makeVector(0.25);
  });

  after(() => {
    OpenAI.Chat.Completions.prototype.create = originalCreate;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbed;
    for (const d of [basePath, workspaceDir, openclawHome]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
    if (originalHome === undefined) delete process.env.OPENCLAW_HOME; else process.env.OPENCLAW_HOME = originalHome;
  });

  async function runStore({ existingText, existingVector, newText, llmMergedText, extraParams = {} }) {
    const agentId = `l2-agent-${++seq}`;
    const db = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await db.store({ id: "55555555-5555-5555-5555-555555555555", text: existingText, vector: existingVector, category: "fact", createdAt: Date.now(), storedBy: agentId });
    OpenAI.Chat.Completions.prototype.create = async () => ({
      choices: [{ message: { content: JSON.stringify({ merge: true, reason: "t", mergedText: llmMergedText ?? "" }) } }],
    });
    const { calls, logger } = captureLogger();
    const api = {
      pluginConfig: {
        baseDbPath: basePath,
        embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
        merging: { enabled: true, autoApply: true, model: "mock-model", apiKey: "sk-test" },
        emotion: { t3: { enabled: false } },
        duplicateThreshold: 0.9999,
        obsidianBridge: { enabled: false },
        autoCapture: false,
        autoRecall: false,
        neo: { enabled: false },
        gc: { enabled: false },
      },
      logger,
      resolvePath: (p) => p,
      registerCommand() {},
      registerTool(factory) { this._toolFactory = factory; },
      on() {},
      registerService() {},
    };
    plugin.register(api);
    const store = api._toolFactory({ agentId, workspaceDir }).find((t) => t.name === "memory_store");
    await store.execute("call", { text: newText, category: "fact", ...extraParams });
    return dump(calls);
  }

  it("meaningful-difference warn carries lengths and hashes, not either memory text", async () => {
    const all = await runStore({
      existingText: "Projekt Alpha nutzt den Auth-Service zzoldmarkerzz.",
      existingVector: makeVector(0.2),
      newText: "Projekt Beta nutzt den Auth-Service zznewmarkerzz.",
    });
    assert.match(all, /meaningful difference; storing separately: new textLen=\d+ sha=[0-9a-f]{12} vs existing textLen=\d+ sha=[0-9a-f]{12}/);
    assert.ok(!all.includes("zzoldmarkerzz") && !all.includes("zznewmarkerzz"), `memory text leaked:\n${all}`);
  });

  it("lossy LLM mergedText warn does not echo the merged text", async () => {
    const all = await runStore({
      existingText: "Projekt Alpha nutzt den Auth-Service intern zzoldmarkerzz.",
      existingVector: makeVector(0.2),
      newText: "Projekt Alpha nutzt den Auth-Service intern zzoldmarkerzz und zznewmarkerzz.",
      llmMergedText: "Irgendwas zzmergedmarkerzz mit deutlich mehr Text als beide Originale zusammen, aber ohne die Fakten dazu.",
    });
    assert.match(all, /loses facts; aborting merge and storing separately: merged textLen=\d+ sha=[0-9a-f]{12}/);
    assert.ok(!all.includes("zzmergedmarkerzz") && !all.includes("zzoldmarkerzz") && !all.includes("zznewmarkerzz"), `memory text leaked:\n${all}`);
  });

  it("no-safe-duplicate info does not echo the new text", async () => {
    const all = await runStore({
      existingText: "Projekt Alpha nutzt den Auth-Service zzoldmarkerzz.",
      existingVector: makeVector(0.25),
      newText: "Projekt Alpha nutzt den Auth-Service zznewmarkerzz.",
      extraParams: { validFrom: "2026-01-01", validUntil: "2026-02-01" },
    });
    assert.match(all, /high similarity but no safe duplicate; storing separately: textLen=\d+ sha=[0-9a-f]{12}/);
    assert.ok(!all.includes("zzoldmarkerzz") && !all.includes("zznewmarkerzz"), `memory text leaked:\n${all}`);
  });
});
