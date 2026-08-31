/**
 * tests/tombstone-scope-e2e.test.js
 *
 * Negative Evals: memory_forget erzwingt Scope-Enforcement über alle drei Pfade
 * (ID, aktive Query, Deleted-Recovery) — workspace- und user-gebunden.
 */

import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { MemoryDB } from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { tombstoneRegistryDir } from "../lib/tombstone.js";

const VECTOR_DIM = 384;

function textVector(text) {
  let hash = 2166136261;
  for (const ch of String(text)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const raw = Array.from({ length: VECTOR_DIM }, (_, i) => {
    const h = (hash + i * 2654435761) % 4294967296;
    return ((h % 2000) / 1000) - 1;
  });
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

function makeMockApi(baseDbPath) {
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      forgetThreshold: 0.9,
      autoCapture: false,
      autoRecall: false,
      merging: { enabled: false },
      obsidianBridge: { enabled: false },
      neo: { enabled: false },
      gc: { enabled: false },
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (path) => path,
    registerCommand: noop,
    registerTool(factory) { this._toolFactory = factory; },
    registerService: noop,
    on: noop,
  };
}

describe("memory_forget Scope-Enforcement (workspace/user)", () => {
  let api;
  let testRoot;
  let baseDbPath;
  let originalEmbedQuery;
  let originalEmbedPassage;

  before(() => {
    testRoot = mkdtempSync(join(tmpdir(), "plur1bus-forget-scope-"));
    baseDbPath = join(testRoot, "db");
    mkdirSync(baseDbPath);
    originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async function (text) { return textVector(text); };
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function (text) { return textVector(text); };
    api = makeMockApi(baseDbPath);
    plugin.register(api);
  });

  after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
    rmSync(testRoot, { recursive: true, force: true });
  });

  function toolsFor(ctx) {
    return api._toolFactory(ctx);
  }

  async function readMemory(agentId, memoryId) {
    const db = new MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
    await db.init();
    try {
      return await db.getById(memoryId);
    } finally {
      await db.shutdown();
    }
  }

  it("uses a suite-private tombstone registry instead of the shared temp root", () => {
    assert.equal(tombstoneRegistryDir(baseDbPath), join(testRoot, "_tombstones"));
    assert.notEqual(tombstoneRegistryDir(baseDbPath), join(tmpdir(), "_tombstones"));
  });

  it("Workspace B kann Workspace-A-Memory weder per ID noch per Query finden/tombstonen", async () => {
    const agentId = "scope-agent-a";
    const wsA = mkdtempSync(join(tmpdir(), "plur1bus-scope-wsa-"));
    const wsB = mkdtempSync(join(tmpdir(), "plur1bus-scope-wsb-"));
    const text = `workspace scoped target ${randomUUID()}`;

    const toolsA = toolsFor({ agentId, workspaceDir: wsA });
    const storeTool = toolsA.find((t) => t.name === "memory_store");
    const stored = await storeTool.execute("store", { text, category: "fact", scope: "workspace" });
    assert.equal(stored.details.action, "stored");
    const memoryId = stored.details.id;

    const toolsB = toolsFor({ agentId, workspaceDir: wsB });
    const forgetB = toolsB.find((t) => t.name === "memory_forget");

    // ID-Pfad: fremder Workspace → "No matching memory found" (kein ID-/Klartext-Leak).
    const byId = await forgetB.execute("forget-id-cross-ws", { memoryId });
    assert.equal(byId.content[0].text, "No matching memory found.");
    assert.doesNotMatch(byId.content[0].text, new RegExp(memoryId));

    // Aktiver Query-Pfad: fremder Workspace → kein Treffer, kein Klartext.
    const byQuery = await forgetB.execute("forget-query-cross-ws", { query: text });
    assert.equal(byQuery.content[0].text, "No matching memory found.");
    assert.doesNotMatch(JSON.stringify(byQuery), new RegExp(text));

    // Memory bleibt unangetastet.
    const card = await readMemory(agentId, memoryId);
    assert.equal(card.status, "active", "fremder Workspace darf nicht tombstonen");
    rmSync(wsA, { recursive: true, force: true });
    rmSync(wsB, { recursive: true, force: true });
  });

  it("Deleted-Recovery ist workspace-gebunden: Workspace B kann keine gelöschte Workspace-A-Karte auflösen", async () => {
    const agentId = "scope-recovery-agent";
    const wsA = mkdtempSync(join(tmpdir(), "plur1bus-scope-reca-"));
    const wsB = mkdtempSync(join(tmpdir(), "plur1bus-scope-recb-"));
    const text = `recovery scoped target ${randomUUID()}`;

    const toolsA = toolsFor({ agentId, workspaceDir: wsA });
    const storeTool = toolsA.find((t) => t.name === "memory_store");
    const forgetA = toolsA.find((t) => t.name === "memory_forget");
    const stored = await storeTool.execute("store", { text, category: "fact", scope: "workspace" });
    const memoryId = stored.details.id;
    const forgotten = await forgetA.execute("forget-query-own-ws", { query: text });
    assert.match(forgotten.content[0].text, /Forgotten/);

    // Workspace B: Deleted-Recovery darf die gelöschte Karte nicht auflösen.
    const toolsB = toolsFor({ agentId, workspaceDir: wsB });
    const forgetB = toolsB.find((t) => t.name === "memory_forget");
    const crossRecovery = await forgetB.execute("forget-query-cross-recovery", { query: text });
    assert.equal(crossRecovery.content[0].text, "No matching memory found.");
    assert.doesNotMatch(crossRecovery.content[0].text, new RegExp(memoryId));
    rmSync(wsA, { recursive: true, force: true });
    rmSync(wsB, { recursive: true, force: true });
  });

  it("User-Scope: fremder User kann eine user-scoped Memory nicht tombstonen", async () => {
    const agentId = "scope-user-agent";
    const ws = mkdtempSync(join(tmpdir(), "plur1bus-scope-user-"));
    const text = `user scoped target ${randomUUID()}`;

    const toolsOwner = toolsFor({ agentId, workspaceDir: ws, requesterSenderId: "owner-user", messageChannel: "telegram", agentAccountId: "default" });
    const storeTool = toolsOwner.find((t) => t.name === "memory_store");
    const stored = await storeTool.execute("store", { text, category: "fact", scope: "user" });
    assert.equal(stored.details.action, "stored");
    const memoryId = stored.details.id;

    const toolsForeign = toolsFor({ agentId, workspaceDir: ws, requesterSenderId: "foreign-user", messageChannel: "telegram", agentAccountId: "default" });
    const forgetForeign = toolsForeign.find((t) => t.name === "memory_forget");
    const denied = await forgetForeign.execute("forget-id-cross-user", { memoryId });
    assert.equal(denied.content[0].text, "No matching memory found.");

    const card = await readMemory(agentId, memoryId);
    assert.equal(card.status, "active", "fremder User darf nicht tombstonen");
    rmSync(ws, { recursive: true, force: true });
  });
});
