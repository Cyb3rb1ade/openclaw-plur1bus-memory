// 7.21.3: owner direct chat for background turns, Neo prelude budget on the
// warm path, short embedding text for over-long automatic-recall queries.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildContextPolicy, isOwnerDirectChat, isSubagentCompletionTurn } from "../lib/recall-context.js";
import { AUTO_RECALL_EMBED_MAX_CHARS, shortenAutoRecallQuery } from "../lib/embedding-text.js";
import { neoPreludeBudgetMs as fromAssembler } from "../engine/recall/assemble-prompt-context.js";
import { neoPreludeBudgetMs } from "../engine/recall/neo-prelude.js";
import { createWarmRecallPath } from "../engine/recall/warm-recall-path.js";
import { autoRecallParams } from "../engine/recall/recall-params.js";

const DM = "agent:bernhardine:telegram:bernhardine:direct:1211667028";
const OWNERS = { bernhardine: ["telegram:1211667028"] };

describe("7.21.3 owner direct chat for background turns", () => {
  it("counts a background turn in the owner's DM without a proved sender", () => {
    assert.equal(isOwnerDirectChat({ sessionKey: DM, agentId: "bernhardine", owners: OWNERS, backgroundTurn: true }), true);
  });

  it("keeps the proved-sender rule for normal turns", () => {
    assert.equal(isOwnerDirectChat({ sessionKey: DM, agentId: "bernhardine", owners: OWNERS }), false);
    assert.equal(isOwnerDirectChat({ sessionKey: DM, agentId: "bernhardine", owners: OWNERS, userPrincipal: "telegram:1211667028" }), true);
  });

  it("never applies to other peers, groups or unknown chats", () => {
    const base = { agentId: "bernhardine", owners: OWNERS, backgroundTurn: true };
    assert.equal(isOwnerDirectChat({ ...base, sessionKey: "agent:bernhardine:telegram:bernhardine:direct:999" }), false);
    assert.equal(isOwnerDirectChat({ ...base, sessionKey: "agent:bernhardine:telegram:bernhardine:group:-1003839640481" }), false);
    assert.equal(isOwnerDirectChat({ ...base, sessionKey: "agent:bernhardine:cron:job-1" }), false);
  });

  it("falls back to the single allowFrom entry of the host account", () => {
    const hostConfig = { channels: { telegram: { accounts: { bernhardine: { allowFrom: ["1211667028"] } } } } };
    assert.equal(isOwnerDirectChat({ sessionKey: DM, agentId: "bernhardine", hostConfig, backgroundTurn: true }), true);
  });

  it("recognizes subagent completions, not sessions_send", () => {
    const ctx = (inputProvenance) => ({ inputProvenance });
    assert.equal(isSubagentCompletionTurn({}, ctx({ kind: "inter_session", sourceTool: "subagent_announce" })), true);
    assert.equal(isSubagentCompletionTurn({}, ctx({ kind: "inter_session", sourceTool: "subagent_settle" })), true);
    assert.equal(isSubagentCompletionTurn({ inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" } }, {}), true);
    assert.equal(isSubagentCompletionTurn({}, ctx({ kind: "inter_session", sourceTool: "sessions_send" })), false);
    assert.equal(isSubagentCompletionTurn({}, ctx({ kind: "external_user" })), false);
    assert.equal(isSubagentCompletionTurn({}, {}), false);
  });

  it("buildContextPolicy passes the background flag through", () => {
    const args = { contextWeightingCfg: { enabled: true }, sessionKey: DM, memoryCtx: {}, agentId: "bernhardine", owners: OWNERS };
    const bg = buildContextPolicy({ ...args, backgroundTurn: true });
    assert.equal(bg.request.ownerDirect, true);
    assert.equal(bg.request.backgroundTurn, true);
    const normal = buildContextPolicy(args);
    assert.equal(normal.request.ownerDirect, false);
    assert.equal(normal.request.backgroundTurn, false);
  });
});

describe("7.21.3 short embedding text for long automatic-recall queries", () => {
  it("leaves short text unchanged", () => {
    assert.equal(shortenAutoRecallQuery("kurz"), "kurz");
    const exact = "x".repeat(AUTO_RECALL_EMBED_MAX_CHARS);
    assert.equal(shortenAutoRecallQuery(exact), exact);
  });

  it("keeps head and tail within the limit", () => {
    const text = `ANFANG ${"a".repeat(20_000)} MITTE ${"b".repeat(15_000)} ENDE`;
    const out = shortenAutoRecallQuery(text);
    assert.ok(out.length <= AUTO_RECALL_EMBED_MAX_CHARS, `length ${out.length}`);
    assert.ok(out.startsWith("ANFANG "));
    assert.ok(out.endsWith(" ENDE"));
    assert.ok(!out.includes("MITTE"));
    assert.ok(out.includes("\n…\n"));
  });

  it("does not split surrogate pairs", () => {
    const text = "😀".repeat(5_000);
    const out = shortenAutoRecallQuery(text, 1_000);
    assert.ok(out.length <= 1_000);
    assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    assert.doesNotMatch(out, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("autoRecallParams hands the pipeline the shortened text (no LLM summary above 20 000 chars)", () => {
    const query = "q".repeat(36_693);
    const params = autoRecallParams({
      embeddingCleanTextCfg: { enabled: false },
      resolveRuntimeRecallBudget: () => ({}),
      rerankerCfg: {},
      host: { logger: {} },
    }, { query });
    assert.ok(params.embeddingQuery.length <= AUTO_RECALL_EMBED_MAX_CHARS);
  });
});

describe("7.21.3 Neo prelude budget on the warm path", () => {
  it("is the same helper in both modules", () => {
    assert.equal(fromAssembler, neoPreludeBudgetMs);
    assert.equal(neoPreludeBudgetMs(12_000, 4_000), 3_000);
  });

  it("stops waiting for a slow Neo embedding at the prelude budget", async () => {
    const NEO_EMBED_TIMEOUT = Symbol("timeout");
    const warm = createWarmRecallPath({
      NEO_EMBED_TIMEOUT,
      cfg: {},
      embeddingCleanTextCfg: { enabled: false },
      embeddings: { embedQuery: () => new Promise(() => {}) },
      host: { logger: { debug() {}, info() {}, warn() {} } },
      neoEnabled: true,
      neoGlobalRecall: { embedTimeoutMs: 5_000 },
      neoPromptRecall: {},
      neoRequester: () => ({ requesterAgentId: "main" }),
      neoWorkerRuntime: null,
      peekNeoStore: () => ({ readCandidates: () => [] }),
      pool: null,
      runMergedNamespaceRecall: async () => ({}),
      runNeoGlobalSearch: async () => [],
      runtimeScheduler: { config: { recallTimeoutMs: 1_000 } },
      sharedMemoryPool: null,
      workspacePolicyGuard: { automatic: () => ({ allowed: true }) },
    });
    const startedAt = Date.now();
    // An aborted signal ends the run right after the prelude (AbortError).
    await assert.rejects(() => warm({ prompt: "Wie war das Treffen gestern?" }, { agentId: "main", sessionKey: "agent:main:main" }, {
      signal: AbortSignal.abort(),
      memoryCtx: { agentId: "main" },
      timer: { end() {} },
    }), { name: "AbortError" });
    const elapsed = Date.now() - startedAt;
    // Budget = min(5 000, max(250, 1 000 / 4)) = 250 ms; without it 5 000 ms.
    assert.ok(elapsed < 2_000, `warm prelude waited ${elapsed} ms`);
  });
});
