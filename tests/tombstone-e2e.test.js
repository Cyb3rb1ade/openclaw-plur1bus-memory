import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { MemoryDB } from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

const VECTOR_DIM = 384;

function makeVector() {
  const vector = Array(VECTOR_DIM).fill(0.1);
  vector[0] = 0.5;
  return vector;
}

function makeMockApi(baseDbPath) {
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
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

describe("tombstone end-to-end (real plugin store → forget → re-store)", () => {
  let api;
  let baseDbPath;
  let tempRoot;
  let originalEmbedQuery;

  before(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "plur1bus-tombstone-e2e-"));
    baseDbPath = join(tempRoot, "lancedb");
    originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => makeVector();
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => makeVector();
    api = makeMockApi(baseDbPath);
    plugin.register(api);
  });

  after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function toolsFor(agentId, workspaceDir) {
    return api._toolFactory({ agentId, workspaceDir });
  }

  async function store(agentId, workspaceDir, text) {
    const tools = toolsFor(agentId, workspaceDir);
    const storeTool = tools.find((t) => t.name === "memory_store");
    const result = await storeTool.execute("store", { text, category: "fact" });
    return result;
  }

  async function forgetById(agentId, workspaceDir, memoryId) {
    const tools = toolsFor(agentId, workspaceDir);
    const forgetTool = tools.find((t) => t.name === "memory_forget");
    return forgetTool.execute("forget", { memoryId });
  }

  async function forgetByQuery(agentId, workspaceDir, query) {
    const tools = toolsFor(agentId, workspaceDir);
    const forgetTool = tools.find((t) => t.name === "memory_forget");
    return forgetTool.execute("forget-query", { query });
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

  it("identischer Store im selben Scope nach Forget wird blockiert", async () => {
    const agentId = "e2e-agent-a";
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-e2e-ws-"));
    const text = `E2E forgotten target ${randomUUID()}`;

    const stored = await store(agentId, workspaceDir, text);
    assert.equal(stored.details.action, "stored");
    const memoryId = stored.details.id;

    await forgetById(agentId, workspaceDir, memoryId);
    assert.equal((await readMemory(agentId, memoryId)).status, "deleted");

    const reStore = await store(agentId, workspaceDir, text);
    assert.equal(reStore.details.action, "tombstone_blocked", "identischer Store muss blockiert werden");
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("anderer Agent bleibt unbeeinflusst", async () => {
    const text = `E2E other-agent target ${randomUUID()}`;
    const wsA = mkdtempSync(join(tmpdir(), "plur1bus-e2e-a-"));
    const wsB = mkdtempSync(join(tmpdir(), "plur1bus-e2e-b-"));

    const stored = await store("e2e-agent-b", wsA, text);
    await forgetById("e2e-agent-b", wsA, stored.details.id);

    const otherStore = await store("e2e-agent-c", wsB, text);
    assert.equal(otherStore.details.action, "stored", "fremder Agent darf nicht blockiert werden");
    rmSync(wsA, { recursive: true, force: true });
    rmSync(wsB, { recursive: true, force: true });
  });

  it("Audit-Fehler → Wiederholung trägt das Audit tatsächlich nach", async () => {
    const agentId = "e2e-audit-agent";
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-e2e-audit-ws-"));
    const text = `E2E audit recovery target ${randomUUID()}`;

    const stored = await store(agentId, workspaceDir, text);
    assert.equal(stored.details.action, "stored");
    const memoryId = stored.details.id;

    // Audit-Pfad blockieren: destructive-ops.jsonl als VERZEICHNIS anlegen,
    // damit der appendFileSync des Audit-Writers fehlschlägt.
    mkdirSync(join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl"), { recursive: true });

    const firstForget = await forgetById(agentId, workspaceDir, memoryId);
    assert.match(firstForget.content[0].text, /Memory forget failed/i, "erster Forget muss bei Audit-Fehler fehlschlagen");

    // Pfad wieder freigeben → Wiederholung trägt Audit nach.
    rmSync(join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl"), { recursive: true, force: true });
    const secondForget = await forgetById(agentId, workspaceDir, memoryId);
    assert.match(secondForget.content[0].text, /forgotten/i, "zweiter Forget muss gelingen");

    const auditPath = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
    assert.ok(existsSync(auditPath), "Audit-Datei muss nach der Wiederholung existieren");
    const events = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const committed = events.filter((e) => e.memoryId === memoryId && (e.result === "committed" || e.result === "already_tombstoned"));
    assert.ok(committed.length >= 1, "Audit muss den gelöschten Memory enthalten");
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("Query-Forget mit Audit-Fehler → Wiederholung derselben Query trägt das Audit nach", async () => {
    const agentId = "e2e-query-audit-agent";
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-e2e-query-ws-"));
    const text = `E2E query recovery target ${randomUUID()}`;

    const stored = await store(agentId, workspaceDir, text);
    assert.equal(stored.details.action, "stored");
    const memoryId = stored.details.id;

    // Audit-Pfad blockieren.
    mkdirSync(join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl"), { recursive: true });

    const firstForget = await forgetByQuery(agentId, workspaceDir, text);
    assert.match(firstForget.content[0].text, /Memory forget failed for/, "erster Query-Forget muss fehlschlagen");
    assert.match(firstForget.content[0].text, new RegExp(memoryId), "Fehlermeldung muss die Ziel-ID nennen");

    // Pfad freigeben → Wiederholung DERSELBEN Query findet die gelöschte Karte
    // über die Audit-Recovery-Suche und trägt das Audit nach.
    rmSync(join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl"), { recursive: true, force: true });
    const secondForget = await forgetByQuery(agentId, workspaceDir, text);
    assert.match(secondForget.content[0].text, /Forgotten/, "Wiederholung muss die Recovery erreichen");

    const auditPath = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
    assert.ok(existsSync(auditPath), "Audit-Datei muss nach der Wiederholung existieren");
    const events = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const committed = events.filter((e) => e.memoryId === memoryId && (e.result === "committed" || e.result === "already_tombstoned"));
    assert.ok(committed.length >= 1, "Audit muss den gelöschten Memory enthalten");
    rmSync(workspaceDir, { recursive: true, force: true });
  });
});
