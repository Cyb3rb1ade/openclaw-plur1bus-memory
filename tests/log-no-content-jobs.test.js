/**
 * tests/log-no-content-jobs.test.js — leak audit, remaining items (U-1/U-2 and neighbours).
 *
 * Whole-result job logs must carry counts, ids and codes, never memory text, queries, topics,
 * skill names, owner/workspace identities, paths or raw error messages. Job-body tests drive the
 * real job code with a unique marker; the others feed a result shaped like the producer's real
 * output through the summarizer the job body uses.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { createInternalJobBodies } from "../engine/jobs/internal-job-bodies.js";
import { createStubHost } from "../lib/host-services.js";
import { recordFeedback } from "../lib/feedback-log.js";
import { describeError, summarizeJobResultForLog } from "../lib/log-redact.js";
import { createChatModelMutator } from "../lib/chat-model.js";
import { createGroupReasoningFilter } from "../lib/group-reasoning-filter.js";
import { runRecallPipeline } from "../lib/recall-pipeline.js";
import { makeEmbeddings } from "./helpers/golden-recall-harness.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const T = { timeout: 20_000 };

function captureLogger() {
  const calls = [];
  const rec = (level) => (...args) => {
    calls.push({ level, text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
  };
  return { calls, logger: { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") } };
}
const dump = (calls) => calls.map((c) => `${c.level}: ${c.text}`).join("\n");

function makeRunner(host, overrides = {}) {
  const run = createInternalJobBodies({
    host,
    cfg: {},
    formatJsonCommandResult: (value) => JSON.stringify(value),
    ...overrides,
  });
  return (name, input) => run(name, { input, skip: (_r, out) => out, incomplete: (_r, out) => out });
}

describe("summarizeJobResultForLog", () => {
  it("keeps numbers, booleans and code-like enums; hashes every other string", T, () => {
    const out = summarizeJobResultForLog({
      job: "x", reason: "too_few_memories", processed: 3, dryRun: false, note: "free text with spaces",
      error: "zzerrmarkerzz", id: "11111111-1111-1111-1111-111111111111", ownerUserId: "user-zzownerzz",
      nested: { path: "/Users/someone/zzpathzz/file.jsonl", count: 2 },
    });
    assert.equal(out.job, "x");
    assert.equal(out.reason, "too_few_memories");
    assert.equal(out.processed, 3);
    assert.equal(out.dryRun, false);
    assert.equal(out.id, "11111111-1111-1111-1111-111111111111");
    assert.equal(out.nested.count, 2);
    for (const k of ["note", "error", "ownerUserId"]) assert.match(String(out[k]), /^textLen=\d+ sha=[0-9a-f]{12}$/, k);
    assert.match(out.nested.path, /^textLen=\d+ sha=[0-9a-f]{12}$/);
    const all = JSON.stringify(out);
    for (const m of ["zzerrmarkerzz", "zzownerzz", "zzpathzz", "free text"]) assert.ok(!all.includes(m), m);
  });

  it("caps arrays and nesting", T, () => {
    const out = summarizeJobResultForLog({ list: Array.from({ length: 30 }, (_, i) => ({ n: i })) });
    assert.equal(out.list.length, 21);
    assert.deepEqual(out.list[20], { truncated: 10 });
  });

  it("describeError keeps class and code, not the message", T, () => {
    const err = Object.assign(new Error("filter agentId = 'zzdberrzz'"), { code: "ECONNRESET" });
    const out = describeError(err);
    assert.match(out, /^Error code=ECONNRESET textLen=\d+ sha=[0-9a-f]{12}$/);
    assert.ok(!out.includes("zzdberrzz"));
  });
});

describe("job result logs (U-1/U-2)", () => {
  it("feedback-report logs counts and ids, not the recall queries", T, async () => {
    const MARK = "zzfeedbackqueryzz";
    const dir = makeTempDir("l3-fb-");
    try {
      recordFeedback(dir, `wie geht ${MARK}`, "mem-1", "negative", { semantic: 0.1 });
      const { calls, logger } = captureLogger();
      const host = createStubHost();
      host.logger = logger;
      const out = await makeRunner(host)("feedback-report", { commandCtx: { agentId: "a", workspaceDir: dir } });
      assert.ok(String(out).includes(MARK), "the job return value keeps the query");
      const all = dump(calls);
      assert.match(all, /internal feedback-report\[a\]: .*"negativeCount":1/);
      assert.match(all, /"queriesWithBadRecall":\[\{"query":"textLen=\d+ sha=[0-9a-f]{12}","memoryId":"mem-1"/);
      assert.ok(!all.includes(MARK), `query leaked:\n${all}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-accept-stale logs error class and hash, not the DB error message", T, async () => {
    const MARK = "zzdbfilterzz";
    const { calls, logger } = captureLogger();
    const host = createStubHost();
    host.logger = logger;
    const memoryDbAdapter = {
      findUnconfirmedCritical: async () => [{ id: "c-1" }],
      markCriticalRejected: async () => { throw new Error(`update failed where text = '${MARK}'`); },
    };
    const out = await makeRunner(host, { memoryDbAdapter })("auto-accept-stale", { commandCtx: { agentId: "a" } });
    assert.ok(String(out).includes(MARK), "the job return value keeps the error detail");
    const all = dump(calls);
    assert.match(all, /internal auto-accept-stale\[a\]: .*"errors":1/);
    assert.match(all, /markCriticalRejected failed for c-1: Error textLen=\d+ sha=[0-9a-f]{12}/);
    assert.ok(!all.includes(MARK), `error text leaked:\n${all}`);
  });

  it("classify-recent result: card text, button text and error messages are dropped", T, () => {
    const out = JSON.stringify(summarizeJobResultForLog({
      processed: 2, pushed: 1, errors: 1,
      pushMessages: [{ id: "m-1", type: "critical", shortRef: "ab12", text: "zzcardtextzz", buttonText: "zzbuttonzz" }],
      errorDetails: [{ stage: "update", id: "m-2", error: "zzerrzz chat 12345", errorClass: "Error" }],
    }));
    assert.match(out, /"processed":2/);
    assert.match(out, /"id":"m-1"/);
    assert.match(out, /"errorClass":"Error"/);
    for (const m of ["zzcardtextzz", "zzbuttonzz", "zzerrzz", "12345"]) assert.ok(!out.includes(m), m);
  });

  it("consolidate-daily result: acl identities, paths and SQL filters are dropped", T, () => {
    const out = JSON.stringify(summarizeJobResultForLog({
      compacted: 1,
      partitionResults: [{ scope: "workspace", result: {
        compaction: { partitionResults: [{ aclPartition: { ownerUserId: "zzowner1zz", workspaceIdentity: "zzwsidzz", agentId: "main", scope: "workspace" }, merged: 2 }] },
        neoPrune: { turns: { path: "/Users/x/zzneopathzz/turns.jsonl", before: 5, after: 3 } },
        dynamicsDecay: { where: "agentId = 'zzwhere1zz' AND ownerUserId = 'zzowner2zz'", decayed: 4 },
      } }],
      graphPrune: { error: "zzgrapherrzz" },
      lancedbOptimize: { ok: false, reason: "table 'zztablezz' busy" },
    }));
    assert.match(out, /"merged":2/);
    assert.match(out, /"decayed":4/);
    assert.match(out, /"before":5/);
    for (const m of ["zzowner1zz", "zzwsidzz", "zzneopathzz", "zzwhere1zz", "zzowner2zz", "zzgrapherrzz", "zztablezz"]) assert.ok(!out.includes(m), m);
  });

  it("rem-dream report: narrative, runKey, acl identities and mood are dropped", T, () => {
    const out = JSON.stringify(summarizeJobResultForLog({
      patternsFound: 3, new: 1, dreamMemoryId: "dream-1", weekOf: "2026-W40",
      narrative: "zznarrativezz", runKey: "rem:zzwsrunzz:main:k:2026-W40", moodLabel: "zzmoodzz",
      aclPartition: { workspaceIdentity: "zzwsrunzz", ownerUserId: "zzownerremzz", agentId: "main", scope: "user", key: "0123456789abcdef0123" },
      narrativeMemoryPersistence: { enabled: false, reason: "disabled_by_config" },
    }));
    assert.match(out, /"patternsFound":3/);
    assert.match(out, /"dreamMemoryId":"dream-1"/);
    assert.match(out, /"reason":"disabled_by_config"/);
    for (const m of ["zznarrativezz", "zzwsrunzz", "zzmoodzz", "zzownerremzz"]) assert.ok(!out.includes(m), m);
  });

  it("skill-miner runs: skill names, titles and acl bindings are dropped", T, () => {
    const out = JSON.stringify(summarizeJobResultForLog([{ scope: "workspace", result: {
      scanned: 9, proposalsCreated: 1,
      pushMessages: [{ skillName: "zzskillnamezz", skillTitle: "zz skill title zz", confidence: 0.9, autoApplied: false, activationStatus: "active" }],
      aclBindings: { workspaceIdentity: "zzskillwszz", ownerUserId: "zzskillownerzz", agentId: "main", scope: "workspace" },
    } }]));
    assert.match(out, /"scanned":9/);
    assert.match(out, /"confidence":0.9/);
    for (const m of ["zzskillnamezz", "zz skill title zz", "zzskillwszz", "zzskillownerzz"]) assert.ok(!out.includes(m), m);
  });

  it("episodes-rebuild, gc-run, embedding-drain and meta-reflect results lose messages, paths and topics", T, () => {
    const out = JSON.stringify([
      summarizeJobResultForLog({ job: "episodes-rebuild", rebuilt: 2, errors: ["ep-1: zzepisodeerrzz"] }),
      summarizeJobResultForLog({ ok: true, processed: 1, reportPath: "/Users/x/zzreportzz/gc-report.json", agents: [{ agentId: "main", ok: false, error: "zzgcerrzz" }] }),
      summarizeJobResultForLog({ processed: 4, pending: 0, queuePath: "/Users/x/zzqueuezz/embedding-queue.jsonl" }),
      summarizeJobResultForLog({ ok: true, classification: "balanced", sessionId: "agent:main:telegram:acc:direct:555666777", gaps: [{ topic: "zztopiczz", memoryCount: 2, memoryIds: ["m-1"] }] }),
    ]);
    assert.match(out, /"rebuilt":2/);
    assert.match(out, /"processed":4/);
    assert.match(out, /"classification":"balanced"/);
    assert.match(out, /"memoryCount":2/);
    for (const m of ["zzepisodeerrzz", "zzreportzz", "zzgcerrzz", "zzqueuezz", "zztopiczz", "555666777"]) assert.ok(!out.includes(m), m);
  });
});

describe("other log lines found by the audit", () => {
  it("recall query refinement logs length and hash of both queries", T, async () => {
    const MARK = "zzrecallqueryzz";
    const { calls, logger } = captureLogger();
    const table = {
      vectorSearch() { return { limit() { return { async toArray() { return []; } }; } }; },
      query() { return { where() { return this; }, limit() { return this; }, async toArray() { return []; } }; },
    };
    await runRecallPipeline({
      agentId: "agent-a",
      query: `was ist ${MARK}`,
      dbTable: table,
      embeddings: makeEmbeddings(),
      queryRefinerEnabled: true,
      topN: 5,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      dedupEnabled: false,
      logger,
    });
    const all = dump(calls);
    assert.match(all, /query refinement triggered "textLen=\d+ sha=[0-9a-f]{12}" → "textLen=\d+ sha=[0-9a-f]{12}"/);
    assert.ok(!all.includes(MARK), `query leaked:\n${all}`);
  });

  it("group reasoning filter logs a hashed peer, not the session key", T, () => {
    const { calls, logger } = captureLogger();
    const filter = createGroupReasoningFilter({ logger });
    const res = filter(
      { isGroup: true, body: "🧠 thinking about it" },
      { agentId: "main", sessionKey: "agent:main:telegram:acc1:group:-1001234567890" },
    );
    assert.deepEqual(res, { handled: true });
    const all = dump(calls);
    assert.match(all, /agent=main channel=telegram kind=group peer=[0-9a-f]{12}/);
    assert.ok(!all.includes("1001234567890"), `peer leaked:\n${all}`);
  });

  it("chat-model session release failure logs the hashed key and error class", T, async () => {
    const { calls, logger } = captureLogger();
    const sessionKey = "agent:main:telegram:acc1:direct:555444333";
    const api = {
      logger,
      runtime: {
        config: { async mutateConfigFile({ mutate }) { return mutate({}); } },
        agent: {
          session: {
            listSessionEntries: () => [{ sessionKey, entry: { id: "a", modelOverride: "x" } }],
            async patchSessionEntry() { throw new Error("patch failed for zzpatchmarkerzz"); },
          },
        },
      },
    };
    const modelSession = { applyModelOverrideToSessionEntry: () => ({ updated: true }) };
    const mutator = createChatModelMutator({ api, loadModelSession: async () => modelSession });
    await mutator({ agentId: "main", model: "anthropic/claude-opus-5-5" }).catch(() => {});
    const all = dump(calls);
    assert.match(all, /could not release session agent=main channel=telegram kind=direct peer=[0-9a-f]{12}: Error textLen=\d+ sha=[0-9a-f]{12}/);
    assert.ok(!all.includes("555444333") && !all.includes("zzpatchmarkerzz"), `leaked:\n${all}`);
  });
});
