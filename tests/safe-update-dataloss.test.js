/**
 * tests/safe-update-dataloss.test.js
 *
 * Regression: safeUpdate's semantic-content path must store the new version
 * BEFORE marking the old row superseded. If db.store fails after the supersede,
 * the old memory is hidden from active queries while the replacement never
 * exists — silent, unrecoverable data loss.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { buildUpdateEntry, safeUpdate } from "../lib/safe-update.js";

const OLD_ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  text: "Original fact",
  summary: "Original fact",
  vector: [0.1, 0.2, 0.3],
  scope: "agent-private",
  agentId: "agent-a",
  storedBy: "agent-a",
  workspaceId: "",
  workspaceKey: "",
  ownerUserId: "",
  status: "active",
  versionNumber: 1,
};
const PATCH = { text: "Corrected fact", vector: [0.11, 0.21, 0.31] };
const EVIDENCE = { updateSource: "test", updateEvidence: "unit test", confidence: 0.9 };
const EMPTY_WORKSPACE_ALIASES = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });

describe("safeUpdate — supersede-after-store ordering", () => {
  it("preserves the exact valid binding for workspace and user replacements", () => {
    const workspaceNext = buildUpdateEntry({
      ...OLD_ROW,
      scope: "workspace",
      workspaceId: "ws-a",
      workspaceKey: "ws-a",
    }, PATCH, EVIDENCE, {
      agentId: "requester-agent",
      workspaceId: "requester-workspace",
      ownerUserId: `user:v1:${"b".repeat(64)}`,
    });
    assert.equal(workspaceNext.agentId, "agent-a");
    assert.equal(workspaceNext.storedBy, "agent-a");
    assert.equal(workspaceNext.workspaceId, "ws-a");
    assert.equal(workspaceNext.workspaceKey, "ws-a");
    assert.equal(workspaceNext.ownerUserId, "");

    const ownerUserId = `user:v1:${"a".repeat(64)}`;
    const userNext = buildUpdateEntry({
      ...OLD_ROW,
      scope: "user",
      workspaceId: "",
      workspaceKey: "",
      ownerUserId,
    }, PATCH, EVIDENCE);
    assert.equal(userNext.agentId, "agent-a");
    assert.equal(userNext.storedBy, "agent-a");
    assert.equal(userNext.workspaceId, "");
    assert.equal(userNext.workspaceKey, "");
    assert.equal(userNext.ownerUserId, ownerUserId);
  });

  it("rejects an unbound or conflicting source before idempotency or writes", async () => {
    for (const oldRow of [
      { ...OLD_ROW, scope: "workspace", workspaceId: "", workspaceKey: "" },
      { ...OLD_ROW, agentId: "agent-a", storedBy: "agent-b" },
    ]) {
      const storeCalls = [];
      const updateCalls = [];
      let idempotencyReads = 0;
      const db = {
        getById: async () => oldRow,
        store: async (entry) => storeCalls.push(entry),
        update: async (...args) => updateCalls.push(args),
      };
      const neoStore = {
        async readReconsolidationEvents() {
          idempotencyReads += 1;
          return [];
        },
      };

      await assert.rejects(
        () => safeUpdate(db, oldRow.id, PATCH, EVIDENCE, {
          neoStore,
          workspaceAliases: EMPTY_WORKSPACE_ALIASES,
          skipDriftGate: true,
        }),
        /invalid ownership tuple/,
      );
      assert.equal(idempotencyReads, 0);
      assert.equal(storeCalls.length, 0);
      assert.equal(updateCalls.length, 0);
    }
  });

  it("logs idempotency read failures redacted and fails before replacement", async () => {
    const storeCalls = [];
    const updateCalls = [];
    const debugCalls = [];
    const db = {
      getById: async () => ({ ...OLD_ROW }),
      store: async (entry) => storeCalls.push(entry),
      update: async (...args) => updateCalls.push(args),
    };
    const neoStore = {
      async readReconsolidationEvents() {
        throw new Error("sqlite token=super-secret");
      },
    };

    await assert.rejects(
      () => safeUpdate(db, OLD_ROW.id, PATCH, EVIDENCE, {
        neoStore,
        logger: { debug: (...args) => debugCalls.push(args) },
        skipDriftGate: true,
      }),
      /idempotency check failed/i,
    );

    assert.equal(storeCalls.length, 0);
    assert.equal(updateCalls.length, 0);
    assert.equal(debugCalls.length, 1);
    assert.match(String(debugCalls[0][0]), /idempotency check/i);
    assert.doesNotMatch(String(debugCalls[0][0]), /super-secret|token=/i);
  });

  it("does not supersede the old row when storing the new version fails", async () => {
    let supersedeCalled = false;
    const db = {
      getById: async () => ({ ...OLD_ROW }),
      update: async () => { supersedeCalled = true; },
      store: async () => { throw new Error("simulated store failure"); },
    };

    await assert.rejects(
      () => safeUpdate(db, OLD_ROW.id, PATCH, EVIDENCE, { skipDriftGate: true }),
      /simulated store failure/,
    );

    assert.strictEqual(
      supersedeCalled,
      false,
      "old row must NOT be marked superseded when the new-version store fails (data-loss guard)",
    );
  });
});

describe("buildUpdateEntry — importanceStatus ueberlebt den Update-Pfad", () => {
  // Eine Zeile, die auf ihre LLM-Bewertung wartet (pending/pending_backfill),
  // darf durch einen inhaltsaendernden safeUpdate() nicht stillschweigend auf
  // "final" zurueckfallen — sonst faellt sie aus der Importance-Queue, ohne
  // je bewertet worden zu sein.
  it("uebernimmt pending_backfill von der alten Zeile in die neue Version", () => {
    const next = buildUpdateEntry({
      ...OLD_ROW,
      importanceStatus: "pending_backfill",
    }, PATCH, EVIDENCE);
    assert.strictEqual(next.importanceStatus, "pending_backfill");
  });

  it("normalisiert einen kaputten Altwert genauso wie normalizeEntryForTable", () => {
    const next = buildUpdateEntry({
      ...OLD_ROW,
      importanceStatus: "quatsch",
    }, PATCH, EVIDENCE);
    assert.strictEqual(next.importanceStatus, "final");
  });

  // Abschluss-Review, Important 3: setzt der Agent bewusst patch.importance
  // auf einer noch pending Zeile, wird die alte pending-Vererbung zur Falle —
  // die Zeile bleibt pending, und der stündliche emotion-refine-Cron
  // überschreibt das bewusste Urteil innerhalb der nächsten Stunde mit einem
  // eigenen, unter Umständen niedrigeren Wert. Ein explizit gesetzter Wert
  // ist per Definition nicht mehr pending.
  it("schließt eine pending Zeile ab, wenn der Patch ein importance trägt", () => {
    const next = buildUpdateEntry({
      ...OLD_ROW,
      importance: 0.5,
      importanceStatus: "pending",
    }, { ...PATCH, importance: 0.85 }, EVIDENCE);
    assert.strictEqual(next.importance, 0.85);
    assert.strictEqual(next.importanceStatus, "final");
  });

  it("vererbt pending weiterhin, wenn der Patch kein importance trägt", () => {
    const next = buildUpdateEntry({
      ...OLD_ROW,
      importance: 0.5,
      importanceStatus: "pending",
    }, PATCH, EVIDENCE);
    assert.strictEqual(next.importance, 0.5);
    assert.strictEqual(next.importanceStatus, "pending");
  });
});

// Koordinator-Korrektur 19.09.2026: dieselbe Regel gilt auch für den
// Metadata-only-Zweig von safeUpdate() selbst (Schritt 6, inlinePatch) — der
// vermutlich häufigere Agentenpfad, weil er ohne Text-/Summary-Änderung
// auskommt. buildUpdateEntry allein deckt ihn nicht ab: ein Patch, der nur
// importance (kein text/summary) trägt, nimmt gar nicht den
// buildUpdateEntry-Pfad, sondern das inline db.update() weiter unten.
describe("safeUpdate — importanceStatus auf dem Metadata-only-Pfad (inlinePatch)", () => {
  it("schließt eine pending Zeile ab, wenn der Metadata-only-Patch ein importance trägt", async () => {
    const updateCalls = [];
    const db = {
      getById: async () => ({ ...OLD_ROW, importance: 0.5, importanceStatus: "pending" }),
      update: async (...args) => updateCalls.push(args),
      store: async () => { throw new Error("darf für einen Metadata-only-Patch nicht aufgerufen werden"); },
    };

    const result = await safeUpdate(db, OLD_ROW.id, { importance: 0.85 }, {}, {});

    assert.strictEqual(result.inline, true);
    assert.strictEqual(updateCalls.length, 1);
    const [updatedId, inlinePatch] = updateCalls[0];
    assert.strictEqual(updatedId, OLD_ROW.id);
    assert.strictEqual(inlinePatch.importance, 0.85);
    assert.strictEqual(inlinePatch.importanceStatus, "final");
  });

  it("lässt importanceStatus unangetastet, wenn der Metadata-only-Patch kein importance trägt", async () => {
    const updateCalls = [];
    const db = {
      getById: async () => ({ ...OLD_ROW, importance: 0.5, importanceStatus: "pending" }),
      update: async (...args) => updateCalls.push(args),
      store: async () => { throw new Error("darf für einen Metadata-only-Patch nicht aufgerufen werden"); },
    };

    const result = await safeUpdate(db, OLD_ROW.id, { category: "project" }, {}, {});

    assert.strictEqual(result.inline, true);
    assert.strictEqual(updateCalls.length, 1);
    const [, inlinePatch] = updateCalls[0];
    assert.strictEqual(inlinePatch.category, "project");
    assert.strictEqual(Object.hasOwn(inlinePatch, "importanceStatus"), false);
  });
});

describe("buildUpdateEntry — Int64-Spalten kommen als BigInt", () => {
  // Live-Zeile vom 09.09.2026: LanceDB liefert versionNumber, retrievalCount,
  // Zeitstempel usw. als BigInt; `1n + 1` warf und kein /correct kam je durch.
  it("rechnet die Versionsnummer hoch und liefert nur Number-Werte", () => {
    const next = buildUpdateEntry({
      ...OLD_ROW,
      versionNumber: 1n,
      retrievalCount: 7n,
      replayCount: 0n,
      lastRetrievedAt: 1788736566892n,
      sourceTimestamp: 1788736566892n,
      halfLifeDays: 30n,
      neverForget: 0n,
      expiresAt: 0n,
      validFrom: 0n,
      validUntil: 0n,
      lastStrengthenedAt: 0n,
      lastDynamicsAt: 0n,
      lastReplayed: 0n,
      epistemicStatusUpdatedAt: 0n,
      confirmed: 0n,
    }, PATCH, EVIDENCE);
    assert.strictEqual(next.versionNumber, 2);
    assert.strictEqual(next.retrievalCount, 7);
    assert.strictEqual(next.halfLifeDays, 30);
    assert.strictEqual(next.sourceTimestamp, 1788736566892);
    for (const [key, value] of Object.entries(next)) {
      assert.notStrictEqual(typeof value, "bigint", `${key} darf kein BigInt bleiben`);
    }
  });
});
