import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNeoStore, behaviorCardsFromReactions } from "../lib/neo-arch.js";
import { resolveCurationRecord } from "../lib/curation-resolve.js";
import * as curationModule from "../lib/curation-resolve.js";
import { makeTempDir } from "./helpers/temp-dir.js";

describe("resolveCurationRecord", () => {
  it("keep promotes a conflict record", () => {
    const dir = makeTempDir("curation-");
    const store = createNeoStore(dir, "default");
    const rec = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "conflict",
      statement: "x",
      category: "workflow_preference",
    };
    store.appendCandidates([rec]);
    const out = resolveCurationRecord(store, rec, "keep", { authorized: true });
    assert.equal(resolveCurationRecord(store, rec, "keep", { authorized: false }).ok, false);
    assert.equal(out.ok, true);
    const newest = store.readCandidates(50).filter((row) => row.id === rec.id).at(-1);
    assert.equal(newest.status, "promoted");
    rmSync(dir, { recursive: true, force: true });
  });
});

// Echte Behavior-Karte: behaviorCardsFromReactions erzeugt eine Konflikt-Karte
// (status "conflict"), die in behavior-cards.jsonl liegt, nicht in
// memory-candidates.jsonl.
function realConflictCard(suffix = "1") {
  const [card] = behaviorCardsFromReactions([{
    id: `react-${suffix}`,
    workspaceKey: "default",
    agentId: "agent-a",
    polarity: -1,
    explicitness: "explicit_correction",
    evidence: `nein, das ist falsch ${suffix}`,
    confidence: 0.8,
    intensity: 0.9,
    extractedAt: "2026-10-01T10:00:00.000Z",
  }]);
  assert.equal(card.status, "conflict");
  return card;
}

function candidateRow(i) {
  return {
    id: `cand-${i}`,
    workspaceKey: "default",
    agentId: "agent-a",
    status: "candidate",
    statement: `filler statement number ${i}`,
    category: "workflow_preference",
    createdAt: new Date(Date.UTC(2026, 9, 2, 0, 0, i)).toISOString(),
  };
}

describe("resolveCurationRecord: Konflikt-Karten aus behavior-cards.jsonl", () => {
  it("drop schreibt die Revision in den Behavior-Store, nicht in die Kandidaten", () => {
    const dir = makeTempDir("curation-behavior-");
    const store = createNeoStore(dir, "default");
    const card = realConflictCard();
    store.appendBehaviorCards([card]);

    const out = resolveCurationRecord(store, card, "drop", { authorized: true });
    assert.equal(out.ok, true);
    assert.equal(out.status, "demoted");

    const behaviorRows = store.readBehaviorCards(50).filter((row) => row.id === card.id);
    assert.equal(behaviorRows.at(-1).status, "demoted");
    assert.equal(store.readCandidates(50).filter((row) => row.id === card.id).length, 0,
      "die Karte darf nicht in memory-candidates.jsonl landen");
  });

  it("das Drop bleibt wirksam, auch wenn danach hunderte Kandidatenzeilen folgen", () => {
    const dir = makeTempDir("curation-behavior-flood-");
    const store = createNeoStore(dir, "default");
    const card = realConflictCard();
    store.appendBehaviorCards([card]);
    resolveCurationRecord(store, card, "drop", { authorized: true });
    store.appendCandidates(Array.from({ length: 600 }, (_, i) => candidateRow(i)));

    const latest = store.readBehaviorCards(200).filter((row) => row.id === card.id).at(-1);
    assert.equal(latest.status, "demoted");
    const unresolved = curationModule.listCurationRecords(store, "conflicts");
    assert.equal(unresolved.some((row) => row.id === card.id), false,
      "eine aufgeloeste Karte darf nicht mehr unter 'conflicts' erscheinen");
  });

  it("keep promotet eine Behavior-Karte im Behavior-Store", () => {
    const dir = makeTempDir("curation-behavior-keep-");
    const store = createNeoStore(dir, "default");
    const card = realConflictCard();
    store.appendBehaviorCards([card]);
    const out = resolveCurationRecord(store, card, "keep", { authorized: true });
    assert.equal(out.status, "promoted");
    assert.equal(store.readBehaviorCards(50).filter((row) => row.id === card.id).at(-1).status, "promoted");
    assert.equal(store.readCandidates(50).length, 0);
    const promoted = curationModule.listCurationRecords(store, "promoted");
    assert.deepEqual(promoted.map((row) => row.id), [card.id]);
  });

  it("die Revision basiert auf dem frischen Stand unter dem Lock, nicht auf der uebergebenen Kopie", () => {
    const dir = makeTempDir("curation-behavior-fresh-");
    const store = createNeoStore(dir, "default");
    const card = realConflictCard();
    store.appendBehaviorCards([card]);
    // Zwischen Lesen und Resolve schreibt jemand anderes eine neuere Revision.
    store.appendBehaviorCards([{ ...card, status: "conflict", salience: 0.1, updatedAt: "2026-10-03T00:00:00.000Z" }]);

    resolveCurationRecord(store, card, "keep", { authorized: true });
    const latest = store.readBehaviorCards(50).filter((row) => row.id === card.id).at(-1);
    assert.equal(latest.status, "promoted");
    assert.ok(Math.abs(latest.salience - 0.3) < 1e-9, `salience baut auf der frischen Revision auf (0.1 + 0.2), war ${latest.salience}`);
  });

  it("Gegenprobe: ein Kandidaten-Konflikt wird weiter im Kandidaten-Store aufgeloest", () => {
    const dir = makeTempDir("curation-candidate-stays-");
    const store = createNeoStore(dir, "default");
    const rec = { ...candidateRow(1), status: "conflict" };
    store.appendCandidates([rec]);
    const out = resolveCurationRecord(store, rec, "drop", { authorized: true });
    assert.equal(out.status, "demoted");
    assert.equal(store.readCandidates(50).filter((row) => row.id === rec.id).at(-1).status, "demoted");
    assert.equal(store.readBehaviorCards(50).length, 0);
    assert.equal(curationModule.listCurationRecords(store, "conflicts").length, 0);
  });

  it("Gegenprobe: ohne Autorisierung oder mit falscher Aktion wird nichts geschrieben", () => {
    const dir = makeTempDir("curation-behavior-denied-");
    const store = createNeoStore(dir, "default");
    const card = realConflictCard();
    store.appendBehaviorCards([card]);
    assert.equal(resolveCurationRecord(store, card, "drop", { authorized: false }).ok, false);
    assert.equal(resolveCurationRecord(store, card, "bogus", { authorized: true }).ok, false);
    assert.equal(store.readBehaviorCards(50).length, 1);
    assert.equal(curationModule.listCurationRecords(store, "conflicts").length, 1);
  });
});

describe("store.reviseRecord", () => {
  it("liest und schreibt unter dem Neo-Write-Lock", () => {
    const dir = makeTempDir("curation-revise-lock-");
    const store = createNeoStore(dir, "default");
    const card = realConflictCard();
    store.appendBehaviorCards([card]);
    const lockPath = join(store.paths.workspaceDir, ".neo-write.lock");
    assert.equal(existsSync(lockPath), false);
    let lockedDuringTransform = false;
    const out = store.reviseRecord(card.id, (current) => {
      lockedDuringTransform = existsSync(lockPath);
      return { ...current, status: "demoted", updatedAt: "2026-10-05T00:00:00.000Z" };
    });
    assert.equal(lockedDuringTransform, true);
    assert.equal(out.store, "behavior");
    assert.equal(existsSync(lockPath), false, "das Lock wird wieder freigegeben");
  });

  it("liefert null und schreibt nichts, wenn der Record unbekannt ist oder transform null liefert", () => {
    const dir = makeTempDir("curation-revise-null-");
    const store = createNeoStore(dir, "default");
    const card = realConflictCard();
    store.appendBehaviorCards([card]);
    assert.equal(store.reviseRecord("does-not-exist", (r) => r), null);
    assert.equal(store.reviseRecord(card.id, () => null), null);
    assert.equal(store.readBehaviorCards(50).length, 1);
  });
});

