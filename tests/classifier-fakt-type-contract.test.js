/**
 * tests/classifier-fakt-type-contract.test.js
 *
 * Vertragsbruch zwischen Klassifizierer-Vokabular und Enum-Validator:
 *
 *   lib/critical-push-classifier.js — der Prompt gibt `fakt` ausdrücklich als
 *     Default vor („Wenn nichts passt: 'fakt'"), classifyMemory gibt entweder
 *     einen CRITICAL_TYPE oder wörtlich "fakt" zurück.
 *   lib/jobs/critical-classifier.js:143 — behandelt "fakt" bewusst als eigenen
 *     Wert und schützt ihn vor der Deklassierung zu "note".
 *   lib/sql-safety.js — ALLOWED_TYPES kannte "fakt" nicht, safeType warf.
 *
 * Live-Wirkung (15.08.2026, main, erster Lauf unter 7.3.0):
 *   {"processed":5,"classified":0,"errors":5,
 *    "errorDetails":[{"stage":"updateCardType","error":"Invalid type: \"fakt\""} ×5]}
 * Der Cron meldete dadurch alle drei Stunden Fehlschlag.
 *
 * Der Defekt lag seit dem 28.05.2026 schlafend, weil findRecentUnclassified nie
 * etwas lieferte (siehe classifier-unclassified-sentinel.test.js). Der
 * Sentinel-Fix hat ihn freigelegt, nicht verursacht.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDbAdapter } from "../lib/db-adapter.js";
import { runClassifier } from "../lib/jobs/critical-classifier.js";
import { safeType } from "../lib/sql-safety.js";

const VECTOR_DIM = 8;
const AGENT = "fakt-agent";
const KARTE = "00000000-0000-4000-8000-00000000f001";

async function loadFreshPlugin() {
  return import(`../index.js?classifier-fakt=${Date.now()}-${Math.random()}`);
}

function tempBase(t) {
  const dir = mkdtempSync(join(tmpdir(), "classifier-fakt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Speichert über den echten MemoryDB.store-Pfad (setzt type = "memory"). */
async function seed(pluginModule, baseDbPath) {
  const db = new pluginModule.MemoryDB(join(baseDbPath, AGENT), VECTOR_DIM);
  await db.store({
    id: KARTE,
    text: "Der Wetterbericht für morgen meldet Regen.",
    vector: Array(VECTOR_DIM).fill(0.1),
    category: "fact",
    storedBy: AGENT,
    origin: "dm",
    trustLevel: "untrusted",
    status: "active",
    createdAt: Date.now() - 60_000,
  });
  await db.shutdown();
}

/** Das Modell antwortet mit dem vom Prompt vorgeschriebenen Default. */
const faktModell = { complete: async () => ({ text: "fakt" }) };

describe("safeType kennt das Klassifizierer-Vokabular", () => {
  it("akzeptiert 'fakt' — den vom Prompt vorgeschriebenen Default", () => {
    assert.equal(safeType("fakt"), "fakt");
  });

  it("weist unbekannte Typen weiterhin ab", () => {
    assert.throws(() => safeType("quatsch"), /Invalid type/);
  });
});

describe("Klassifizierer schreibt den Default-Typ durabel", () => {
  it("landet als 'fakt' auf der Karte, ohne Fehler", async (t) => {
    const baseDbPath = tempBase(t);
    await seed(await loadFreshPlugin(), baseDbPath);
    const adapter = createDbAdapter({ basePath: baseDbPath, logger: { info() {}, warn() {} } });
    try {
      const result = await runClassifier(adapter, AGENT, {
        model: faktModell,
        statePath: join(baseDbPath, "critical-state.json"),
        logger: { info() {}, warn() {} },
      });

      assert.equal(
        result.errors,
        0,
        `kein Schreibfehler erwartet, bekam: ${JSON.stringify(result.errorDetails)}`,
      );
      assert.equal(result.classified, 1, `die Karte muss als klassifiziert zählen, bekam: ${JSON.stringify(result)}`);

      const card = await adapter.getCard(AGENT, KARTE);
      assert.equal(card.type, "fakt", "der Default-Typ muss durabel auf der Karte landen");
    } finally {
      await adapter.shutdown();
    }
  });

  it("nimmt die Karte damit aus dem Unklassifiziert-Backlog", async (t) => {
    // Der No-Poison-Guard in critical-classifier.js:72 setzt genau das voraus:
    // ein geschriebenes "fakt" schließt die Karte dauerhaft aus
    // findRecentUnclassified aus. Ohne durablen Schreibvorgang liefe jeder
    // Cron-Lauf denselben Backlog erneut durch das Modell.
    const baseDbPath = tempBase(t);
    await seed(await loadFreshPlugin(), baseDbPath);
    const adapter = createDbAdapter({ basePath: baseDbPath, logger: { info() {}, warn() {} } });
    try {
      await runClassifier(adapter, AGENT, {
        model: faktModell,
        statePath: join(baseDbPath, "critical-state.json"),
        logger: { info() {}, warn() {} },
      });

      const ids = (await adapter.findRecentUnclassified(AGENT)).map((c) => c.id);
      assert.equal(ids.includes(KARTE), false, "eine als 'fakt' eingeordnete Karte darf nicht erneut anfallen");
    } finally {
      await adapter.shutdown();
    }
  });
});
