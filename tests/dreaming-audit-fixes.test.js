/**
 * tests/dreaming-audit-fixes.test.js
 *
 * Dreaming-Audit 20.10.2026 (F1-F5, F8). Jeder Test war vor dem Fix rot.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as lancedb from "@lancedb/lancedb";

import {
  analyzeTrends,
  buildRemPartition,
  buildSparseNeighborGraph,
  findConnectedComponents,
  getPreviousWeekWindow,
  getWeekWindow,
  loadCandidateMemories,
  persistRemDreamToVault,
  runRemDream,
  selectActiveLastWeekPatterns,
} from "../lib/dreaming/rem-dream.js";
import { lightDream } from "../lib/dreaming/light-dream.js";
import { storeDreamAsMemory } from "../lib/dreaming/dream-narrative.js";
import { createNeoStore } from "../lib/neo-arch.js";
import { writeConsolidationReport } from "../lib/jobs/consolidation-report.js";
import {
  checkMaxPromotions,
  readPromotedKnowledgeIds,
  recordKnowledgePromotion,
} from "../lib/jobs/schicht15-tracker.js";
import { atomicJsonUpdate } from "../lib/atomic-json.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const DAY = 86_400_000;

// ─── F1: REM-Nachbarsuche ──────────────────────────────────────────────────

const F1_AGENT = "f1-agent";
const F1_CTX = Object.freeze({
  agentId: F1_AGENT,
  workspaceIdentity: "workspace:v1:canonical-a",
  workspaceAliases: Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([{ alias: "workspace-a", workspaceKey: "canonical-a" }]) }),
});

function unit(dim, hot, amount) {
  const v = Array(dim).fill(0);
  v[0] = 1;
  if (hot > 0) v[hot] = amount;
  return v;
}

function f1Row(id, vector, overrides = {}) {
  const now = Date.now();
  return {
    id,
    text: `Erinnerung ${id}`,
    summary: "",
    vector,
    status: "active",
    category: "project_fact",
    memoryClass: "standard",
    createdAt: now - DAY,
    sourceTimestamp: now - DAY,
    workspaceId: "",
    workspaceKey: "",
    agentId: F1_AGENT,
    storedBy: F1_AGENT,
    scope: "agent-private",
    ownerUserId: "",
    ...overrides,
  };
}

/**
 * Vier eigene Kandidaten (paarweise Kosinus 0.96, Abstand 0.28) und 30 fremde
 * Zeilen EXAKT auf dem gemeinsamen Zentrum (Abstand 0.2 zu jedem eigenen):
 * ohne Filter belegen die fremden Zeilen alle topK-Plätze.
 */
async function f1Table(t) {
  const dir = makeTempDir("rem-f1-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rows = [];
  for (let i = 1; i <= 4; i += 1) rows.push(f1Row(`00000000-0000-4000-8000-00000000000${i}`, unit(8, i, 0.2)));
  for (let i = 0; i < 30; i += 1) {
    const kind = i % 2 === 0 ? "other-agent" : "old-week";
    rows.push(f1Row(`11111111-0000-4000-8000-${String(i).padStart(12, "0")}`, unit(8, 0, 0), kind === "other-agent"
      ? { agentId: "someone-else", storedBy: "someone-else" }
      : { createdAt: Date.now() - 60 * DAY, sourceTimestamp: Date.now() - 60 * DAY }));
  }
  const db = await lancedb.connect(dir);
  return db.createTable("memories", rows);
}

describe("F1: REM-Nachbarsuche wird nicht von fremden Zeilen verdrängt", () => {
  it("ohne where-Option lädt sie nach, bis topK gültige Nachbarn vorliegen", async (t) => {
    const table = await f1Table(t);
    const partition = buildRemPartition({ scope: "agent-private", agentId: F1_AGENT, workspaceIdentity: "", ownerUserId: "" }, F1_CTX);
    const memories = await loadCandidateMemories({ table }, { weekStartMs: Date.now() - 7 * DAY, requestContext: F1_CTX, aclPartition: partition });
    assert.equal(memories.length, 4);
    const edges = await buildSparseNeighborGraph(memories, table, { topK: 5, requestContext: F1_CTX });
    assert.equal(edges.length, 12, "jeder der 4 Kandidaten braucht 3 Nachbarn");
    assert.equal(findConnectedComponents(edges).length, 1);
  });

  it("mit where-Option (Prefilter) liefert die Suche nur Kandidaten", async (t) => {
    const table = await f1Table(t);
    const partition = buildRemPartition({ scope: "agent-private", agentId: F1_AGENT, workspaceIdentity: "", ownerUserId: "" }, F1_CTX);
    const memories = await loadCandidateMemories({ table }, { weekStartMs: Date.now() - 7 * DAY, requestContext: F1_CTX, aclPartition: partition });
    const seen = [];
    const spy = {
      vectorSearch(vector) {
        const search = table.vectorSearch(vector);
        return {
          where(predicate) { seen.push(predicate); return search.where(predicate); },
          limit(n) { seen.push(`limit:${n}`); return search.limit(n); },
        };
      },
    };
    const where = `agentId = 'f1-agent' AND sourceTimestamp >= ${Date.now() - 7 * DAY}`;
    const edges = await buildSparseNeighborGraph(memories, spy, { topK: 5, requestContext: F1_CTX, where });
    assert.equal(edges.length, 12);
    assert.ok(seen.includes(where), "der Prefilter muss an die Vektorsuche gehen");
    assert.ok(!seen.some((s) => /^limit:(?!6$)/.test(s)), `kein Nachladen nötig, wenn der Filter greift: ${seen}`);
  });

  it("runRemDream findet das Muster trotz 30 fremder Zeilen mit besserem Rang", async (t) => {
    const table = await f1Table(t);
    const partition = buildRemPartition({ scope: "agent-private", agentId: F1_AGENT, workspaceIdentity: "", ownerUserId: "" }, F1_CTX);
    const patterns = [];
    const neoStore = {
      aclBindings: partition,
      hasCompletedRun: () => false,
      readPatterns: () => [],
      appendPatterns: (items) => { patterns.push(...items); },
      markRunCompleted() {},
    };
    const result = await runRemDream({
      db: { table },
      callLlm: async () => JSON.stringify({ patternName: "Gruppe", description: "d", trend: "neu", relatedTopics: ["a"], confidence: 0.9 }),
      patternLlmCfg: {},
      neoStore,
      partitionSink: { aclBindings: partition, neoStore },
      workspaceKey: "workspace-a",
      agentId: F1_AGENT,
      requestContext: F1_CTX,
      aclPartition: partition,
      narrativeCfg: { enabled: false },
      topK: 5,
      force: true,
    });
    assert.ok(result.report, JSON.stringify(result));
    assert.equal(result.report.patternsFound, 1);
    assert.equal(patterns[0].memberCount, 4);
  });
});

// ─── F2: "verschwunden" nur einmal ─────────────────────────────────────────

function pat(id, topics, extra = {}) {
  return { id, patternName: id, memberCount: 5, relatedTopics: topics, participants: [], category: "general", trend: "neu", ...extra };
}

describe("F2: verschwundene Patterns werden einmal gemeldet und nicht erneut angehängt", () => {
  it("selectActiveLastWeekPatterns entfernt Duplikate, bereits verschwundene und abgelöste Patterns", () => {
    const stored = [
      pat("old", ["x"]),
      pat("old", ["x"], { trend: "verschwunden", previousPatternId: "old" }),
      pat("a", ["y"]),
      pat("b", ["y"], { trend: "gleich", previousPatternId: "a" }),
      pat("c", ["z"]),
    ];
    assert.deepEqual(selectActiveLastWeekPatterns(stored).map((p) => p.id), ["b", "c"]);
  });

  it("analyzeTrends meldet damit ein verschwundenes Pattern nur in der Woche, in der es verschwindet", () => {
    let store = [pat("stale", ["alt"])];
    const reported = [];
    for (let week = 0; week < 4; week += 1) {
      const fresh = [pat(`w${week}`, ["neu", `t${week}`])];
      const trends = analyzeTrends(fresh, selectActiveLastWeekPatterns(store));
      reported.push(trends.filter((t) => t.trend === "verschwunden").map((t) => t.id));
      store = [...store, ...trends];
    }
    assert.deepEqual(reported[0], ["stale"]);
    assert.ok(!reported.slice(1).flat().includes("stale"), JSON.stringify(reported));
    assert.equal(store.filter((p) => p.id === "stale" && p.trend === "verschwunden").length, 1);
  });

  it("der Neo-Store dedupliziert wiederholte verschwunden-Zeilen derselben ID beim Schreiben und Lesen", (t) => {
    const dir = makeTempDir("neo-f2-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const binding = { scope: "agent-private", agentId: "agent-a" };
    const neo = createNeoStore(dir, "ws-f2");
    const gone = pat("stale", ["alt"], { trend: "verschwunden", previousPatternId: "stale", agentId: "agent-a" });
    neo.appendPatterns([gone], binding);
    neo.appendPatterns([{ ...gone }], binding);
    neo.appendPatterns([{ ...gone }], binding);
    const rows = neo.readPatterns(100).filter((p) => p.id === "stale");
    assert.equal(rows.length, 1);
    const lines = readFileSync(neo.paths.patterns, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "auch auf der Platte nur eine Zeile");
  });

  it("runRemDream hängt ein bereits gemeldetes verschwunden-Pattern im Folgelauf nicht erneut an", async () => {
    const ctx = Object.freeze({
      agentId: "agent-a",
      workspaceIdentity: "workspace:v1:workspace-a",
      workspaceAliases: Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) }),
    });
    const partition = buildRemPartition({ scope: "workspace", agentId: "agent-a", workspaceIdentity: "workspace:v1:workspace-a", ownerUserId: "" }, ctx);
    const now = Date.now();
    const rows = ["1", "2", "3"].map((id) => ({
      id, text: `workspace material ${id}`, summary: "", vector: [1, 0], createdAt: now, sourceTimestamp: now, status: "active",
      scope: "workspace", workspaceKey: "workspace:v1:workspace-a", workspaceId: "workspace:v1:workspace-a",
      agentId: "agent-a", storedBy: "agent-a", ownerUserId: "",
    }));
    const fields = Object.keys(rows[0]).map((name) => ({ name }));
    const db = {
      table: {
        async schema() { return { fields }; },
        query() {
          const st = { offset: 0, limit: rows.length };
          const b = { where() { return b; }, offset(v) { st.offset = v; return b; }, limit(v) { st.limit = v; return b; }, async toArray() { return rows.slice(st.offset, st.offset + st.limit); } };
          return b;
        },
        vectorSearch() { return { limit() { return { async toArray() { return rows.map((r) => ({ ...r, _distance: 0 })); } }; } }; },
      },
    };
    const store = [{
      ...pat("stale", ["voellig-anders"]), aclBindings: partition,
    }];
    const neoStore = {
      aclBindings: partition,
      hasCompletedRun: () => false,
      readPatterns: () => store.map((p) => ({ ...p })),
      appendPatterns: (items) => { store.push(...items.map((p) => ({ ...p }))); },
      markRunCompleted() {},
    };
    const run = () => runRemDream({
      db,
      callLlm: async () => JSON.stringify({ patternName: "Material", description: "d", trend: "neu", relatedTopics: ["material"], confidence: 0.9 }),
      patternLlmCfg: {}, neoStore, partitionSink: { aclBindings: partition, neoStore },
      workspaceKey: "workspace-a", agentId: "agent-a", requestContext: ctx, aclPartition: partition,
      narrativeCfg: { enabled: false }, force: true,
    });
    const first = await run();
    assert.equal(first.report.disappeared, 1);
    const second = await run();
    assert.equal(second.report.disappeared, 0, "bereits gemeldet");
    assert.equal(store.filter((p) => p.id === "stale" && p.trend === "verschwunden").length, 1);
  });
});

// ─── F3: ISO-Wochenschlüssel ───────────────────────────────────────────────

describe("F3: Wochenschlüssel mit ISO-Jahr und Nullauffüllung", () => {
  const key = (iso) => getPreviousWeekWindow(new Date(iso)).weekOf;
  const cur = (iso) => getWeekWindow(new Date(iso)).weekOf;

  it("füllt einstellige Wochen auf (passt zum Format \\d{4}-W\\d{2} des Vault-Writers)", () => {
    assert.equal(key("2026-02-03T12:00:00Z"), "2026-W05");
    assert.match(cur("2026-03-04T12:00:00Z"), /^\d{4}-W\d{2}$/);
  });

  it("nimmt das ISO-Jahr statt des Kalenderjahrs (Jahreswechsel)", () => {
    // 29.12.2025 (Mo) .. 04.01.2026 (So) ist ISO 2026-W01.
    assert.equal(cur("2025-12-31T12:00:00Z"), "2026-W01");
    assert.equal(cur("2026-01-02T12:00:00Z"), "2026-W01");
    assert.equal(key("2026-01-08T12:00:00Z"), "2026-W01");
    // 28.12.2026 .. 03.01.2027 ist ISO 2026-W53.
    assert.equal(cur("2027-01-02T12:00:00Z"), "2026-W53");
    assert.equal(key("2027-01-12T12:00:00Z"), "2027-W01");
  });
});

describe("F3: persistRemDreamToVault prüft und loggt das Ergebnis", () => {
  const partition = buildRemPartition({ scope: "workspace", agentId: "agent-a", workspaceIdentity: "workspace:v1:workspace-a", ownerUserId: "" }, {
    agentId: "agent-a", workspaceIdentity: "workspace:v1:workspace-a", workspaceAliases: { paths: [], aliases: [] },
  });
  const report = { weekOf: "2026-W1", patternsFound: 0, new: 0, stronger: 0, weaker: 0, disappeared: 0, aclPartition: partition };

  it("warnt, wenn nicht geschrieben wurde, ohne den Fehlertext zu loggen", () => {
    const calls = [];
    const logger = { warn: (m) => calls.push(String(m)), info: (m) => calls.push(String(m)) };
    const out = persistRemDreamToVault(report, [], { aclBindings: partition, kind: "workspace", workspaceDir: "/nonexistent-secret-dir" }, logger);
    assert.equal(out.written, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /rem-dream.*vault/i);
    assert.ok(!calls[0].includes("nonexistent-secret-dir"), calls[0]);
    assert.ok(!calls[0].includes("2026-W1"), calls[0]);
  });

  it("schweigt bei Erfolg", (t) => {
    const dir = makeTempDir("rem-vault-ok-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = [];
    const out = persistRemDreamToVault({ ...report, weekOf: "2026-W01" }, [], { aclBindings: partition, kind: "workspace", workspaceDir: dir }, { warn: (m) => calls.push(m) });
    assert.equal(out.written, true);
    assert.deepEqual(calls, []);
  });
});

// ─── F4: ungültige ACL-Bindung ─────────────────────────────────────────────

describe("F4: Light-Dream ohne gültige ACL-Bindung wird nicht als dream-engine gespeichert", () => {
  const turns = ["eins", "zwei", "drei"].map((content) => ({ role: "user", content, agentId: "agent-a", workspaceKey: "ws" }));
  const baseArgs = (stored, extra = {}) => ({
    turns,
    neoStore: { readReactions: () => [], appendDreams() {}, appendBehaviorCards() {} },
    db: { search: async () => [], store: async (row) => { stored.push(row); } },
    embeddings: { embed: async () => [1, 0] },
    insightLlmCfg: {}, narrativeLlmCfg: {}, echoLlmCfg: {},
    callLlm: async (messages) => (JSON.stringify(messages).includes("JSON-Liste")
      ? JSON.stringify(["Einsicht"])
      : "Ein ausreichend langer Traumtext, der den Mindestumfang sicher überschreitet und gespeichert werden soll."),
    narrativeCfg: { enabled: true, storeAsMemory: true, diary: false },
    ...extra,
  });

  it("ungültige Bindung: kein Schreibzugriff auf den Memory-Store, Warnung statt Waisenzeile", async () => {
    const stored = [];
    const warns = [];
    const result = await lightDream(baseArgs(stored, {
      aclBindings: { scope: "workspace", agentId: "agent-a", workspaceIdentity: "" , ownerUserId: "" },
      requestContext: { agentId: "agent-a", workspaceIdentity: "workspace:v1:ws", workspaceAliases: { paths: [], aliases: [] } },
      logger: { info() {}, warn: (m) => warns.push(String(m)) },
    }));
    assert.equal(stored.filter((r) => r.storedBy === "dream-engine").length, 0);
    assert.equal(stored.length, 0);
    assert.equal(result.dreamMemoryId, null);
    assert.ok(warns.some((w) => /dream memory.*ACL/i.test(w)), warns.join("\n"));
  });

  it("fehlende Bindung (kein Kontext): ebenfalls nichts gespeichert", async () => {
    const stored = [];
    await lightDream(baseArgs(stored, { logger: { info() {}, warn() {} } }));
    assert.equal(stored.length, 0);
  });

  it("gültige Bindung: gespeichert und an Agent und Scope gebunden", async () => {
    const stored = [];
    const aclBindings = { scope: "workspace", agentId: "agent-a", workspaceIdentity: "workspace:v1:ws", ownerUserId: "" };
    await lightDream(baseArgs(stored, {
      aclBindings,
      requestContext: { agentId: "agent-a", workspaceIdentity: "workspace:v1:ws", workspaceAliases: { paths: [], aliases: [] } },
      logger: { info() {}, warn() {} },
    }));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].storedBy, "agent-a");
    assert.equal(stored[0].agentId, "agent-a");
    assert.equal(stored[0].scope, "workspace");
  });

  it("storeDreamAsMemory selbst schreibt nie unter dream-engine", async () => {
    const stored = [];
    const id = await storeDreamAsMemory({
      db: { store: async (row) => stored.push(row) },
      embeddings: { embed: async () => [0.1] },
      narrative: "Ein ausreichend langer Traumtext, der gespeichert werden sollte.",
      mode: "light",
      agentId: "main",
    });
    assert.equal(id, null);
    assert.equal(stored.length, 0);
  });

  it("die Neo-Sichtbarkeit nutzt ohne Bindung das einheitliche Scope-Schreibweise agent-private", async () => {
    const dreams = [];
    const stored = [];
    await lightDream(baseArgs(stored, {
      neoStore: { readReactions: () => [], appendDreams: (items) => dreams.push(...items), appendBehaviorCards() {} },
      logger: { info() {}, warn() {} },
    }));
    assert.equal(dreams[0].visibility.scope, "agent-private");
  });
});

// ─── F5: Promotion-Cap und run-state.json ──────────────────────────────────

describe("F5: Promotion-Cap gilt pro Workspace, run-state.json wird atomar geschrieben", () => {
  it("zählt Promotionen aller Agenten desselben Workspace gegen das Limit", async (t) => {
    const dir = makeTempDir("f5-cap-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    await recordKnowledgePromotion(dir, "ws", "agent-a", "m1", "h1");
    await recordKnowledgePromotion(dir, "ws", "agent-a", "m2", "h2");
    const forB = checkMaxPromotions(dir, "ws", "agent-b", 2);
    assert.equal(forB.current, 2);
    assert.equal(forB.allowed, false, "KNOWLEDGE.md ist workspace-weit");
    assert.equal(checkMaxPromotions(dir, "ws", "agent-b", 3).allowed, true);
  });

  it("parallele Promotionen verlieren keinen Eintrag und fremde Schlüssel bleiben erhalten", async (t) => {
    const dir = makeTempDir("f5-par-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const statePath = join(dir, "run-state.json");
    writeFileSync(statePath, JSON.stringify({ metrics: { keep: 1 } }));
    await Promise.all([
      recordKnowledgePromotion(dir, "ws", "agent-a", "m1", "h1"),
      recordKnowledgePromotion(dir, "ws", "agent-b", "m2", "h2"),
      atomicJsonUpdate(statePath, (data) => ({ ...data, extra: true })),
      recordKnowledgePromotion(dir, "ws", "agent-a", "m3", "h3"),
    ]);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.metrics.keep, 1);
    assert.equal(state.extra, true);
    assert.deepEqual(readPromotedKnowledgeIds(dir, "ws", "agent-a").ids.sort(), ["m1", "m3"]);
    assert.deepEqual(readPromotedKnowledgeIds(dir, "ws", "agent-b").ids, ["m2"]);
  });

  it("eine unlesbare run-state.json wird nicht mit {} überschrieben", async (t) => {
    const dir = makeTempDir("f5-corrupt-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const statePath = join(dir, "run-state.json");
    const corrupt = '{"jobRateLimits": {"a": 1}, "promotedKnowledge": {"x": ';
    writeFileSync(statePath, corrupt);
    const ok = await recordKnowledgePromotion(dir, "ws", "agent-a", "m1", "h1");
    assert.equal(ok, false);
    assert.equal(readFileSync(statePath, "utf8"), corrupt);
    assert.equal(existsSync(statePath), true);
  });

  it("atomicJsonUpdate mit strict wirft bei Parse-Fehlern und lässt die Datei unberührt", async (t) => {
    const dir = makeTempDir("f5-strict-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const statePath = join(dir, "s.json");
    writeFileSync(statePath, "{kaputt");
    await assert.rejects(() => atomicJsonUpdate(statePath, () => ({ a: 1 }), { strict: true }));
    assert.equal(readFileSync(statePath, "utf8"), "{kaputt");
    // fehlende Datei ist kein Fehler
    const fresh = join(dir, "fresh.json");
    await atomicJsonUpdate(fresh, (d) => ({ ...d, a: 1 }), { strict: true });
    assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), { a: 1 });
    // Standardverhalten unverändert
    await atomicJsonUpdate(statePath, () => ({ b: 2 }));
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), { b: 2 });
  });
});

// ─── F8: consolidation-report ──────────────────────────────────────────────

describe("F8: consolidation-report nutzt das ISO-Jahr", () => {
  it("Report vom 31.12.2025 (ISO 2026-W01) landet in 2026-W01.md", (t) => {
    const dir = makeTempDir("f8-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const RealDate = Date;
    const fixed = new RealDate(2025, 11, 31, 12, 0, 0);
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [fixed.getTime()])); }
      static now() { return fixed.getTime(); }
    };
    let result;
    try {
      result = writeConsolidationReport({ compaction: { compacted: 1 }, conflictResolution: {} }, dir);
    } finally {
      globalThis.Date = RealDate;
    }
    assert.equal(result.written, true, JSON.stringify(result));
    assert.ok(result.path.endsWith("2026-W01.md"), result.path);
    assert.match(readFileSync(result.path, "utf8"), /^week: 2026-W01$/m);
  });
});
