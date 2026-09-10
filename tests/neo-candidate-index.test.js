import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildNeoCandidateIndexForDir,
  candidateIndexEntry,
  createNeoStore,
  readCandidateIndex,
  searchNeoCandidatesGlobal,
  transitionRecordStatus,
} from "../lib/neo-arch.js";

// 7.12.28: Kandidaten-Metadatenindex (candidate-index.jsonl).
const NOW = Date.parse("2026-09-10T00:00:00Z");
const DAY = 86_400_000;

function candidate(id, statement, extra = {}) {
  return {
    id, workspaceKey: "ws", agentId: "bernhardine", statement, normalizedStatement: statement.toLowerCase(),
    sourceTurnIds: ["turn-1"], status: "candidate", embeddingStatus: "pending", impact: "low",
    visibility: { scope: "agent_private" },
    origin: { kind: "user_claim", role: "user", trustLevel: "user_asserted", sourceTurnIds: ["turn-1"], capturedBy: "test" },
    createdAt: new Date(NOW - DAY).toISOString(), ...extra,
  };
}

const REQUESTER = { requesterAgentId: "bernhardine", requesterWorkspaceKey: "ws" };

function withTmp(fn) {
  const root = mkdtempSync(join(tmpdir(), "neo-cidx-"));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function lines(path) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

describe("candidate index", () => {
  it("projects a slim entry that keeps ACL, scoring and rendering fields", () => {
    const entry = candidateIndexEntry(candidate("mem-1", "Eva trinkt Tee.", { salience: 0.7, epistemicStatus: "validated" }));
    assert.equal(entry.id, "mem-1");
    assert.equal(entry.statement, "Eva trinkt Tee.");
    assert.deepEqual(entry.visibility, { scope: "agent_private" });
    assert.deepEqual(entry.origin, { kind: "user_claim", role: "user", trustLevel: "user_asserted" });
    assert.equal(entry.salience, 0.7);
    assert.equal(entry.epistemicStatus, "validated");
    assert.equal(entry.normalizedStatement, undefined, "normalizedStatement is not indexed");
    assert.equal(entry.embeddingStatus, undefined, "embedding bookkeeping is not indexed");
    assert.equal(candidateIndexEntry({ statement: "no id" }), null);
  });

  it("is maintained on append and read incrementally (cached → tail, partial lines held back)", () => withTmp((root) => {
    const store = createNeoStore(root, "ws");
    store.appendCandidates([candidate("mem-1", "Eins."), candidate("mem-2", "Zwei.")]);
    assert.equal(lines(store.paths.candidateIndex).length, 2);
    // Der Append-Pfad hat den Index im selben Prozess schon gelesen (Self-Heal).
    let index = store.readCandidateIndex();
    assert.equal(index.mode, "cached");
    assert.equal(index.entries.size, 2);
    // Ein anderer Thread (Worker) haengt an: nur der Tail wird geparst.
    appendRaw(store.paths.candidateIndex, JSON.stringify(candidateIndexEntry(candidate("mem-3", "Drei."))) + "\n");
    index = store.readCandidateIndex();
    assert.equal(index.mode, "tail");
    assert.equal(index.parsedLines, 1);
    assert.equal(index.entries.size, 3);
    assert.equal(index.lines, 3);
    // Eine angeschnittene Zeile (Append noch nicht fertig) wird nicht konsumiert …
    const half = JSON.stringify(candidateIndexEntry(candidate("mem-4", "Vier.")));
    appendRaw(store.paths.candidateIndex, half.slice(0, 20));
    index = store.readCandidateIndex();
    assert.equal(index.mode, "tail");
    assert.equal(index.parsedLines, 0);
    assert.equal(index.entries.size, 3);
    // … und beim naechsten Lesen vollstaendig nachgeladen.
    appendRaw(store.paths.candidateIndex, half.slice(20) + "\n");
    index = store.readCandidateIndex();
    assert.equal(index.mode, "tail");
    assert.equal(index.parsedLines, 1);
    assert.equal(index.entries.get("mem-4").statement, "Vier.");
    assert.equal(store.readCandidateIndex().mode, "cached");
  }));

  it("keeps the newest revision per id, so a demotion removes the record from the search", () => withTmp(async (root) => {
    const store = createNeoStore(root, "ws");
    const items = [candidate("mem-1", "Eins."), candidate("mem-2", "Zwei.")];
    store.appendCandidates(items);
    store.appendEmbeddingQueue(items);
    await store.drainEmbeddingQueue({ impact: "low", maxItems: 10, embedder: () => [1, 0, 0, 0], dimensions: 4 });
    const before = searchNeoCandidatesGlobal(store, { queryVector: [1, 0, 0, 0], requester: REQUESTER, now: NOW });
    assert.deepEqual(before.hits.map((h) => h.item.id).sort(), ["mem-1", "mem-2"]);
    store.appendCandidates([transitionRecordStatus(items[0], "demoted", { now: new Date(NOW).toISOString() })]);
    const index = store.readCandidateIndex();
    assert.equal(index.lines, 3, "revision appended, not replaced");
    assert.equal(index.entries.get("mem-1").status, "demoted");
    const after = searchNeoCandidatesGlobal(store, { queryVector: [1, 0, 0, 0], requester: REQUESTER, now: NOW });
    assert.deepEqual(after.hits.map((h) => h.item.id), ["mem-2"]);
    assert.equal(after.index, "cached", "append path already parsed the new line in-process");
    // Treffer sind Kopien: der Cache-Eintrag traegt keinen Vektor.
    assert.equal(Object.hasOwn(index.entries.get("mem-2"), "embedding"), false);
    assert.equal(after.hits[0].item.embedding.length, 4);
  }));

  it("bootstraps from an existing journal and self-heals lines written without an index", () => withTmp((root) => {
    const store = createNeoStore(root, "ws");
    store.appendCandidates([candidate("mem-1", "Eins."), candidate("mem-2", "Zwei.")]);
    rmSync(store.paths.candidateIndex);
    assert.equal(store.readCandidateIndex().mode, "missing");
    // Suche ohne Index faellt auf das Journal-Fenster zurueck.
    const fallback = searchNeoCandidatesGlobal(store, { queryVector: [1, 0, 0, 0], requester: REQUESTER, now: NOW });
    assert.equal(fallback.index, "missing");
    assert.equal(fallback.unique, 2);
    // Naechster Append baut den Index aus dem Journal auf.
    store.appendCandidates([candidate("mem-3", "Drei.")]);
    const index = store.readCandidateIndex();
    assert.deepEqual([...index.entries.keys()].sort(), ["mem-1", "mem-2", "mem-3"]);
    // Self-Heal: eine Journalzeile ohne Index-Zeile (aelterer Plugin-Stand)
    // wird beim naechsten Append nachgetragen.
    rmSync(store.paths.candidateIndex);
    store.appendCandidates([candidate("mem-4", "Vier.")]);
    assert.equal(store.readCandidateIndex().entries.size, 4);
    const journalOnly = candidate("mem-5", "Fuenf.");
    // Journal direkt erweitern, ohne den Store (simuliert 7.12.27).
    appendRaw(store.paths.candidates, JSON.stringify(journalOnly) + "\n");
    store.appendCandidates([candidate("mem-6", "Sechs.")]);
    assert.deepEqual([...store.readCandidateIndex().entries.keys()].sort(), ["mem-1", "mem-2", "mem-3", "mem-4", "mem-5", "mem-6"]);
  }));

  it("compacts to one line per id, drops non-searchable statuses, caps by revision time, and the reader detects the rewrite", () => withTmp((root) => {
    const store = createNeoStore(root, "ws");
    const items = [
      candidate("mem-old", "Alt.", { createdAt: new Date(NOW - 10 * DAY).toISOString() }),
      candidate("mem-mid", "Mittel.", { createdAt: new Date(NOW - 5 * DAY).toISOString() }),
      candidate("mem-new", "Neu.", { createdAt: new Date(NOW - DAY).toISOString() }),
      candidate("mem-gone", "Weg.", { status: "pruned" }),
    ];
    store.appendCandidates(items);
    store.appendCandidates([transitionRecordStatus(items[2], "promoted", { now: new Date(NOW).toISOString() })]);
    const before = store.readCandidateIndex();
    assert.equal(before.lines, 5);
    const report = store.compactCandidateIndex({ maxEntries: 2 });
    assert.equal(report.rewritten, true);
    assert.equal(report.removedStatus, 1, "pruned entry dropped");
    assert.equal(report.removedCap, 1, "oldest searchable entry capped");
    assert.equal(report.after, 2);
    const after = store.readCandidateIndex();
    assert.equal(after.mode, "full", "new inode forces a full reload");
    assert.deepEqual([...after.entries.keys()].sort(), ["mem-mid", "mem-new"]);
    assert.equal(after.entries.get("mem-new").status, "promoted");
    assert.equal(store.compactCandidateIndex().rewritten, false, "nothing left to compact");
  }));

  it("keeps candidates (and their vectors) searchable after the journal cap dropped them", () => withTmp(async (root) => {
    const store = createNeoStore(root, "ws");
    const items = [
      candidate("mem-old", "Der Server steht im Keller.", { createdAt: new Date(NOW - 10 * DAY).toISOString() }),
      candidate("mem-a", "Eins.", { createdAt: new Date(NOW - 3 * DAY).toISOString() }),
      candidate("mem-b", "Zwei.", { createdAt: new Date(NOW - 2 * DAY).toISOString() }),
      candidate("mem-c", "Drei.", { createdAt: new Date(NOW - DAY).toISOString() }),
    ];
    store.appendCandidates(items);
    store.appendEmbeddingQueue(items);
    const vectors = { "mem-old": [0, 0, 1, 0], "mem-a": [1, 0, 0, 0], "mem-b": [1, 0, 0, 0], "mem-c": [1, 0, 0, 0] };
    await store.drainEmbeddingQueue({ impact: "low", maxItems: 10, embedder: (_t, target) => vectors[target.id], dimensions: 4 });
    // Journal auf zwei Zeilen kappen: mem-old (und mehr) verschwindet aus dem Fenster.
    const prune = store.pruneAll({ maxRecords: 2 });
    assert.ok(prune.candidates.after <= 2);
    assert.equal(prune.candidateIndex.after, 4, "index keeps every candidate");
    assert.equal(prune.vectors.orphans, 0, "vectors of indexed candidates survive compaction");
    assert.equal(store.readCandidates(10).some((r) => r.id === "mem-old"), false, "journal window no longer holds mem-old");
    const result = searchNeoCandidatesGlobal(store, { queryVector: [0, 0, 1, 0], requester: REQUESTER, now: NOW, minSimilarity: 0.5 });
    assert.deepEqual(result.hits.map((h) => h.item.id), ["mem-old"]);
    assert.equal(result.hits[0].item.statement, "Der Server steht im Keller.");
    assert.equal(store.readVector("mem-old").length, 4);
  }));

  it("builds the index for a workspace directory (deploy script path) and refuses to overwrite without --rebuild", () => withTmp((root) => {
    const store = createNeoStore(root, "ws");
    store.appendCandidates([candidate("mem-1", "Eins."), candidate("mem-2", "Zwei.")]);
    rmSync(store.paths.candidateIndex);
    const dry = buildNeoCandidateIndexForDir(store.paths.workspaceDir, { dryRun: true });
    assert.equal(dry.built, true);
    assert.equal(dry.entries, 2);
    assert.equal(existsSync(store.paths.candidateIndex), false);
    const built = buildNeoCandidateIndexForDir(store.paths.workspaceDir);
    assert.equal(built.built, true);
    const size = statSync(store.paths.candidateIndex).size;
    assert.equal(buildNeoCandidateIndexForDir(store.paths.workspaceDir).reason, "exists");
    assert.equal(statSync(store.paths.candidateIndex).size, size);
    assert.equal(buildNeoCandidateIndexForDir(store.paths.workspaceDir, { rebuild: true }).built, true);
    assert.equal(readCandidateIndex(store.paths).entries.size, 2);
  }));
});

function appendRaw(path, data) {
  appendFileSync(path, data, "utf8");
}
