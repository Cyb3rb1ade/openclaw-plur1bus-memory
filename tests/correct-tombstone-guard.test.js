/**
 * tests/correct-tombstone-guard.test.js
 *
 * M4: correctCard liest über db.getCard(), das keinen Status-Filter hat, und
 * prüfte card.status nicht. Auf einer getombsteinten Zeile hätte updateCard eine
 * NEUE aktive Zeile mit neuer ID angelegt und die alte von "deleted" auf
 * "superseded" überschrieben — eine Resurrection, die auch
 * reapply-tombstones.mjs nicht einfängt (die Registry kennt nur die alte ID).
 *
 * Erreichbar über das Zeitfenster Karte suchen → Bestätigung anfordern → Karte
 * vergessen → Bestätigung einlösen: resolveCandidates filtert gelöschte Karten,
 * die Bestätigung trägt die ID aber schon.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { correctCard } from "../lib/telegram-commands/memory-edit.js";

const AGENT = "correct-guard-agent";
const CARD_ID = "00000000-0000-4000-8000-0000000000c1";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "correct-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Minimaler DB-Stub in der Form, die correctCard benutzt. */
function stubDb(card) {
  const calls = { updateCard: 0 };
  return {
    calls,
    async getCard() { return card; },
    async updateCard() { calls.updateCard += 1; return { ok: true, id: "neu" }; },
  };
}

const baseCard = {
  id: CARD_ID,
  text: "streng geheim",
  summary: "streng geheim",
  scope: "agent-private",
  agentId: AGENT,
  storedBy: AGENT,
};

describe("M4 correctCard Tombstone-Guard", () => {
  it("korrigiert eine getombsteinte Karte nicht", async (t) => {
    const db = stubDb({ ...baseCard, status: "deleted", epistemicStatus: "invalidated" });

    const result = await correctCard(db, AGENT, CARD_ID, "neuer Text", { archiveDir: tempDir(t) });

    assert.equal(result.ok, false);
    assert.equal(db.calls.updateCard, 0, "eine vergessene Erinnerung darf nicht wiederbelebt werden");
  });

  it("verrät dabei nicht, dass die Karte existiert", async (t) => {
    const archiveDir = tempDir(t);
    const deleted = await correctCard(
      stubDb({ ...baseCard, status: "deleted" }), AGENT, CARD_ID, "neuer Text", { archiveDir },
    );
    const missing = await correctCard(
      stubDb(null), AGENT, CARD_ID, "neuer Text", { archiveDir },
    );

    assert.equal(deleted.error, missing.error, "gelöscht und nicht vorhanden müssen gleich klingen");
  });

  it("korrigiert eine aktive Karte unverändert weiter", async (t) => {
    const db = stubDb({ ...baseCard, status: "active" });

    const result = await correctCard(db, AGENT, CARD_ID, "neuer Text", { archiveDir: tempDir(t) });

    assert.equal(result.ok, true);
    assert.equal(db.calls.updateCard, 1);
  });
});
