import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inferEmotionalValenceAsync, setEmotionConfig } from "../lib/emotion.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// 7.12.22: Tier 3 laeuft fuer neue Erinnerungen nicht mehr im Turn, sondern
// im Feature-Cron `emotion-refine`. Diese Tests decken die drei Stellen ab:
// die Pending-Entscheidung im Capture-Pfad, den Cron-Lauf gegen eine echte
// Tabelle und das Verhalten bei Provider-Ausfall.

const VECTOR_DIM = 384;
const MEMORY_ID = "33333333-3333-4333-8333-333333333333";

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) {
    return { baseSessionKey: value, threadId: "" };
  },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
});

const T3_RESPONSE = JSON.stringify({
  valence: 0.8,
  arousal: 0.6,
  dominance: 0.5,
  intensity: 0.7,
  primary_emotion: "joy",
  secondary_emotion: null,
  emotion_labels: { joy: 0.9, trust: 0.3 },
  language: "de",
  confidence: 0.92,
});

// Seit 7.12.x klärt der Cron Emotion und Bedeutung in einem Call (lib/encoding-llm.js);
// das ist ein anderes Antwortformat als das der Tier-3-Emotionsanalyse oben, die
// weiterhin für inferEmotionalValenceAsync direkt (ohne den Cron) genutzt wird.
const ENCODING_RESPONSE = JSON.stringify({
  importance: 0.8,
  intensity: 0.3,
  dominant: "joy",
  reason: "Freudige Nachricht über den Umzug",
});

function makeVector(offset = 0) {
  const vector = Array(VECTOR_DIM).fill(0.1);
  vector[0] = 0.1 + offset;
  return vector;
}

async function loadFreshPlugin() {
  return import(`../index.js?emotion-refine=${Date.now()}-${Math.random()}`);
}

function createApi(baseDbPath, configOverrides = {}, runtimeLlm = null) {
  const commands = [];
  const toolFactories = [];
  const logs = [];
  const record = (level) => (...args) => logs.push([level, ...args]);
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      merging: { enabled: false },
      obsidianBridge: { enabled: false },
      featureCronSetup: { auto: false },
      gc: { enabled: false },
      ...configOverrides,
    },
    logger: { debug: record("debug"), error: record("error"), info: record("info"), warn: record("warn") },
    runtime: {
      ...(runtimeLlm ? { llm: runtimeLlm } : {}),
      agent: {
        async resolveAgentWorkspaceDir(config) { return config?.workspaceDir || baseDbPath; },
      },
    },
    resolvePath: (value) => value,
    registerCommand(command) { commands.push(command); },
    registerTool(factory) { toolFactories.push(factory); },
    registerService() {},
    on() {},
    _commands: commands,
    _toolFactories: toolFactories,
    _logs: logs,
  };
}

function findCommand(api) {
  const command = api._commands.find((candidate) => candidate.name === "plur1bus");
  assert.ok(command, "plur1bus command must be registered");
  return command;
}

function withTempPaths(t) {
  const baseDbPath = makeTempDir("plur1bus-emotion-refine-db-");
  const workspaceDir = makeTempDir("plur1bus-emotion-refine-ws-");
  t.after(() => {
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });
  return { baseDbPath, workspaceDir };
}

function installEmbeddingStub(t) {
  const original = LocalTransformersEmbeddingProvider.prototype.embedPassage;
  LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => makeVector(0.2);
  t.after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = original;
  });
}

async function seedPending(pluginModule, baseDbPath, agentId, overrides = {}) {
  const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
  try {
    await db.store({
      id: overrides.id || MEMORY_ID,
      text: overrides.text || "Ich freue mich riesig, dass der Umzug endlich geklappt hat!",
      vector: makeVector(),
      category: "fact",
      createdAt: Date.now(),
      storedBy: agentId,
      origin: "dm",
      status: overrides.status || "active",
      emotionalValence: "",
      emotionalIntensity: 0,
      emotionalDominant: "neutral",
      emotionStatus: overrides.emotionStatus || "pending_t3",
      importanceStatus: overrides.importanceStatus || "final",
    });
  } finally {
    await db.shutdown();
  }
}

async function readRow(pluginModule, baseDbPath, agentId, id) {
  const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
  try {
    await db.init();
    const rows = await db.table.query().where(`id = "${id}"`).limit(1).toArray();
    return rows[0] || null;
  } finally {
    await db.shutdown();
  }
}

test("skipTier3 keeps the local tier-1/2 score and exposes confidence and tier", async () => {
  let t3Calls = 0;
  setEmotionConfig({
    tier: "auto",
    t2: { enabled: true },
    t3: { enabled: true, callLlm: async () => { t3Calls++; return T3_RESPONSE; }, timeoutMs: 1000 },
    escalationConfidence: 0.85,
  });
  try {
    const local = await inferEmotionalValenceAsync("Der Server steht unter /srv/data.", "user", null, { skipTier3: true });
    assert.equal(t3Calls, 0, "skipTier3 must never reach the LLM");
    assert.ok(Number.isFinite(local.confidence));
    assert.ok(local.tierUsed === 1 || local.tierUsed === 2);

    const escalated = await inferEmotionalValenceAsync("Der Server steht unter /srv/data.", "user", null, {});
    assert.equal(t3Calls, 1, "without skipTier3 the low-confidence text escalates");
    assert.equal(escalated.tierUsed, 3);
    assert.equal(escalated.emotionalDominant, "joy");
  } finally {
    setEmotionConfig({ tier: "auto", t2: { enabled: true }, t3: { enabled: false }, escalationConfidence: 0.85 });
  }
});

test("memory_store defers tier 3: row is stored with emotionStatus=pending_t3 and no LLM call", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "emotion-defer-agent";
  const calls = [];
  const runtimeLlm = {
    async complete(params) {
      calls.push(params);
      return { text: T3_RESPONSE, provider: "fake", model: "fake", agentId, usage: {} };
    },
  };
  const pluginModule = await loadFreshPlugin();
  const api = createApi(baseDbPath, { emotion: { t3: { enabled: true } } }, runtimeLlm);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });
  assert.match(JSON.stringify(api._logs), /emotion tier-3 capture mode deferred/);

  const storeTool = api._toolFactories.at(-1)({ agentId, workspaceDir })
    .find((tool) => tool.name === "memory_store");
  assert.ok(storeTool);
  const result = await storeTool.execute("store-call", {
    text: "Der Backup-Server steht unter /srv/data und laeuft mit Node 24.",
    category: "fact",
  });
  assert.equal(calls.length, 0, "the store path must not call the tier-3 LLM in deferred mode");

  const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
  try {
    await db.init();
    const rows = await db.table.query().where("emotionStatus = 'pending_t3'").limit(5).toArray();
    assert.equal(rows.length, 1, `exactly one pending row expected (${JSON.stringify(result)})`);
    assert.equal(rows[0].emotionalDominant, "neutral");
  } finally {
    await db.shutdown();
  }
});

async function storeWithImportance(t, { importance, configOverrides }) {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = `emotion-core-${String(importance).replace(".", "_")}-${Math.random().toString(36).slice(2, 8)}`;
  const runtimeLlm = {
    async complete() {
      return { text: T3_RESPONSE, provider: "fake", model: "fake", agentId, usage: {} };
    },
  };
  const pluginModule = await loadFreshPlugin();
  const api = createApi(baseDbPath, { emotion: { t3: { enabled: true, ...configOverrides } } }, runtimeLlm);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });
  const storeTool = api._toolFactories.at(-1)({ agentId, workspaceDir })
    .find((tool) => tool.name === "memory_store");
  await storeTool.execute("store-core", {
    text: "Evas Geburtstag ist am 14. Maerz, sie mag keine Ueberraschungspartys.",
    category: "fact",
    importance,
  });
  const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
  try {
    await db.init();
    const rows = await db.table.query().select(["emotionStatus", "importance"]).limit(5).toArray();
    assert.equal(rows.length, 1);
    return { emotionStatus: rows[0].emotionStatus, importance: Number(rows[0].importance) };
  } finally {
    await db.shutdown();
  }
}

// 7.12.23: escalationConfidence 0 macht jede lokale Bewertung "sicher" —
// nur die Wichtigkeitsregel kann die Zeile dann noch auf pending_t3 setzen.
test("core memories (importance >= refineImportanceMin) are always queued for tier 3", async (t) => {
  const core = await storeWithImportance(t, { importance: 0.95, configOverrides: { escalationConfidence: 0 } });
  assert.ok(core.importance >= 0.9, `stored importance ${core.importance}`);
  assert.equal(core.emotionStatus, "pending_t3");
});

test("ordinary memories stay final when tier 1/2 is confident", async (t) => {
  const ordinary = await storeWithImportance(t, { importance: 0.5, configOverrides: { escalationConfidence: 0 } });
  assert.equal(ordinary.emotionStatus, "final");
});

test("refineImportanceMin above 1 disables the core-memory rule", async (t) => {
  const core = await storeWithImportance(t, { importance: 0.95, configOverrides: { escalationConfidence: 0, refineImportanceMin: 2 } });
  assert.equal(core.emotionStatus, "final");
});

test("internal emotion-refine refines pending rows with tier 3 and marks them final", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "emotion-refine-agent";
  const calls = [];
  const runtimeLlm = {
    async complete(params) {
      calls.push(params);
      return { text: ENCODING_RESPONSE, provider: "fake", model: "fake", agentId, usage: {} };
    },
  };
  const pluginModule = await loadFreshPlugin();
  await seedPending(pluginModule, baseDbPath, agentId);
  // Eine bereits überholte Zeile, ausschließlich über importanceStatus='pending'
  // gefunden (emotionStatus steht schon auf 'final') — belegt, dass das OR in der
  // where-Klausel sie erfasst und der Finalize-Zweig BEIDE Statusspalten schließt,
  // statt sie über importanceStatus endlos weiter zu scannen (13.09.2026-Bug).
  await seedPending(pluginModule, baseDbPath, agentId, {
    id: "44444444-4444-4444-8444-444444444444",
    text: "Alte Version, bereits ueberholt.",
    status: "superseded",
    emotionStatus: "final",
    importanceStatus: "pending",
  });
  const api = createApi(baseDbPath, { emotion: { t3: { enabled: true } } }, runtimeLlm);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await findCommand(api).handler({
    args: "internal emotion-refine",
    agentId,
    channel: "cron",
    workspaceDir,
    runtimeContext: { llm: runtimeLlm },
  });
  const payload = JSON.parse(result.text.replace(/^[^{]*/, ""));
  assert.equal(payload.job, "emotion-refine");
  assert.equal(payload.refined, 1);
  assert.equal(payload.finalized, 1, "superseded rows are closed without an LLM call");
  assert.equal(payload.failed, 0);
  assert.equal(payload.pending, 0);
  assert.equal(calls.length, 1);

  const row = await readRow(pluginModule, baseDbPath, agentId, MEMORY_ID);
  assert.equal(row.emotionStatus, "final");
  assert.equal(row.emotionalDominant, "joy");
  assert.strictEqual(Number(row.emotionalIntensity), 0.3);
  assert.match(String(row.emotionalValence), /joy:0\.30/);
  assert.equal(Number(row.importance), 0.8);
  assert.equal(row.importanceStatus, "final");
  assert.equal(Number(row.halfLifeDays), 600);
  // Koordinator-Korrektur zum Abschluss-Review, Important 5b:
  // updateSource/updateEvidence sind der Rollback-Kanal des
  // Phase-2-Backfills — der Cron darf sie nicht überschreiben. Das
  // Freitext-Urteil landet in coreMemoryReason.
  assert.match(String(row.coreMemoryReason), /Umzug/);

  const superseded = await readRow(pluginModule, baseDbPath, agentId, "44444444-4444-4444-8444-444444444444");
  assert.equal(superseded.emotionStatus, "final");
  assert.equal(superseded.importanceStatus, "final", "importanceStatus must close too, or the OR clause would rescan it forever");
  assert.equal(superseded.emotionalDominant, "neutral", "no LLM call means the seeded neutral value is untouched");
});

// Koordinator-Korrektur zum Abschluss-Review, Important 5b: updateSource/
// updateEvidence sind der Rollback-Kanal des Phase-2-Backfills (importance-v2
// protokolliert dort den vorherigen Wert, damit jede geänderte Zeile einzeln
// rückrollbar bleibt). Ein stündlicher Cron, der diese Felder routinemäßig
// überschreibt, zerstört genau diese Provenienz — deshalb darf der Refine-Job
// sie nicht anfassen, selbst wenn er die Zeile inhaltlich klärt.
test("internal emotion-refine never touches a pre-existing rollback provenance (updateSource/updateEvidence)", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "emotion-refine-provenance-agent";
  const runtimeLlm = {
    async complete(params) {
      return { text: ENCODING_RESPONSE, provider: "fake", model: "fake", agentId, usage: {} };
    },
  };
  const pluginModule = await loadFreshPlugin();
  await seedPending(pluginModule, baseDbPath, agentId);
  // Simuliert einen vorherigen Phase-2-Backfill-Rollback-Eintrag auf derselben Zeile.
  const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
  try {
    await db.init();
    await db.update(MEMORY_ID, { updateSource: "importance-v2", updateEvidence: "previous importance: 0.5" });
  } finally {
    await db.shutdown();
  }

  const api = createApi(baseDbPath, { emotion: { t3: { enabled: true } } }, runtimeLlm);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await findCommand(api).handler({
    args: "internal emotion-refine",
    agentId,
    channel: "cron",
    workspaceDir,
    runtimeContext: { llm: runtimeLlm },
  });
  const payload = JSON.parse(result.text.replace(/^[^{]*/, ""));
  assert.equal(payload.refined, 1);

  const row = await readRow(pluginModule, baseDbPath, agentId, MEMORY_ID);
  assert.equal(row.importanceStatus, "final", "die Zeile wurde inhaltlich geklärt");
  assert.equal(row.updateSource, "importance-v2", "der Rollback-Kanal darf nicht überschrieben werden");
  assert.equal(row.updateEvidence, "previous importance: 0.5", "der Rollback-Kanal darf nicht überschrieben werden");
  assert.match(String(row.coreMemoryReason), /Umzug/, "das Freitext-Urteil landet stattdessen hier");
});

test("internal emotion-refine leaves rows pending when the provider fails", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "emotion-refine-fail-agent";
  const runtimeLlm = {
    async complete() {
      throw new Error("provider down");
    },
  };
  const pluginModule = await loadFreshPlugin();
  await seedPending(pluginModule, baseDbPath, agentId);
  const api = createApi(baseDbPath, { emotion: { t3: { enabled: true } } }, runtimeLlm);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await findCommand(api).handler({
    args: "internal emotion-refine",
    agentId,
    channel: "cron",
    workspaceDir,
    runtimeContext: { llm: runtimeLlm },
  });
  const payload = JSON.parse(result.text.replace(/^[^{]*/, ""));
  assert.equal(payload.refined, 0);
  assert.equal(payload.failed, 1);
  assert.equal(payload.pending, 1);

  const row = await readRow(pluginModule, baseDbPath, agentId, MEMORY_ID);
  assert.equal(row.emotionStatus, "pending_t3");
});

// Abschluss-Review, Important 4: "die Route ist tot" und "diese Zeile ist
// vergiftet" sind verschiedene Zustände. Drei Zeilen, deren Text das Modell
// zur Verweigerung bringt (eine tatsächlich erhaltene, aber unparsbare
// Antwort — kein Wurf, kein leerer Call), dürfen den
// Consecutive-Failure-Breaker nicht auslösen, sonst wird nichts hinter ihnen
// je wieder bewertet.
test("internal emotion-refine counts poisoned rows separately and does not trip the breaker", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "emotion-refine-poison-agent";
  const POISON_MARKER = "POISON_MARKER_TEXT";
  const runtimeLlm = {
    async complete(params) {
      const isPoison = (params.messages || []).some(
        (m) => typeof m.content === "string" && m.content.includes(POISON_MARKER),
      );
      return {
        // Eine echte, aber unparsbare Antwort — kein Wurf, keine leere
        // Antwort — genau der Fall, den ein verweigerndes Modell erzeugt.
        text: isPoison ? "Ich kann diese Anfrage leider nicht bewerten." : ENCODING_RESPONSE,
        provider: "fake", model: "fake", agentId, usage: {},
      };
    },
  };
  const pluginModule = await loadFreshPlugin();
  const poisonIds = [
    "55555555-5555-4555-8555-555555555001",
    "55555555-5555-4555-8555-555555555002",
    "55555555-5555-4555-8555-555555555003",
  ];
  for (const id of poisonIds) {
    await seedPending(pluginModule, baseDbPath, agentId, { id, text: `${POISON_MARKER} verweigerter Text` });
  }
  await seedPending(pluginModule, baseDbPath, agentId, {
    id: "55555555-5555-4555-8555-555555555004",
    text: "Ein ganz normaler, gut bewertbarer Satz.",
  });

  const api = createApi(baseDbPath, { emotion: { t3: { enabled: true } } }, runtimeLlm);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await findCommand(api).handler({
    args: "internal emotion-refine",
    agentId,
    channel: "cron",
    workspaceDir,
    runtimeContext: { llm: runtimeLlm },
  });
  const payload = JSON.parse(result.text.replace(/^[^{]*/, ""));
  assert.equal(payload.poisoned, 3, "alle drei vergifteten Zeilen werden separat gezählt");
  assert.equal(payload.failed, 0, "eine erhaltene, unparsbare Antwort ist kein Route-Fehler");
  assert.equal(payload.refined, 1, "die gute Zeile hinter den drei vergifteten wird trotzdem erreicht");
  assert.equal(payload.pending, 3);

  const refinedRow = await readRow(pluginModule, baseDbPath, agentId, "55555555-5555-4555-8555-555555555004");
  assert.equal(refinedRow.importanceStatus, "final");

  for (const id of poisonIds) {
    const poisonRow = await readRow(pluginModule, baseDbPath, agentId, id);
    assert.equal(poisonRow.importanceStatus, "final", "seedPending default — unverändert von diesem Lauf");
    assert.equal(poisonRow.emotionStatus, "pending_t3", "vergiftete Zeile bleibt für den nächsten Lauf offen");
  }
});

// Die Kehrseite: eine tatsächlich tote Route (werfendes callLlm) muss den
// Breaker weiterhin auslösen, sonst verheizt ein permanenter Ausfall das
// ganze Zeitbudget des Laufs.
test("internal emotion-refine still trips the breaker on a genuinely dead route", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "emotion-refine-dead-route-agent";
  const runtimeLlm = {
    async complete() {
      throw new Error("provider down");
    },
  };
  const pluginModule = await loadFreshPlugin();
  for (let i = 0; i < 5; i++) {
    await seedPending(pluginModule, baseDbPath, agentId, {
      id: `66666666-6666-4666-8666-66666666600${i}`,
      text: `Zeile Nummer ${i}, jede davon triggert einen Provider-Ausfall.`,
    });
  }
  const api = createApi(baseDbPath, { emotion: { t3: { enabled: true } } }, runtimeLlm);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await findCommand(api).handler({
    args: "internal emotion-refine",
    agentId,
    channel: "cron",
    workspaceDir,
    runtimeContext: { llm: runtimeLlm },
  });
  const payload = JSON.parse(result.text.replace(/^[^{]*/, ""));
  assert.equal(payload.failed, 3, "der Breaker bricht nach drei Fehlschlägen in Folge ab, statt alle fünf zu versuchen");
  assert.equal(payload.refined, 0);
  assert.equal(payload.poisoned, 0);
});

// Abschluss-Review, Important 6: emotion.t3 und die Importance-Klärung
// dieses Crons sind entkoppelt. "emotion.t3 aus" allein darf die
// Importance-Klärung nicht mehr für immer einfrieren — nur "wirklich kein
// Provider vorhanden" darf das, und dann sichtbar (Warnung + Pending-Zahl),
// nicht still.
test("internal emotion-refine skips with a warning and the pending count when truly no LLM route exists", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "emotion-refine-no-route-agent";
  const pluginModule = await loadFreshPlugin();
  await seedPending(pluginModule, baseDbPath, agentId);
  // Bewusst ohne runtimeLlm — weder emotion.t3 noch der Encoding-Call haben
  // hier eine Route.
  const api = createApi(baseDbPath, { emotion: { t3: { enabled: false } } });
  pluginModule.default.register(api, { importRouting: async () => routingCapability });
  const result = await findCommand(api).handler({
    args: "internal emotion-refine",
    agentId,
    channel: "cron",
    workspaceDir,
  });
  const payload = JSON.parse(result.text.replace(/^[^{]*/, ""));
  assert.equal(payload.skipped, true);
  assert.equal(payload.reason, "no_llm_route");
  assert.equal(payload.pending, 1, "der Rückstand muss im Payload sichtbar sein, nicht nur im Log");

  const warnLogs = api._logs.filter(([level]) => level === "warn");
  assert.ok(
    warnLogs.some(([, msg]) => String(msg).includes("emotion-refine")),
    "eine wachsende Pending-Warteschlange ohne Route muss eine Warnung loggen, kein reines info",
  );

  const row = await readRow(pluginModule, baseDbPath, agentId, MEMORY_ID);
  assert.equal(row.emotionStatus, "pending_t3", "ohne Route wird nichts geschrieben — die Zeile bleibt unangetastet");
});

test("internal emotion-refine still clears importance when tier 3 is disabled but a provider exists", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "emotion-refine-t3-off-provider-agent";
  const runtimeLlm = {
    async complete(params) {
      return { text: ENCODING_RESPONSE, provider: "fake", model: "fake", agentId, usage: {} };
    },
  };
  const pluginModule = await loadFreshPlugin();
  await seedPending(pluginModule, baseDbPath, agentId);
  const api = createApi(baseDbPath, { emotion: { t3: { enabled: false } } }, runtimeLlm);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await findCommand(api).handler({
    args: "internal emotion-refine",
    agentId,
    channel: "cron",
    workspaceDir,
    runtimeContext: { llm: runtimeLlm },
  });
  const payload = JSON.parse(result.text.replace(/^[^{]*/, ""));
  assert.notEqual(payload.skipped, true, "eine vorhandene Route darf die Importance-Klärung nicht überspringen, nur weil emotion.t3 aus ist");
  assert.equal(payload.refined, 1);

  const row = await readRow(pluginModule, baseDbPath, agentId, MEMORY_ID);
  assert.equal(row.importanceStatus, "final");
  assert.equal(Number(row.importance), 0.8);
});
