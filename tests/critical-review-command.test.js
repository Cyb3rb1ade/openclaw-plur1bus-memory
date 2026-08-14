/**
 * tests/critical-review-command.test.js
 *
 * Ende-zu-Ende-Regression für den /plur1bus critical-Befehl:
 * Listenansicht, accept/reject/edit über Kurzreferenzen, Scope-Isolation,
 * Autorisierung, nicht-destruktives Reject und vollständige UUID als
 * Kompatibilitätsfallback.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

const VECTOR_DIM = 384;

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

async function loadFreshPlugin() {
  return import(`../index.js?critical-review-command=${Date.now()}-${Math.random()}`);
}

function createApi(baseDbPath, configOverrides = {}) {
  const commands = [];
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      obsidianBridge: { enabled: false },
      featureCronSetup: { auto: false },
      gc: { enabled: false },
      criticalPush: { enabled: true },
      ...configOverrides,
    },
    logger: { debug() {}, error() {}, info() {}, warn() {} },
    runtime: {
      agent: {
        async resolveAgentWorkspaceDir(config) { return config?.workspaceDir || baseDbPath; },
      },
    },
    resolvePath: (value) => value,
    registerCommand(command) { commands.push(command); },
    registerTool() {},
    registerService() {},
    on() {},
    _commands: commands,
  };
}

function findCommand(api, name = "plur1bus") {
  return api._commands.find((c) => c.name === name);
}

function telegramContext(agentId, workspaceDir, args) {
  return {
    args,
    agentId,
    workspaceDir,
    workspaceKey: "workspace-critical",
    senderId: "command-owner",
    channel: "telegram",
    accountId: "default",
    lang: "de",
    sessionKey: `agent:${agentId}:main`,
    from: "telegram:command-private",
    to: "telegram:command-private",
    config: { workspaceDir },
    getCurrentConversationBinding: () => null,
    runtimeContext: null,
    message: {
      from: { id: "command-owner" },
      chat: { id: "command-private", type: "private" },
    },
  };
}

function groupContext(agentId, workspaceDir, args) {
  const ctx = telegramContext(agentId, workspaceDir, args);
  ctx.from = "telegram:group:123";
  ctx.to = "telegram:group:123";
  ctx.message = { from: { id: "command-owner" }, chat: { id: "123", type: "supergroup" } };
  return ctx;
}

async function seedCriticalCard(pluginModule, baseDbPath, agentId, { id, type, text, sourceMessageRole, owner }) {
  const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
  await db.store({
    id,
    text,
    vector: Array(VECTOR_DIM).fill(0.1),
    category: "fact",
    createdAt: Date.now(),
    storedBy: owner || agentId,
    agentId: owner || agentId,
    origin: "dm",
    trustLevel: "untrusted",
    type,
    status: "active",
    sourceMessageRole,
  });
  await db.shutdown();
}

async function readCard(pluginModule, baseDbPath, agentId, id) {
  const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
  try {
    return await db.getById(id);
  } finally {
    await db.shutdown();
  }
}

function withTempPaths(t) {
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-critical-cmd-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-critical-cmd-ws-"));
  t.after(() => {
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });
  return { baseDbPath, workspaceDir };
}

function installEmbeddingStub(t) {
  const original = LocalTransformersEmbeddingProvider.prototype.embedPassage;
  LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => Array(VECTOR_DIM).fill(0.2);
  t.after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = original;
  });
}

test("critical list zeigt ausstehende Reviews mit Kurzreferenzen und verständlichen Typen", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "critical-list-agent";
  const id = "a4563cc9-7611-4528-992a-075f8889a018";
  const pluginModule = await loadFreshPlugin();
  await seedCriticalCard(pluginModule, baseDbPath, agentId, { id, type: "person", text: "Eva ist die neue Projektleiterin.", sourceMessageRole: "user" });
  const api = createApi(baseDbPath);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await findCommand(api).handler(telegramContext(agentId, workspaceDir, "critical"));

  assert.match(result.text, /Ausstehende PLUR1BUS-Prüfungen/);
  assert.match(result.text, /9a018/);
  assert.match(result.text, /Information über eine Person/);
  assert.doesNotMatch(result.text, /person/);
  assert.doesNotMatch(result.text, new RegExp(id, "i"));
});

test("critical accept bestätigt die Kennzeichnung (nicht-destruktiv)", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "critical-accept-agent";
  const id = "b4563cc9-7611-4528-992a-075f8889a019";
  const pluginModule = await loadFreshPlugin();
  await seedCriticalCard(pluginModule, baseDbPath, agentId, { id, type: "gesundheit", text: "Allergie gegen Penicillin.", sourceMessageRole: "user" });
  const api = createApi(baseDbPath);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  // Referenz des einzigen Pending = letzte 5 Hex der UUID = "9a019"
  const result = await findCommand(api).handler(telegramContext(agentId, workspaceDir, "critical accept 9a019"));

  assert.match(result.text, /hervorgehoben/);
  const card = await readCard(pluginModule, baseDbPath, agentId, id);
  assert.ok(card.confirmed === true || card.confirmed === 1, "accept muss die Karte bestätigen");
  assert.equal(card.text, "Allergie gegen Penicillin.", "Reject/Accept dürfen den Inhalt nicht verändern");
});

test("critical reject verwirft nur die Kennzeichnung und löscht NICHT", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "critical-reject-agent";
  const id = "c4563cc9-7611-4528-992a-075f8889a028";
  const pluginModule = await loadFreshPlugin();
  await seedCriticalCard(pluginModule, baseDbPath, agentId, { id, type: "person", text: "Christians Geburtstag ist der 1. Mai.", sourceMessageRole: "user" });
  const api = createApi(baseDbPath);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await findCommand(api).handler(telegramContext(agentId, workspaceDir, "critical reject 9a028"));

  assert.match(result.text, /bleibt gespeichert/);
  const card = await readCard(pluginModule, baseDbPath, agentId, id);
  assert.ok(card, "Reject darf die Erinnerung NICHT löschen");
  assert.equal(card.type, "note", "Reject verwirft die besondere Kennzeichnung (Deklassifikation)");
  assert.equal(card.text, "Christians Geburtstag ist der 1. Mai.");

  // Nach Reject ist die Review nicht mehr über ihre Kurzreferenz mutierbar.
  const again = await findCommand(api).handler(telegramContext(agentId, workspaceDir, "critical reject 9a028"));
  assert.match(again.text, /finde keine ausstehende PLUR1BUS-Prüfung/);
});

test("critical: unbekannte Referenz verändert nichts", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "critical-unknown-agent";
  const id = "d4563cc9-7611-4528-992a-075f8889a038";
  const pluginModule = await loadFreshPlugin();
  await seedCriticalCard(pluginModule, baseDbPath, agentId, { id, type: "person", text: "Unverändert bleiben.", sourceMessageRole: "user" });
  const api = createApi(baseDbPath);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await findCommand(api).handler(telegramContext(agentId, workspaceDir, "critical accept fffff"));

  assert.match(result.text, /finde keine ausstehende PLUR1BUS-Prüfung mit der Referenz fffff/);
  const card = await readCard(pluginModule, baseDbPath, agentId, id);
  assert.notEqual(card.type, "note", "unbekannte Referenz darf nichts verändern");
  assert.equal(card.text, "Unverändert bleiben.");
});

test("critical: vollständige UUID bleibt kompatibler Fallback", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "critical-uuid-agent";
  const id = "e4563cc9-7611-4528-992a-075f8889a048";
  const pluginModule = await loadFreshPlugin();
  await seedCriticalCard(pluginModule, baseDbPath, agentId, { id, type: "person", text: "UUID-Fallback.", sourceMessageRole: "user" });
  const api = createApi(baseDbPath);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await findCommand(api).handler(telegramContext(agentId, workspaceDir, `critical accept ${id}`));
  assert.match(result.text, /hervorgehoben/);
  const card = await readCard(pluginModule, baseDbPath, agentId, id);
  assert.ok(card.confirmed === true || card.confirmed === 1);
});

test("critical: Scope-Isolation — fremde Pending-Reviews sind nicht auflösbar", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "critical-scope-agent";
  const id = "f4563cc9-7611-4528-992a-075f8889a058";
  const pluginModule = await loadFreshPlugin();
  await seedCriticalCard(pluginModule, baseDbPath, agentId, { id, type: "person", text: "Scoped memory.", sourceMessageRole: "user" });
  const api = createApi(baseDbPath);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  // Anderer Agent hat kein Pending mit dieser Referenz.
  const otherAgent = "critical-other-agent";
  const result = await findCommand(api).handler(telegramContext(otherAgent, workspaceDir, "critical accept 9a058"));
  assert.match(result.text, /finde keine ausstehende PLUR1BUS-Prüfung/);
});

test("critical: fremde Karte in derselben Agent-DB ist unsichtbar und nicht mutierbar (M1)", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "critical-acl-agent";
  const fremdeId = "00000000-7611-4528-992a-075f8889b0f1";
  const pluginModule = await loadFreshPlugin();
  // Gleiche DB, fremde Eigentümerbindung — genau der Fall, den checkAccess
  // abdeckt und den der Kommandopfad bisher ignorierte.
  await seedCriticalCard(pluginModule, baseDbPath, agentId, {
    id: fremdeId, type: "zugang_passwort", text: "Fremdes Passwort.", sourceMessageRole: "user",
    owner: "ein-anderer-agent",
  });
  const api = createApi(baseDbPath);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const liste = await findCommand(api).handler(telegramContext(agentId, workspaceDir, "critical"));
  assert.doesNotMatch(liste.text, /9b0f1/, "die fremde Karte darf keine Kurzreferenz bekommen");
  assert.doesNotMatch(liste.text, /Zugangsinformation/i, "auch der Typ ist eine Information über fremde Daten");

  // Weder über die Kurzreferenz noch über die vollständige UUID mutierbar.
  for (const ref of ["9b0f1", fremdeId]) {
    const versuch = await findCommand(api).handler(telegramContext(agentId, workspaceDir, `critical accept ${ref}`));
    assert.match(versuch.text, /finde keine ausstehende PLUR1BUS-Prüfung/, `accept ${ref} musste ins Leere laufen`);
  }
  const card = await readCard(pluginModule, baseDbPath, agentId, fremdeId);
  assert.notEqual(card.confirmed === true || card.confirmed === 1, true, "die fremde Karte darf nicht bestätigt worden sein");

  // Und edit gibt keinen Titel (= echten Inhalt) der fremden Karte aus.
  const edit = await findCommand(api).handler(telegramContext(agentId, workspaceDir, "critical edit 9b0f1"));
  assert.doesNotMatch(edit.text, /Fremdes Passwort/);
});

test("critical: accept/reject in Gruppen ohne Whitelist bleiben verweigert (fail-safe)", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "critical-group-agent";
  const id = "12345678-7611-4528-992a-075f8889a068";
  const pluginModule = await loadFreshPlugin();
  await seedCriticalCard(pluginModule, baseDbPath, agentId, { id, type: "person", text: "Gruppen-Memory.", sourceMessageRole: "user" });
  const api = createApi(baseDbPath);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await findCommand(api).handler(groupContext(agentId, workspaceDir, "critical accept 9a068"));
  assert.match(result.text, /nicht autorisiert|unauthorized|verweigert|allowed/i);
  const card = await readCard(pluginModule, baseDbPath, agentId, id);
  assert.notEqual(card.confirmed === true || card.confirmed === 1, true, "Gruppe ohne Whitelist darf nicht akzeptieren");
});

test("critical edit verweist in den sicheren Korrekturablauf", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "critical-edit-agent";
  const id = "23456789-7611-4528-992a-075f8889a078";
  const pluginModule = await loadFreshPlugin();
  await seedCriticalCard(pluginModule, baseDbPath, agentId, { id, type: "person", text: "Edit me.", sourceMessageRole: "user" });
  const api = createApi(baseDbPath);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await findCommand(api).handler(telegramContext(agentId, workspaceDir, "critical edit 9a078"));
  assert.match(result.text, /korrigieren/i);
  assert.match(result.text, /\/plur1bus correct/);
});

test("critical: ungültige Referenz (zu kurz/nicht hex) wird abgewiesen", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "critical-invalid-agent";
  const id = "34567890-7611-4528-992a-075f8889a088";
  const pluginModule = await loadFreshPlugin();
  await seedCriticalCard(pluginModule, baseDbPath, agentId, { id, type: "person", text: "Ungültig.", sourceMessageRole: "user" });
  const api = createApi(baseDbPath);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const short = await findCommand(api).handler(telegramContext(agentId, workspaceDir, "critical accept 12ab"));
  assert.match(short.text, /Ungültige Referenz/);

  const notHex = await findCommand(api).handler(telegramContext(agentId, workspaceDir, "critical accept zzzzz"));
  assert.match(notHex.text, /Ungültige Referenz/);
});
