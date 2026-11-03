/**
 * tests/neo-read-merge-revisions.test.js
 *
 * createNeoStore readMerged:
 *  - Mit Legacy-Journal wurde nach createdAt sortiert und mit slice(-limit)
 *    geschnitten. Die Revisionszeit (updatedAt) zaehlte nicht: die juengste
 *    Revision eines alten Records fiel heraus, und bei gleicher id gewann
 *    "canonical" auch dann, wenn die Legacy-Zeile die neuere Revision war.
 *  - Die ACL wurde erst nach dem Tail-Read angewendet. Bei mehr als `limit`
 *    fremden Zeilen am Dateiende bekam ein Agent seine eigenen aelteren
 *    Records nicht zu sehen.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createNeoStore } from "../lib/neo-arch.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function writeLines(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

const iso = (day, sec = 0) => new Date(Date.UTC(2026, 0, day, 0, 0, sec)).toISOString();

function privateRecord(id, agentId, createdAt, extra = {}) {
  return {
    id,
    agentId,
    workspaceKey: "ws",
    status: "active",
    statement: `statement ${id}`,
    createdAt,
    visibility: { scope: "agent_private", agentId },
    ...extra,
  };
}

describe("readMerged mit Legacy-Journal: Revisionszeit", () => {
  it("die juengste Revision eines alten Records faellt nicht aus dem limit-Fenster", (t) => {
    const root = makeTempDir("neo-merge-rev-");
    const store = createNeoStore(root, "legacy-rev-ws");
    // Alter Record (createdAt Januar), spaeter promotet (updatedAt Juni).
    writeLines(store.legacyPaths.candidates, [
      { id: "old", status: "active", statement: "old one", createdAt: iso(1) },
      { id: "l2", status: "active", statement: "l2", createdAt: iso(2) },
      { id: "l3", status: "active", statement: "l3", createdAt: iso(3) },
    ]);
    writeLines(store.paths.candidates, [
      { id: "c4", status: "active", statement: "c4", createdAt: iso(4) },
      { id: "c5", status: "active", statement: "c5", createdAt: iso(5) },
      { id: "old", status: "promoted", statement: "old one", createdAt: iso(1), updatedAt: new Date(Date.UTC(2026, 5, 1)).toISOString() },
    ]);

    const rows = store.readCandidates(3);
    assert.equal(rows.length, 3);
    const old = rows.find((r) => r.id === "old");
    assert.ok(old, "die promotete Revision von 'old' muss im Ergebnis sein");
    assert.equal(old.status, "promoted");
    assert.equal(rows.filter((r) => r.id === "old").length, 1);
  });

  it("bei gleicher id gewinnt die neuere Revision, auch wenn sie aus dem Legacy-Journal stammt", (t) => {
    const root = makeTempDir("neo-merge-newer-legacy-");
    const store = createNeoStore(root, "legacy-newer-ws");
    writeLines(store.paths.candidates, [
      { id: "x", status: "active", statement: "x", createdAt: iso(1) },
    ]);
    writeLines(store.legacyPaths.candidates, [
      { id: "x", status: "demoted", statement: "x", createdAt: iso(1), updatedAt: iso(9) },
    ]);
    const rows = store.readCandidates(10).filter((r) => r.id === "x");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "demoted");
  });

  it("Gegenprobe: bei gleicher Revisionszeit gewinnt weiter canonical", () => {
    const root = makeTempDir("neo-merge-tie-");
    const store = createNeoStore(root, "legacy-tie-ws");
    writeLines(store.legacyPaths.candidates, [{ id: "x", statement: "legacy", createdAt: iso(1) }]);
    writeLines(store.paths.candidates, [{ id: "x", statement: "canonical", createdAt: iso(1) }]);
    const rows = store.readCandidates(10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].statement, "canonical");
  });

  it("Gegenprobe: ohne Revisionen bleibt es bei den juengsten N nach createdAt, aufsteigend", () => {
    const root = makeTempDir("neo-merge-plain-");
    const store = createNeoStore(root, "legacy-plain-ws");
    writeLines(store.legacyPaths.candidates, [1, 2, 3].map((d) => ({ id: `l${d}`, statement: `l${d}`, createdAt: iso(d) })));
    writeLines(store.paths.candidates, [4, 5, 6].map((d) => ({ id: `c${d}`, statement: `c${d}`, createdAt: iso(d) })));
    assert.deepEqual(store.readCandidates(4).map((r) => r.id), ["l3", "c4", "c5", "c6"]);
  });
});

describe("readMerged: ACL vor dem Schnitt", () => {
  const agentA = { requesterAgentId: "agent-a" };

  it("eigene aeltere Records bleiben sichtbar, wenn mehr als limit fremde Zeilen folgen", () => {
    const root = makeTempDir("neo-acl-tail-");
    const store = createNeoStore(root, "acl-tail-ws");
    const rows = [
      privateRecord("a1", "agent-a", iso(1)),
      privateRecord("a2", "agent-a", iso(2)),
      ...Array.from({ length: 12 }, (_, i) => privateRecord(`b${i}`, "agent-b", iso(3, i))),
    ];
    writeLines(store.paths.candidates, rows);
    const visible = store.readCandidates(3, agentA);
    assert.deepEqual(visible.map((r) => r.id), ["a1", "a2"]);
    // Der Behavior-Store laeuft ueber denselben Pfad.
    writeLines(store.paths.behavior, rows);
    assert.deepEqual(store.readBehaviorCards(3, agentA).map((r) => r.id), ["a1", "a2"]);
  });

  it("liefert genau limit eigene Records (die juengsten), wenn es mehr gibt", () => {
    const root = makeTempDir("neo-acl-limit-");
    const store = createNeoStore(root, "acl-limit-ws");
    const rows = [];
    for (let i = 0; i < 6; i++) {
      rows.push(privateRecord(`a${i}`, "agent-a", iso(1, i)));
      rows.push(privateRecord(`b${i}`, "agent-b", iso(2, i)));
    }
    writeLines(store.paths.candidates, rows);
    assert.deepEqual(store.readCandidates(3, agentA).map((r) => r.id), ["a3", "a4", "a5"]);
  });

  it("Gegenprobe: ein Requester ohne Zugriff bekommt weiter nichts", () => {
    const root = makeTempDir("neo-acl-none-");
    const store = createNeoStore(root, "acl-none-ws");
    writeLines(store.paths.candidates, Array.from({ length: 8 }, (_, i) => privateRecord(`b${i}`, "agent-b", iso(1, i))));
    assert.deepEqual(store.readCandidates(3, agentA), []);
    assert.deepEqual(store.readCandidates(3, {}), []);
  });

  it("Gegenprobe: ohne Requester bleibt es beim einfachen Tail", () => {
    const root = makeTempDir("neo-acl-norequester-");
    const store = createNeoStore(root, "acl-norequester-ws");
    writeLines(store.paths.candidates, Array.from({ length: 8 }, (_, i) => privateRecord(`b${i}`, "agent-b", iso(1, i))));
    assert.deepEqual(store.readCandidates(3).map((r) => r.id), ["b5", "b6", "b7"]);
  });

  it("abgeleitete Stores (Graph-Kanten) bekommen dieselbe Behandlung", () => {
    const root = makeTempDir("neo-acl-graph-");
    const store = createNeoStore(root, "acl-graph-ws");
    const edge = (id, agentId, sec) => ({
      id, source: `s-${id}`, target: `t-${id}`, type: "semantic", agentId,
      visibility: { scope: "agent_private", agentId }, createdAt: iso(1, sec),
    });
    writeLines(store.paths.graph, [
      edge("e-own-1", "agent-a", 0),
      edge("e-own-2", "agent-a", 1),
      ...Array.from({ length: 10 }, (_, i) => edge(`e-foreign-${i}`, "agent-b", 10 + i)),
    ]);
    assert.deepEqual(store.readGraphEdges(3, agentA).map((r) => r.id), ["e-own-1", "e-own-2"]);
  });
});
