/**
 * tests/tombstone-query-recovery.test.js
 *
 * Negative Eval: die Audit-Recovery-Suche muss forgetThreshold respektieren und
 * darf keinen Klartext gelöschter Erinnerungen ausgeben. Mit echten,
 * textabhängigen Vektoren: exakte Wiederholung repariert das Audit, eine
 * unpassende Query liefert "No matching memory found".
 */

import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { tombstoneRegistryDir } from "../lib/tombstone.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const VECTOR_DIM = 384;

// Text-dependent unit vector whose 384 components are independent SHA-256
// draws: distinct texts are near-orthogonal (cosine ~ N(0, 1/sqrt(384)), max
// 0.22 over 100 000 random pairs), identical texts are identical.
//
// The previous vector derived every component from one 32-bit FNV hash as a
// sawtooth `(hash + i*K) mod 2^32 mod 2000`; two hashes whose difference was
// near a multiple of 2000 gave almost the same vector. With the random UUID
// in `exactText`, ~0.1% of runs put "completely unrelated query" within
// forgetThreshold 0.9 (score 1/(1+squared L2)) of the deleted card, and the
// unrelated query recovered its audit (windows-2025 node 24.16.0, PR #235).
function textVector(text) {
  const raw = [];
  for (let block = 0; raw.length < VECTOR_DIM; block += 1) {
    const digest = createHash("sha256").update(`${block}\0${text}`).digest();
    for (let offset = 0; offset < digest.length && raw.length < VECTOR_DIM; offset += 2) {
      raw.push(digest.readUInt16BE(offset) / 32767.5 - 1);
    }
  }
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
  let testRoot;
  let baseDbPath;
  let originalEmbedQuery;
  let originalEmbedPassage;

  before(() => {
    testRoot = makeTempDir("plur1bus-query-recovery-");
    baseDbPath = join(testRoot, "db");
    mkdirSync(baseDbPath);
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
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("uses a suite-private tombstone registry instead of the shared temp root", () => {
    assert.equal(tombstoneRegistryDir(baseDbPath), join(testRoot, "_tombstones"));
    assert.notEqual(tombstoneRegistryDir(baseDbPath), join(tmpdir(), "_tombstones"));
  });

  it("exakte Wiederholung repariert das Audit; unpassende Query liefert 'No matching memory found'", async () => {
    const agentId = "query-recovery-agent";
    const workspaceDir = makeTempDir("plur1bus-query-recovery-ws-");
    const exactText = `exact target ${randomUUID()}`;
    const unrelatedQuery = "completely unrelated query";
    // Precondition: the unrelated query is far below forgetThreshold, so only
    // the threshold (not vector luck) can keep the deleted card out.
    const exactVector = textVector(exactText);
    const cosine = textVector(unrelatedQuery).reduce((sum, v, i) => sum + v * exactVector[i], 0);
    assert.ok(cosine < 0.5, `fixture vectors must be dissimilar (cosine ${cosine})`);

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
