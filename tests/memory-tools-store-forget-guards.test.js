/**
 * tests/memory-tools-store-forget-guards.test.js
 *
 * Engine audit "memory-tools" (20.10.2026), findings 1-4:
 *  1. memory_store: ttl together with importance >= 0.95 (core band) was dropped
 *     silently, the memory became permanent. Now an explicit rejection.
 *  2. memory_forget(query): a single, unrelated hit was archived and tombstoned
 *     because `1 / (1 + d)` never falls below forgetThreshold 0.3. Now a single
 *     hit is only forgotten by query when it is similar enough, else it is listed.
 *  3. merging.autoApply: the merge replacement took the new call's expiresAt, so a
 *     permanent memory expired after a ttl store. Permanence (0) now wins.
 *  4. memory_store rejects blank text and unknown categories; ttl is resolved by
 *     own property of the ttl table ("constructor" is not a ttl). Unknown ttl names
 *     such as "week" stay ignored (permanent), as before: tests/memory-store-merge-archive-first.test.js relies on it.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import plugin, { MemoryDB } from "../index.js";
import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createStubHost } from "../lib/host-services.js";
import { MEMORY_CATEGORIES } from "../lib/categorize.js";
import { mergedExpiresAt } from "../lib/memory-dynamics.js";
import { resolveTtlMs, validateMemoryStoreParams } from "../lib/input-limits.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const VECTOR_DIM = 384;
const TTL_MAP = { session: 86_400_000, short: 14 * 86_400_000 };

/** Unit vector `cos * e0 + sqrt(1 - cos^2) * e1`: cosine `cos` to e0, L2 distance^2 = 2 - 2 cos. */
function unit(cos = 1) {
  const v = Array(VECTOR_DIM).fill(0);
  v[0] = cos;
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}

/** A vector on its own axis: orthogonal to unit() and to every other axis. */
function axis(i) {
  const v = Array(VECTOR_DIM).fill(0);
  v[i] = 1;
  return v;
}

function makeMockApi(baseDbPath, overrides = {}) {
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      merging: { enabled: false },
      duplicateThreshold: 0.9999,
      obsidianBridge: { enabled: false },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      gc: { enabled: false },
      emotion: { t3: { enabled: false } },
      ...overrides,
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (p) => p,
    registerCommand: noop,
    registerTool(factory) { this._toolFactory = factory; },
    on: noop,
    registerService: noop,
  };
}

describe("memory-tools store/forget guards (engine audit memory-tools)", () => {
  let basePath;
  let workspaceDir;
  let openclawHome;
  let originalHome;
  let originalPassage;
  let originalQuery;
  let originalCreate;
  let seq = 0;
  let passageVector = unit(1);
  let queryVector = unit(1);

  before(() => {
    basePath = makeTempDir("plur1bus-mt-guards-");
    workspaceDir = makeTempDir("plur1bus-mt-guards-ws-");
    originalHome = process.env.OPENCLAW_HOME;
    openclawHome = makeTempDir("plur1bus-mt-guards-home-");
    process.env.OPENCLAW_HOME = openclawHome;
    mkdirSync(join(openclawHome, ".openclaw", "memory", "_archive"), { recursive: true });
    originalPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    originalQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    originalCreate = OpenAI.Chat.Completions.prototype.create;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => passageVector;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => queryVector;
  });

  after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalPassage;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = originalQuery;
    OpenAI.Chat.Completions.prototype.create = originalCreate;
    if (originalHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalHome;
    for (const d of [basePath, workspaceDir, openclawHome]) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  function tool(name, agentId, overrides) {
    const api = makeMockApi(basePath, overrides);
    plugin.register(api);
    const found = api._toolFactory({ agentId, workspaceDir }).find((t) => t.name === name);
    assert.ok(found, `${name} registered`);
    return found;
  }

  async function rowsOf(agentId) {
    const db = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await db.init();
    try {
      return (await db.table.query().toArray()).filter((r) => r.id !== "__schema__");
    } finally {
      await db.shutdown();
    }
  }

  async function seed(agentId, row) {
    const db = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await db.init();
    await db.store({
      text: "seed",
      summary: "seed",
      origin: "dm",
      importance: 0.6,
      category: "fact",
      createdAt: Date.now(),
      storedBy: agentId,
      workspaceKey: workspaceDir,
      scope: "agent-private",
      status: "active",
      ...row,
    });
    await db.shutdown();
  }

  const nextAgent = (prefix) => `${prefix}${++seq}`;

  describe("1. ttl with importance >= 0.95", () => {
    it("rejects the combination instead of dropping the ttl silently", async () => {
      const agentId = nextAgent("ttlcore");
      passageVector = axis(10);
      const store = tool("memory_store", agentId);
      for (const importance of [0.95, 0.97, 1]) {
        const result = await store.execute("c", { text: `Schluessel liegt beim Nachbarn ${importance}`, ttl: "session", importance });
        assert.equal(result.details?.action, "rejected", JSON.stringify(result));
        assert.equal(result.details?.reason, "ttl_conflicts_with_core_importance");
        assert.match(result.content[0].text, /ttl/i);
        assert.match(result.content[0].text, /0\.95/);
      }
      assert.equal((await rowsOf(agentId)).length, 0, "nothing may be stored");
    });

    it("keeps the legitimate cases: ttl below the band, and the core band without ttl", async () => {
      const agentId = nextAgent("ttlok");
      const store = tool("memory_store", agentId);

      passageVector = axis(11);
      const short = await store.execute("c", { text: "Paket kommt Freitag", ttl: "short", importance: 0.9 });
      assert.equal(short.details?.action, "stored", JSON.stringify(short));
      passageVector = axis(12);
      const permanent = await store.execute("c", { text: "Wichtige Regel: nie loeschen", importance: 1 });
      assert.equal(permanent.details?.action, "stored", JSON.stringify(permanent));
      passageVector = axis(13);
      const band = await store.execute("c", { text: "Agent-Band ohne ttl", importance: 0.95 });
      assert.equal(band.details?.action, "stored", JSON.stringify(band));

      const rows = await rowsOf(agentId);
      const byId = (id) => rows.find((r) => r.id === id);
      const shortRow = byId(short.details.id);
      assert.ok(Number(shortRow.expiresAt) > Date.now() + 13 * 86_400_000, "ttl short is honoured");
      assert.equal(Number(byId(permanent.details.id).expiresAt), 0);
      assert.equal(Number(byId(permanent.details.id).neverForget), 1);
      assert.equal(Number(byId(band.details.id).expiresAt), 0);
    });
  });

  describe("2. memory_forget by query", () => {
    it("lists a single unrelated hit instead of forgetting it", async () => {
      const agentId = nextAgent("forgetunrel");
      await seed(agentId, { id: "11111111-1111-4111-8111-111111111111", text: "Lieblingskaffee: ohne Zucker", summary: "Kaffee", vector: unit(1) });
      queryVector = axis(5); // orthogonal: 1 / (1 + 2) = 0.33 >= forgetThreshold 0.3, the old code deleted it
      const result = await tool("memory_forget", agentId).execute("c", { query: "Zahnarzttermin" });
      const text = result.content[0].text;
      assert.doesNotMatch(text, /^Forgotten/, text);
      assert.match(text, /11111111-1111-4111-8111-111111111111/, "candidate id is offered");
      assert.match(text, /memoryId/);
      const rows = await rowsOf(agentId);
      assert.equal(rows.find((r) => r.id === "11111111-1111-4111-8111-111111111111").status, "active");
    });

    it("still forgets a single, clearly matching hit (identical and close paraphrase)", async () => {
      for (const [label, cos] of [["identical", 1], ["close", 0.95]]) {
        const agentId = nextAgent(`forgetmatch${label}`);
        const id = `22222222-2222-4222-8222-22222222222${cos === 1 ? "1" : "2"}`;
        await seed(agentId, { id, text: `Lieblingskaffee ohne Zucker (${label})`, summary: "Kaffee", vector: unit(1) });
        queryVector = unit(cos);
        const result = await tool("memory_forget", agentId).execute("c", { query: "Kaffee ohne Zucker" });
        assert.match(result.content[0].text, /^Forgotten:/, result.content[0].text);
        const row = (await rowsOf(agentId)).find((r) => r.id === id);
        assert.equal(row.status, "deleted");
      }
    });

    it("keeps forgetting by memoryId regardless of similarity", async () => {
      const agentId = nextAgent("forgetbyid");
      const id = "33333333-3333-4333-8333-333333333333";
      await seed(agentId, { id, text: "Zu vergessende Erinnerung", summary: "x", vector: unit(1) });
      const result = await tool("memory_forget", agentId).execute("c", { memoryId: id });
      assert.match(result.content[0].text, /forgotten \(tombstoned\)/);
      assert.equal((await rowsOf(agentId)).find((r) => r.id === id).status, "deleted");
    });
  });

  describe("3. merge keeps permanence", () => {
    it("mergedExpiresAt: 0 (permanent) wins, otherwise the later expiry", () => {
      assert.equal(mergedExpiresAt(0, Date.now() + 1000), 0);
      assert.equal(mergedExpiresAt(Date.now() + 1000, 0), 0);
      assert.equal(mergedExpiresAt(undefined, 5000), 0);
      assert.equal(mergedExpiresAt(0, 0), 0);
      assert.equal(mergedExpiresAt(5000, 9000), 9000);
      assert.equal(mergedExpiresAt(9000, 5000), 9000);
    });

    async function mergeWith(candidateExpiresAt, ttl) {
      const agentId = nextAgent("mergeexp");
      OpenAI.Chat.Completions.prototype.create = async () => ({
        choices: [{ message: { content: JSON.stringify({ merge: true, reason: "t", mergedText: "Original fact about cats and additional detail" }) } }],
      });
      passageVector = unit(0.9); // close to the candidate (score 0.83): a merge candidate, no duplicate
      await seed(agentId, {
        id: "44444444-4444-4444-8444-444444444444",
        text: "Original fact about cats",
        summary: "cats",
        vector: unit(1),
        expiresAt: candidateExpiresAt,
      });
      const store = tool("memory_store", agentId, {
        merging: { enabled: true, autoApply: true, model: "mock-model", apiKey: "sk-test" },
      });
      const result = await store.execute("c", { text: "Additional cat fact", category: "fact", ttl });
      assert.equal(result.details?.action, "merged", JSON.stringify(result));
      const rows = await rowsOf(agentId);
      return rows.find((r) => r.id === result.details.id);
    }

    it("a permanent candidate stays permanent when the new call carries a ttl", async () => {
      const merged = await mergeWith(0, "session");
      assert.equal(Number(merged.expiresAt), 0);
    });

    it("two finite expiries: the later one is kept", async () => {
      const later = Date.now() + 10 * 86_400_000;
      const merged = await mergeWith(later, "session");
      assert.equal(Number(merged.expiresAt), later);
    });
  });

  describe("4. input validation", () => {
    it("validateMemoryStoreParams: blank text and unknown category are rejected", () => {
      const lookup = { categories: MEMORY_CATEGORIES };
      for (const text of ["", "   ", "\n\t", undefined, null, 42]) {
        const r = validateMemoryStoreParams({ text }, lookup);
        assert.equal(r.ok, false, String(text));
        assert.equal(r.reason, "invalid_text");
      }
      const bad = validateMemoryStoreParams({ text: "x", category: "bogus" }, lookup);
      assert.equal(bad.ok, false);
      assert.equal(bad.reason, "invalid_category");
      assert.equal(validateMemoryStoreParams({ text: "x", category: ["fact"] }, lookup).ok, false);
    });

    it("validateMemoryStoreParams: every legitimate input stays valid", () => {
      const lookup = { categories: MEMORY_CATEGORIES };
      assert.equal(validateMemoryStoreParams({ text: "x" }, lookup).ok, true);
      assert.equal(validateMemoryStoreParams({ text: "x", category: "", ttl: "short" }, lookup).ok, true);
      assert.equal(validateMemoryStoreParams({ text: "x", category: null }, lookup).ok, true);
      for (const category of MEMORY_CATEGORIES) assert.equal(validateMemoryStoreParams({ text: "x", category }, lookup).ok, true);
    });

    it("resolveTtlMs: own properties only, everything else is permanent (0)", () => {
      for (const ttl of Object.keys(TTL_MAP)) assert.equal(resolveTtlMs(TTL_MAP, ttl), TTL_MAP[ttl]);
      for (const ttl of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "week", "", undefined, null, 7, {}]) {
        assert.equal(resolveTtlMs(TTL_MAP, ttl), 0, String(ttl));
      }
    });

    it("memory_store: a ttl named like an Object.prototype member does not become a bogus expiry", async () => {
      const agentId = nextAgent("ttlproto");
      const store = tool("memory_store", agentId);
      for (const [i, ttl] of ["constructor", "toString", "__proto__"].entries()) {
        passageVector = axis(40 + i);
        const result = await store.execute("c", { text: `ttl prototype name ${ttl}`, ttl });
        assert.equal(result.details?.action, "stored", JSON.stringify(result));
        const row = (await rowsOf(agentId)).find((r) => r.id === result.details.id);
        assert.equal(Number(row.expiresAt), 0, `${ttl} must not produce an expiry`);
      }
    });

    it("memory_store rejects blank text and an unknown category, stores nothing", async () => {
      const agentId = nextAgent("validate");
      passageVector = axis(20);
      const store = tool("memory_store", agentId);
      const cases = [
        [{ text: "" }, "invalid_text"],
        [{ text: "   \n" }, "invalid_text"],
        [{ text: "unknown category", category: "bogus" }, "invalid_category"],
      ];
      for (const [params, reason] of cases) {
        const result = await store.execute("c", params);
        assert.equal(result.details?.action, "rejected", JSON.stringify(result));
        assert.equal(result.details?.reason, reason);
      }
      assert.equal((await rowsOf(agentId)).length, 0);
      // legitimate neighbours
      const ok = await store.execute("c", { text: "Eine gueltige Erinnerung", category: "decision", ttl: "short" });
      assert.equal(ok.details?.action, "stored", JSON.stringify(ok));
    });

    it("storeMemoryFromToolParams (create-engine twin) applies the same guards", async () => {
      const vector = () => axis(30);
      const one = async () => vector();
      const embeddings = { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (t) => t.map(vector), shutdown: async () => {} };
      const host = createStubHost({ stateDir: makeTempDir("mt-guards-engine-state-") });
      const engine = createEngine(host, {
        baseDbPath: join(makeTempDir("mt-guards-engine-root-"), "lancedb-namespaced"),
        embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
        autoCapture: false, autoRecall: false,
        neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
        merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
        temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
        runtime: { recallTimeoutMs: 10_000 },
        duplicateThreshold: 0.9999,
      }, { internals: { embeddings } });
      const { storeMemoryFromToolParams } = internalsOf(engine);
      try {
        assert.match((await storeMemoryFromToolParams({ agentId: "agent-a" }, { text: "  " })).error, /memory text/);
        assert.match((await storeMemoryFromToolParams({ agentId: "agent-a" }, { text: "a", category: "bogus" })).error, /category/);
        const core = await storeMemoryFromToolParams({ agentId: "agent-a" }, { text: "core with ttl", ttl: "session", importance: 0.96 });
        assert.equal(core.details?.action, "rejected", JSON.stringify(core));
        const ok = await storeMemoryFromToolParams({ agentId: "agent-a" }, { text: "fine", category: "fact", ttl: "short" });
        assert.equal(ok.details?.action, "stored", JSON.stringify(ok));
      } finally {
        await engine.close({ budgetMs: 5_000 });
      }
    });
  });
});
