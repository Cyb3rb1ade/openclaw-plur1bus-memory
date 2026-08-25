/**
 * tests/tombstone-query-recovery.test.js
 *
 * Negative Eval: die Audit-Recovery-Suche muss forgetThreshold respektieren und
 * darf keinen Klartext gelöschter Erinnerungen ausgeben. Mit echten,
 * textabhängigen Vektoren: exakte Wiederholung repariert das Audit, eine
 * unpassende Query liefert "No matching memory found".
 */

import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

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

describe("query audit recovery respektiert forgetThreshold ohne Klartext", () => {
  let api;
  let baseDbPath;
  let tempRoot;
  let originalEmbedQuery;
  let originalEmbedPassage;

  before(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "plur1bus-query-recovery-"));
    baseDbPath = join(tempRoot, "lancedb");
    originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async function (text) {
      return textVector(text);
    };
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function (text) {
      return textVector(text);
    };
    api = makeMockApi(baseDbPath);
    plugin.register(api);
  });

  after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("exakte Wiederholung repariert das Audit; unpassende Query liefert 'No matching memory found'", async () => {
    const agentId = "query-recovery-agent";
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-query-recovery-ws-"));
    const exactText = `exact target ${randomUUID()}`;
    const unrelatedQuery = "completely unrelated query";

    const tools = api._toolFactory({ agentId, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");
    const forgetTool = tools.find((t) => t.name === "memory_forget");

    const stored = await storeTool.execute("store", { text: exactText, category: "fact" });
    assert.equal(stored.details.action, "stored");
    const memoryId = stored.details.id;

    // Audit-Pfad blockieren.
    mkdirSync(join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl"), { recursive: true });

    const firstForget = await forgetTool.execute("forget-query-1", { query: exactText });
    assert.match(firstForget.content[0].text, /Memory forget failed for/, "erster Forget muss am Audit scheitern");
    assert.match(firstForget.content[0].text, new RegExp(memoryId));

    // Pfad freigeben.
    rmSync(join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl"), { recursive: true, force: true });

    // Unpassende Query: darf die gelöschte Karte NICHT finden (Threshold).
    const unrelated = await forgetTool.execute("forget-query-unrelated", { query: unrelatedQuery });
    assert.equal(unrelated.content[0].text, "No matching memory found.");
    assert.doesNotMatch(JSON.stringify(unrelated), new RegExp(exactText), "kein Klartext gelöschter Inhalte");
    const auditPath = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
    assert.equal(existsSync(auditPath), false, "unpassende Query darf kein Audit erzeugen");

    // Exakte Wiederholung: Recovery trägt das Audit nach, ohne Klartext.
    const retry = await forgetTool.execute("forget-query-retry", { query: exactText });
    assert.match(retry.content[0].text, /Forgotten \(audit recovered for/);
    assert.match(retry.content[0].text, new RegExp(memoryId));
    assert.doesNotMatch(retry.content[0].text, new RegExp("exact target"), "kein Klartext in der Erfolgsmeldung");

    assert.ok(existsSync(auditPath), "Audit muss nach der exakten Wiederholung existieren");
    const events = readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((e) => e.memoryId === memoryId && (e.result === "committed" || e.result === "already_tombstoned")));
    rmSync(workspaceDir, { recursive: true, force: true });
  });
});
