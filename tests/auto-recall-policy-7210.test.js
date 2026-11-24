/**
 * 7.20.10: Auto-Recall-Regeln in der Pipeline — Echo der Anfrage und des
 * laufenden Gesprächs raus, Qualitätsgewicht nach dem Rerank. Ohne die Option
 * (memory_recall, memory_search, Host-Recall, Messstand) bleibt alles wie bisher.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  applyAutoRecallPolicy,
  createAutoRecallPolicy,
  mergeNamespaceRecallResults,
  normalizeMemorySessionKey,
  projectRecallEntry,
  resolveSessionEchoCutoff,
  runRecallPipeline,
} from "../lib/recall-pipeline.js";
import { createRecallDecisionTrace } from "../lib/recall-decision-trace.js";

const silent = { warn: () => {}, info: () => {}, debug: () => {} };
const embeddings = { dim: 3, embed: async () => [0.1, 0.2, 0.3], embedQuery: async () => [0.1, 0.2, 0.3] };
const table = (rows) => ({ vectorSearch: () => ({ limit: () => ({ toArray: async () => rows }) }) });
const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const SESSION = "agent:main:telegram:direct:55736530";

const PROMPT = "Ich versuche noch immer herauszufinden, warum der Recall meine eigene Nachricht zurückgibt.";
const TEXTS = {
  echo: PROMPT,
  intro: "Ich bin ein Memory-Search-Agent. Meine Aufgabe ist es, relevante Erinnerungen zu suchen und zurückzugeben.",
  fact: "Der Recall-Block von 12:59 enthielt 30 Erinnerungen, davon 10 sichtbar; memoriesMaxChars lag bei 12000.",
  envelope: "Exec failed (brisk-tr, signal SIGTERM)\n\nThe command was terminated, but external side effects may already have completed. Verify the resulting state before retrying.",
  plain: "Christian möchte, dass beim Recall nichts gelöscht wird und die Qualität über das Ranking kommt.",
  sessionNew: "Wir haben gerade die Lane-Regeln für Neo besprochen und auf vier Reflexionen begrenzt.",
};
const row = (id, distance, extra = {}) => ({
  id,
  text: TEXTS[id] || `memory ${id}`,
  _distance: distance,
  scope: "agent-private",
  agentId: "agent-a",
  storedBy: "agent-a",
  createdAt: NOW - 30 * 24 * HOUR,
  ...extra,
});

// Der Fake-Reranker setzt die Reihenfolge fest: Selbstvorstellung und Hülle oben.
const RERANK_ORDER = ["intro", "echo", "envelope", "fact", "plain", "sessionNew"];
const fakeReranker = {
  async rerank(_query, docs, topN) {
    const ids = RERANK_ORDER.map((id) => docs.findIndex((doc) => doc === (TEXTS[id] || "")));
    return ids
      .map((index, position) => ({ index, relevance_score: 0.95 - position * 0.05 }))
      .filter((hit) => hit.index >= 0)
      .slice(0, topN);
  },
};

function rows() {
  return [
    row("echo", 0.05, { sourceMessageRole: "user" }),
    row("intro", 0.2, { sourceMessageRole: "assistant", origin: "cron" }),
    row("fact", 0.3, { sourceMessageRole: "user" }),
    row("envelope", 0.35, { sourceMessageRole: "user" }),
    row("plain", 0.4, { sourceMessageRole: "user" }),
    row("sessionNew", 0.45, { sourceMessageRole: "assistant", sessionKey: SESSION, createdAt: NOW - HOUR }),
  ];
}

function baseParams(extra = {}) {
  return {
    agentId: "agent-a",
    query: PROMPT,
    dbTable: table(rows()),
    embeddings,
    topN: 4,
    rerankCandidates: 20,
    reranker: fakeReranker,
    canonicalEnabled: false,
    dedupEnabled: false,
    logger: silent,
    now: NOW,
    ...extra,
  };
}

const POLICY = {
  query: PROMPT,
  sessionKey: SESSION,
  sessionContextSince: NOW - 2 * HOUR,
  qualityWeighting: { enabled: true },
};

describe("runRecallPipeline ohne autoRecallPolicy", () => {
  it("Auswahl, Reihenfolge und Felder wie bis 7.20.9", async () => {
    const without = await runRecallPipeline(baseParams());
    const explicitNull = await runRecallPipeline(baseParams({ autoRecallPolicy: null }));
    assert.deepEqual(without.memories, explicitNull.memories);
    assert.deepEqual(without.memories.map((m) => m.entry.id), ["intro", "echo", "envelope", "fact"], "Reranker-Reihenfolge, gekappt auf topN");
    for (const memory of without.memories) {
      assert.equal("qualityWeight" in memory, false);
      assert.equal("weightedScore" in memory, false);
    }
    assert.deepEqual(without.memories.map((m) => Number(m.rerankScore.toFixed(2))), [0.95, 0.9, 0.85, 0.8]);
  });

  it("die Namensraum-Zusammenführung ohne weightedScore sortiert wie bisher nach rerankScore", async () => {
    const { memories } = await runRecallPipeline(baseParams({ deferFinalCap: true, candidateHardLimit: 100 }));
    const merged = mergeNamespaceRecallResults([{ namespace: "default", canonical: [], memories }], { maxOut: 4, dedupEnabled: false });
    assert.deepEqual(merged.memories.map((m) => m.entry.id), ["intro", "echo", "envelope", "fact"]);
  });
});

describe("runRecallPipeline mit autoRecallPolicy", () => {
  it("Echo und laufendes Gespräch fallen weg, Nachrücker füllen topN, Hülle und Selbstvorstellung rücken nach hinten", async () => {
    const trace = createRecallDecisionTrace({ query: PROMPT });
    const { memories } = await runRecallPipeline(baseParams({ autoRecallPolicy: POLICY, decisionTrace: trace }));
    const ids = memories.map((m) => m.entry.id);
    assert.equal(ids.includes("echo"), false, "Selbst-Echo der Anfrage");
    assert.equal(ids.includes("sessionNew"), false, "aus dem laufenden Gespräch, noch im Kontext");
    assert.equal(ids.length, 4, "nachgerückt bis topN");
    assert.deepEqual(ids.slice(0, 2), ["fact", "plain"], "inhaltliche Treffer vorn");
    assert.ok(ids.indexOf("intro") > ids.indexOf("plain"));
    const intro = memories.find((m) => m.entry.id === "intro");
    assert.equal(intro.rerankScore, 0.95, "rerankScore bleibt unverändert");
    assert.ok(intro.qualityWeight < 0.5, `Selbstvorstellung niedrig: ${intro.qualityWeight}`);
    assert.ok(Math.abs(intro.weightedScore - 0.95 * intro.qualityWeight) < 1e-12);
    const stages = new Set(trace.decisions.map((d) => d.stage));
    for (const stage of ["query-echo", "session-echo", "quality-weight"]) assert.ok(stages.has(stage), stage);
    const echoDecision = trace.decisions.find((d) => d.stage === "query-echo");
    assert.equal(echoDecision.action, "rejection");
    assert.equal(trace.decisions.find((d) => d.stage === "quality-weight").action, "downrank");
  });

  it("die Namensraum-Zusammenführung sortiert nach weightedScore", async () => {
    const { memories } = await runRecallPipeline(baseParams({ autoRecallPolicy: POLICY, deferFinalCap: true, candidateHardLimit: 100 }));
    const merged = mergeNamespaceRecallResults([{ namespace: "default", canonical: [], memories }], { maxOut: 3, dedupEnabled: false });
    assert.deepEqual(merged.memories.map((m) => m.entry.id), ["fact", "plain", "intro"]);
  });

  it("Gewichtung abgeschaltet: nur die Echos fallen weg, Reihenfolge des Rerankers", async () => {
    const { memories } = await runRecallPipeline(baseParams({ autoRecallPolicy: { ...POLICY, qualityWeighting: { enabled: false } } }));
    assert.deepEqual(memories.map((m) => m.entry.id), ["intro", "envelope", "fact", "plain"]);
    assert.equal(memories.some((m) => "weightedScore" in m), false);
  });

  it("auch der Notausgang (Soft-Budget) zeigt kein Echo", async () => {
    const phaseTimer = {
      start() {}, end() {}, fail() {}, summary: () => ({}),
      isSoftBudgetExceeded: () => true,
    };
    const { memories } = await runRecallPipeline(baseParams({ autoRecallPolicy: POLICY, phaseTimer, softBudgetFallback: true }));
    assert.ok(memories.length > 0);
    assert.equal(memories.some((m) => m.entry.id === "echo"), false);
    assert.equal(memories.some((m) => m.entry.id === "sessionNew"), false);
  });
});

describe("createAutoRecallPolicy", () => {
  it("ohne Optionen keine Regeln", () => {
    assert.equal(createAutoRecallPolicy(null), null);
    assert.equal(createAutoRecallPolicy(undefined), null);
    const list = [{ entry: { id: "a", text: PROMPT }, score: 1 }];
    assert.equal(applyAutoRecallPolicy(list, null), list);
  });

  it("Sitzungs-Echo nur bei gleicher sessionKey und createdAt ab der Kontextgrenze", () => {
    const policy = createAutoRecallPolicy(POLICY);
    const entry = (extra) => ({ id: "x", text: TEXTS.plain, createdAt: NOW - HOUR, sessionKey: SESSION, ...extra });
    assert.equal(policy.exclusionReason(entry()), "session-echo");
    assert.equal(policy.exclusionReason(entry({ createdAt: BigInt(NOW - HOUR) })), "session-echo", "BigInt aus LanceDB");
    assert.equal(policy.exclusionReason(entry({ createdAt: NOW - 3 * HOUR })), null, "vor der Grenze (z. B. vor der Kompaktierung)");
    assert.equal(policy.exclusionReason(entry({ sessionKey: "agent:main:telegram:direct:1211667028" })), null, "andere Sitzung");
    assert.equal(policy.exclusionReason(entry({ sessionKey: "" })), null, "Bestand ohne sessionKey");
    assert.equal(createAutoRecallPolicy({ ...POLICY, sessionKey: "" }).exclusionReason(entry()), null, "Host ohne sessionKey");
  });

  it("Teilstück einer wiederholten Nachricht gilt als Echo", () => {
    const policy = createAutoRecallPolicy(POLICY);
    const part = { id: "p", text: "warum der Recall meine eigene Nachricht zurückgibt", chunkGroupId: "g1", sourceTurnId: "t1" };
    assert.equal(policy.exclusionReason(part), "query-echo");
    assert.equal(policy.exclusionReason({ ...part, chunkGroupId: "" }), null, "ohne Teilstück-Kennung zu kurz für ein Echo");
  });
});

describe("resolveSessionEchoCutoff", () => {
  const msg = (role, timestamp) => ({ role, timestamp, content: "x" });

  it("letzte Kompaktierung ist die Grenze", () => {
    const messages = [
      msg("compactionSummary", NOW - 5 * HOUR),
      msg("compactionSummary", NOW - 2 * HOUR),
      msg("user", NOW - 3 * HOUR),
      msg("assistant", NOW - 1 * HOUR),
    ];
    assert.deepEqual(resolveSessionEchoCutoff(messages, { now: NOW }), { since: NOW - 2 * HOUR, basis: "compaction" });
  });

  it("ohne Kompaktierung 6 Stunden, aber nie vor der ältesten Nachricht im Kontext", () => {
    assert.deepEqual(resolveSessionEchoCutoff([msg("user", NOW - 30 * HOUR)], { now: NOW }), { since: NOW - 6 * HOUR, basis: "window" });
    // Nach /new: gleicher Schlüssel, Kontext beginnt erst vor 20 Minuten.
    assert.equal(resolveSessionEchoCutoff([msg("user", NOW - HOUR / 3)], { now: NOW }).since, NOW - HOUR / 3);
  });

  it("leerer Kontext schließt nichts aus, fehlende messages fallen auf 6 Stunden", () => {
    assert.deepEqual(resolveSessionEchoCutoff([], { now: NOW }), { since: NOW, basis: "empty" });
    assert.deepEqual(resolveSessionEchoCutoff(undefined, { now: NOW }), { since: NOW - 6 * HOUR, basis: "window" });
    assert.equal(resolveSessionEchoCutoff([{ role: "user" }], { now: NOW }).since, NOW - 6 * HOUR, "Nachrichten ohne Zeitstempel");
  });
});

describe("normalizeMemorySessionKey und Projektion", () => {
  it("nur echte Schlüssel", () => {
    assert.equal(normalizeMemorySessionKey(` ${SESSION} `), SESSION);
    assert.equal(normalizeMemorySessionKey(""), "");
    assert.equal(normalizeMemorySessionKey(undefined), "");
    assert.equal(normalizeMemorySessionKey(42), "");
    assert.equal(normalizeMemorySessionKey("a\nb"), "");
    assert.equal(normalizeMemorySessionKey("x".repeat(513)), "");
  });

  it("projectRecallEntry trägt sessionKey und sourceMessageRole, Altzeilen ''", () => {
    assert.equal(projectRecallEntry({ id: "a", sessionKey: SESSION, sourceMessageRole: "user" }).sessionKey, SESSION);
    const legacy = projectRecallEntry({ id: "b" });
    assert.equal(legacy.sessionKey, "");
    assert.equal(legacy.sourceMessageRole, "");
  });
});

describe("Verdrahtung in index.js", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");

  it("nur der automatische Recall setzt autoRecallPolicy", () => {
    assert.equal((source.match(/autoRecallPolicy: autoRecallPolicyOptions,/g) || []).length, 1);
    assert.match(source, /const _autoRecallBaseParams = \{[\s\S]{0,400}autoRecallPolicy: autoRecallPolicyOptions,/);
    assert.equal((source.match(/\bautoRecallPolicy:/g) || []).length, 1, "kein anderer Aufrufer übergibt die Option");
  });

  it("Capture schreibt den Sitzungsschlüssel aus ctx, ohne sessionId-Ersatz", () => {
    assert.match(source, /const captureSessionKey = normalizeMemorySessionKey\(ctx\?\.sessionKey \|\| event\?\.sessionKey\);/);
    assert.match(source, /sourceMessageRole: p\.it\.role \|\| "",\n\s*sessionKey: captureSessionKey,/);
  });

  it("Spalte sessionKey: Migration mit valueSql, Bootstrap-Zeile, Default im Schreibpfad", () => {
    assert.match(source, /\{ name: 'sessionKey', valueSql: "''" \}/);
    // Weitere Spalten (embeddingTextMode, 7.20.10) dürfen folgen.
    assert.match(source, /validUntil: 0,\n\s*sessionKey: "",\n(?:\s*\w+: "[^"\n]*",\n)*\s*\},\n\s*\]\), "MemoryDB\.createTable"/);
    assert.match(source, /if \(normalized\.sessionKey == null\) normalized\.sessionKey = "";/);
  });

  it("CRR und Linse lassen Echos aus", () => {
    assert.match(source, /if \(autoRecallPolicy\?\.exclusionReason\(memory\)\) return null;/);
    assert.match(source, /lensMemories\.filter\(\(r\) => !autoRecallPolicy\?\.exclusionReason\(r\.entry\)\)/);
  });

  it("die Kontextgrenze kommt aus event.messages", () => {
    assert.match(source, /sessionContextSince: resolveSessionEchoCutoff\(event\?\.messages, \{ now: Date\.now\(\) \}\)\.since/);
  });
});
