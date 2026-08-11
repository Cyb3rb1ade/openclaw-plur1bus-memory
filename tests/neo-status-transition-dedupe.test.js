// tests/neo-status-transition-dedupe.test.js
//
// Regression: Nach einer Status-Transition blieb die alte, un-bestrafte Kopie
// eines Records im Recall sichtbar.
//
// `transitionRecordStatus` hängt eine neue JSONL-Zeile unter derselben id an,
// statt die alte zu ersetzen — die Stores sind append-only Event-Logs.
// `routeNeoRecall` deduplizierte am Eingang nach Array-Reihenfolge und behielt
// damit die Zeile von VOR der Transition. Ein auf `demoted` gesetzter Record
// wurde also mit seinem alten `active`-Status bewertet und erschien im Prompt,
// als wäre nie etwas gewesen — die Statusstrafe lief vollständig ins Leere.
//
// Gemessen vor dem Fix: active=0.371 vs. demoted=-0.116 bei einem
// Live-`minScore` von 0.08. Die veraltete Kopie kam durch, die aktuelle wäre
// herausgefiltert worden.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNeoStore,
  transitionRecordStatus,
  routeNeoRecall,
  scoreNeoRecallItem,
  formatNeoRecallContext,
} from "../lib/neo-arch.js";

const QUERY = "gateway systemd service neustart";
// Live-Wert aus index.js (Auto-Recall-Callsite).
const LIVE_MIN_SCORE = 0.08;
const REQUESTER = { requesterWorkspaceKey: "ws1" };

function makeRecord(overrides = {}) {
  return {
    id: "rec-dedupe-1",
    kind: "memory_candidate",
    lane: "workspace_facts",
    category: "fact",
    statement: "Der Gateway läuft als systemd-Service und wird per Cron überwacht.",
    status: "active",
    salience: 0.8,
    recency: 0.8,
    createdAt: "2026-08-01T10:00:00.000Z",
    visibility: { scope: "workspace_shared" },
    workspaceKey: "ws1",
    ...overrides,
  };
}

function surfacedFor(records) {
  const routed = routeNeoRecall(records, QUERY, {
    maxPerLane: 5,
    minScore: LIVE_MIN_SCORE,
    ...REQUESTER,
  });
  return Object.values(routed).flat().filter((row) => row.item?.id === "rec-dedupe-1");
}

describe("Neo-Status-Transition — die veraltete Kopie darf nicht gewinnen", () => {
  it("demoted wird schlechter bewertet als active (Referenzpunkt)", () => {
    const active = scoreNeoRecallItem(makeRecord(), QUERY);
    const demoted = scoreNeoRecallItem(makeRecord({ status: "demoted" }), QUERY);

    assert.ok(active > LIVE_MIN_SCORE, `active (${active}) sollte über minScore liegen`);
    assert.ok(demoted < active, `demoted (${demoted}) muss schlechter sein als active (${active})`);
  });

  it("der Store behält beide Revisionen — das ist gewollt (Event-Log)", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-neo-dedupe-"));
    try {
      const store = createNeoStore(dir, "default");
      const original = makeRecord();
      store.appendCandidates([original]);
      store.appendCandidates([transitionRecordStatus(original, "demoted")]);

      const stored = store.readCandidates(500).filter((r) => r.id === original.id);
      assert.equal(stored.length, 2, "append-only: beide Revisionen liegen im Store");
      assert.deepEqual(stored.map((r) => r.status), ["active", "demoted"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("der Recall zeigt nur die jüngste Revision, nicht die veraltete", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-neo-dedupe-"));
    try {
      const store = createNeoStore(dir, "default");
      const original = makeRecord();
      store.appendCandidates([original]);
      store.appendCandidates([transitionRecordStatus(original, "demoted")]);

      const stored = store.readCandidates(500);
      const surfaced = surfacedFor(stored);

      // Der demoted-Record fällt unter minScore — er darf gar nicht erscheinen.
      // Erscheint er doch, dann nur als demoted, niemals als active.
      assert.equal(
        surfaced.length,
        0,
        `demoted liegt unter minScore und darf nicht erscheinen; erschien aber als `
          + `"${surfaced[0]?.item?.status}" mit Score ${surfaced[0]?.score?.toFixed(3)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Dedup wählt nach Revisionszeit, nicht nach Array-Reihenfolge", () => {
    const active = makeRecord();
    const demoted = transitionRecordStatus(active, "demoted");

    // Beide Reihenfolgen müssen dasselbe Ergebnis liefern.
    for (const order of [[active, demoted], [demoted, active]]) {
      const surfaced = surfacedFor(order);
      assert.equal(
        surfaced.length,
        0,
        `Reihenfolge darf das Ergebnis nicht ändern; erschien "${surfaced[0]?.item?.status}"`,
      );
    }
  });

  it("Records ohne Zeitstempel brechen die Dedup nicht", () => {
    const undated = makeRecord({ createdAt: undefined });
    const alsoUndated = makeRecord({ createdAt: undefined, salience: 0.1 });

    assert.doesNotThrow(() => surfacedFor([undated, alsoUndated]));
    // Eine datierte Revision schlägt eine undatierte.
    const dated = makeRecord({ status: "demoted", updatedAt: "2026-08-11T12:00:00.000Z" });
    const surfaced = surfacedFor([undated, dated]);
    assert.equal(surfaced.length, 0, "die datierte demoted-Revision muss gewinnen");
  });
});

describe("Neo-Prompt — Status ist für das Modell sichtbar", () => {
  it("rendert status im memory-record", () => {
    const out = formatNeoRecallContext({
      workspace_facts: [{ item: makeRecord({ status: "conflict" }), score: 0.42 }],
    });

    assert.match(out, /status="conflict"/, `status-Attribut fehlt in: ${out}`);
  });

  it("fällt ohne gesetzten Status auf active zurück", () => {
    const out = formatNeoRecallContext({
      workspace_facts: [{ item: makeRecord({ status: undefined }), score: 0.42 }],
    });

    assert.match(out, /status="active"/, `Fallback fehlt in: ${out}`);
  });
});
