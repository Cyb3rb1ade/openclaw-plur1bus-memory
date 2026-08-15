/**
 * Release 7.3.1 REM follow-up regressions.
 *
 * These are end-to-end runRemDream checks for candidate-query failure handling
 * and for keeping analysis alive when optional narrative sinks are absent.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildRemPartition,
  getPreviousWeekWindow,
  runRemDream,
} from "../lib/dreaming/rem-dream.js";

const AGENT = "release731-followup-agent";
const USER = `user:v1:${"f".repeat(64)}`;
const WORKSPACE = "workspace:v1:release731-followup";
const REQUEST_CONTEXT = Object.freeze({
  agentId: AGENT,
  workspaceIdentity: WORKSPACE,
  userPrincipal: USER,
  workspaceAliases: Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) }),
});
const WEEK_START = getPreviousWeekWindow().startMs;
const ROW_TIME = WEEK_START + 60 * 60 * 1000;

function row(id, text) {
  return {
    id,
    text,
    summary: text,
    vector: [1, 0],
    createdAt: ROW_TIME,
    sourceTimestamp: ROW_TIME,
    status: "active",
    epistemicStatus: "",
    memoryClass: "standard",
    scope: "agent-private",
    agentId: AGENT,
    storedBy: AGENT,
    workspaceId: "",
    workspaceKey: "",
    ownerUserId: "",
  };
}

function fieldsFor(rows) {
  return [...new Set(rows.flatMap((item) => Object.keys(item)))].map((name) => ({ name }));
}

function dbFor(rows, { vectorSearch = null, counters = {} } = {}) {
  return {
    async store() {
      counters.dreamStore = (counters.dreamStore || 0) + 1;
    },
    table: {
      async schema() {
        return { fields: fieldsFor(rows) };
      },
      query() {
        const state = { offset: 0, limit: rows.length };
        const builder = {
          where() {
            state.filtered = true;
            return builder;
          },
          offset(value) {
            state.offset = value;
            return builder;
          },
          limit(value) {
            state.limit = value;
            return builder;
          },
          async toArray() {
            return rows.slice(state.offset, state.offset + state.limit);
          },
        };
        return builder;
      },
      vectorSearch(vector) {
        counters.vectorSearch = (counters.vectorSearch || 0) + 1;
        if (typeof vectorSearch === "function") return vectorSearch(vector);
        return {
          limit() {
            return {
              async toArray() {
                return rows.map((item) => ({ ...item, _distance: 0 }));
              },
            };
          },
        };
      },
    },
  };
}

function makeSink(partition, workspaceDir, state, counters) {
  const neoStore = {
    aclBindings: partition,
    paths: { workspaceDir },
    async hasCompletedRun() {
      counters.hasCompletedRun = (counters.hasCompletedRun || 0) + 1;
      return state.completed;
    },
    async readPatterns() {
      counters.readPatterns = (counters.readPatterns || 0) + 1;
      return [];
    },
    async appendPatterns(patterns) {
      counters.appendPatterns = (counters.appendPatterns || 0) + 1;
      counters.patterns = patterns;
    },
    async markRunCompleted() {
      counters.markRunCompleted = (counters.markRunCompleted || 0) + 1;
      state.completed = true;
    },
  };
  return { aclBindings: partition, neoStore };
}

function baseArgs({ db, partition, sink, callLlm, workspaceDir, narrativeCfg = { enabled: false }, logger = {}, embeddings = null }) {
  return {
    db,
    patternLlmCfg: {},
    narrativeLlmCfg: {},
    echoLlmCfg: {},
    callLlm,
    partitionSink: sink,
    workspaceKey: WORKSPACE,
    agentId: AGENT,
    requestContext: REQUEST_CONTEXT,
    aclPartition: partition,
    workspaceDir,
    narrativeCfg,
    logger,
    embeddings,
    force: false,
  };
}

test("REM vectorSearch failure aborts the run with zero side effects and leaves retry possible", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "release731-rem-vector-failure-"));
  try {
    const partition = buildRemPartition({
      scope: "agent-private", agentId: AGENT, workspaceIdentity: "", ownerUserId: "",
    }, REQUEST_CONTEXT);
    const state = { completed: false };
    const counters = {};
    const rows = [0, 1, 2].map((id) => row(`private-${id}`, `private vector failure ${id}`));
    let llmCalls = 0;
    const failed = await runRemDream(baseArgs({
      db: dbFor(rows, {
        counters,
        vectorSearch() {
          return {
            limit() {
              return {
                async toArray() {
                  throw new Error("vector query unavailable");
                },
              };
            },
          };
        },
      }),
      partition,
      sink: makeSink(partition, workspaceDir, state, counters),
      workspaceDir,
      logger: { debug() {}, info() {}, warn() {} },
      callLlm: async () => {
        llmCalls += 1;
        return JSON.stringify({ patternName: "must not run" });
      },
    }));

    assert.equal(failed.skipped, true);
    assert.equal(failed.reason, "candidate_read_failed");
    assert.equal(llmCalls, 0);
    assert.equal(counters.readPatterns || 0, 0);
    assert.equal(counters.appendPatterns || 0, 0);
    assert.equal(counters.markRunCompleted || 0, 0);
    assert.equal(counters.dreamStore || 0, 0);
    assert.equal(state.completed, false);
    assert.equal(existsSync(join(workspaceDir, "locks", `rem-${getPreviousWeekWindow().weekOf}-${partition.key}.lock`)), false);

    const retryCounters = {};
    const retry = await runRemDream(baseArgs({
      db: dbFor(rows, { counters: retryCounters }),
      partition,
      sink: makeSink(partition, workspaceDir, state, retryCounters),
      workspaceDir,
      callLlm: async () => JSON.stringify({
        patternName: "Retry pattern",
        description: "The retry can analyze the same private material.",
        trend: "neu",
        relatedTopics: ["retry"],
        confidence: 0.9,
      }),
    }));

    assert.ok(retry.report, JSON.stringify(retry));
    assert.equal(retry.report.patternsFound, 1);
    assert.equal(state.completed, true);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("REM analysis completes when narrative memory persistence has no optional bound sink", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "release731-rem-optional-sink-"));
  try {
    const partition = buildRemPartition({
      scope: "agent-private", agentId: AGENT, workspaceIdentity: "", ownerUserId: "",
    }, REQUEST_CONTEXT);
    const state = { completed: false };
    const counters = {};
    const rows = [0, 1, 2].map((id) => row(`private-${id}`, `private analytical material ${id}`));
    const warnings = [];
    let llmCalls = 0;
    let embedCalls = 0;
    const result = await runRemDream(baseArgs({
      db: dbFor(rows, { counters }),
      partition,
      sink: makeSink(partition, workspaceDir, state, counters),
      workspaceDir,
      narrativeCfg: { enabled: true, storeAsMemory: true },
      logger: { debug() {}, info() {}, warn(message) { warnings.push(message); } },
      embeddings: { embed: async () => { embedCalls += 1; return [1, 0]; } },
      callLlm: async () => {
        llmCalls += 1;
        if (llmCalls === 1) {
          return JSON.stringify({
            patternName: "Private analytical pattern",
            description: "Repeated private material remains analyzable.",
            trend: "neu",
            relatedTopics: ["analysis"],
            confidence: 0.9,
          });
        }
        return "A sufficiently long private REM narrative is generated without a memory sink.";
      },
    }));

    assert.ok(result.report, JSON.stringify(result));
    assert.equal(result.report.patternsFound, 1);
    assert.ok(result.report.narrative);
    assert.deepEqual(result.report.narrativeMemoryPersistence, {
      requested: true,
      enabled: false,
      reason: "missing_bound_memory_store",
    });
    assert.equal(counters.appendPatterns, 1);
    assert.equal(counters.markRunCompleted, 1);
    assert.equal(counters.dreamStore || 0, 0);
    assert.equal(embedCalls, 0);
    assert.equal(state.completed, true);
    assert.ok(warnings.some((message) => message.includes("narrative memory persistence disabled")));
    assert.equal(readdirSync(workspaceDir).length, 1, "only the lock directory may have existed during the run");
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
