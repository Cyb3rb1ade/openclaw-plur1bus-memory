/**
 * tests/classifier-unclassified-sentinel.test.js
 *
 * Der Klassifizierer lief seit 2291f95 (28.05.2026) leer: normalizeEntryForTable
 * (index.js) setzt bei JEDEM Insert `type = "memory"`, findRecentUnclassified
 * suchte aber nur `type IS NULL OR type = ''`. Die Schnittmenge war leer, jeder
 * Cron-Lauf loggte `{"processed":0,"note":"no recent unclassified cards"}` und
 * keine Karte bekam je einen Critical-Typ.
 *
 * "memory" ist ein Speicher-Sentinel, kein Klassifikationsergebnis: das
 * Vokabular des Klassifizierers ist person/beziehung/geburtstag/geld_konto/
 * gesundheit/zugang_passwort/fakt plus info/note.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDbAdapter } from "../lib/db-adapter.js";
import { runClassifier } from "../lib/jobs/critical-classifier.js";

const VECTOR_DIM = 8;
const AGENT = "sentinel-agent";

async function loadFreshPlugin() {
  return import(`../index.js?classifier-sentinel=${Date.now()}-${Math.random()}`);
}

function tempBase(t) {
  const dir = mkdtempSync(join(tmpdir(), "classifier-sentinel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FRISCH = "00000000-0000-4000-8000-00000000d001";
const KLASSIFIZIERT = "00000000-0000-4000-8000-00000000d002";
const ALT = "00000000-0000-4000-8000-00000000d003";
const AUSSERHALB = "00000000-0000-4000-8000-00000000d004";

/**
 * Speichert über den echten MemoryDB.store-Pfad — also genau den, der
 * `type = "memory"` als Default setzt.
 */
async function seed(pluginModule, baseDbPath) {
  const db = new pluginModule.MemoryDB(join(baseDbPath, AGENT), VECTOR_DIM);
  const base = {
    vector: Array(VECTOR_DIM).fill(0.1),
    category: "fact",
    storedBy: AGENT,
    origin: "dm",
    trustLevel: "untrusted",
    status: "active",
  };
  const jetzt = Date.now();
  // Kein type gesetzt ⇒ normalizeEntryForTable macht "memory" daraus.
  await db.store({ ...base, id: FRISCH, text: "Evas Geburtstag ist am 3. Mai.", createdAt: jetzt - 60_000 });
  await db.store({ ...base, id: KLASSIFIZIERT, text: "Bereits eingeordnet.", type: "geburtstag", createdAt: jetzt - 60_000 });
  // 100 Minuten alt: innerhalb eines an den 3h-Cron gekoppelten Fensters,
  // außerhalb der alten fest verdrahteten 30 Minuten.
  await db.store({ ...base, id: ALT, text: "Vor anderthalb Stunden gespeichert.", createdAt: jetzt - 100 * 60_000 });
  await db.store({ ...base, id: AUSSERHALB, text: "Uralt.", createdAt: jetzt - 30 * 24 * 60 * 60_000 });
  await db.shutdown();
}

describe("findRecentUnclassified — Sentinel und Zeitfenster", () => {
  it("erkennt eine frisch gespeicherte Karte als unklassifiziert", async (t) => {
    const baseDbPath = tempBase(t);
    await seed(await loadFreshPlugin(), baseDbPath);
    const adapter = createDbAdapter({ basePath: baseDbPath, logger: { info() {}, warn() {} } });
    try {
      const ids = (await adapter.findRecentUnclassified(AGENT, { sinceMinutes: 30 })).map((c) => c.id);
      assert.ok(
        ids.includes(FRISCH),
        'type="memory" ist der Speicher-Default, kein Klassifikationsergebnis — die Karte muss als unklassifiziert gelten',
      );
    } finally {
      await adapter.shutdown();
    }
  });

  it("fasst eine bereits klassifizierte Karte nicht erneut an", async (t) => {
    const baseDbPath = tempBase(t);
    await seed(await loadFreshPlugin(), baseDbPath);
    const adapter = createDbAdapter({ basePath: baseDbPath, logger: { info() {}, warn() {} } });
    try {
      const ids = (await adapter.findRecentUnclassified(AGENT, { sinceMinutes: 30 })).map((c) => c.id);
      assert.equal(ids.includes(KLASSIFIZIERT), false, "ein vergebener Typ darf nicht überschrieben werden");
    } finally {
      await adapter.shutdown();
    }
  });

  it("schreibt end-to-end tatsächlich einen Critical-Typ auf die Karte", async (t) => {
    const baseDbPath = tempBase(t);
    const pluginModule = await loadFreshPlugin();
    await seed(pluginModule, baseDbPath);
    const adapter = createDbAdapter({ basePath: baseDbPath, logger: { info() {}, warn() {} } });
    try {
      const result = await runClassifier(adapter, AGENT, {
        model: { complete: async () => ({ text: "geburtstag" }) },
        statePath: join(baseDbPath, "critical-state.json"),
        logger: { info() {}, warn() {} },
      });

      assert.ok(result.processed > 0, `der Klassifizierer muss etwas verarbeiten, bekam: ${JSON.stringify(result)}`);
      const card = await adapter.getCard(AGENT, FRISCH);
      assert.equal(card.type, "geburtstag", "der klassifizierte Typ muss durabel auf der Karte landen");
    } finally {
      await adapter.shutdown();
    }
  });

  it("strandet keine Karten, wenn ein Lauf mehr als 50 unklassifizierte findet", async (t) => {
    const baseDbPath = tempBase(t);
    const pluginModule = await loadFreshPlugin();
    const db = new pluginModule.MemoryDB(join(baseDbPath, AGENT), VECTOR_DIM);
    const jetzt = Date.now();
    // Live gemessen: bernhardine hatte in Spitzen 90 Karten je 200-Min-Fenster.
    // Was ein Lauf nicht mitnimmt, altert unwiederbringlich aus dem Fenster.
    for (let i = 0; i < 90; i += 1) {
      await db.store({
        id: `00000000-0000-4000-8000-0000000e${String(i).padStart(4, "0")}`,
        text: `Karte ${i}`,
        vector: Array(VECTOR_DIM).fill(0.1),
        category: "fact",
        storedBy: AGENT,
        origin: "dm",
        trustLevel: "untrusted",
        status: "active",
        createdAt: jetzt - 60_000,
      });
    }
    await db.shutdown();

    const adapter = createDbAdapter({ basePath: baseDbPath, logger: { info() {}, warn() {} } });
    try {
      const gefunden = await adapter.findRecentUnclassified(AGENT);
      assert.ok(gefunden.length >= 90, `alle 90 müssen erreichbar sein, waren aber ${gefunden.length}`);
    } finally {
      await adapter.shutdown();
    }
  });

  it("deckt mit dem Standardfenster das Cron-Intervall ab (keine 150-Minuten-Lücke)", async (t) => {
    const baseDbPath = tempBase(t);
    await seed(await loadFreshPlugin(), baseDbPath);
    const adapter = createDbAdapter({ basePath: baseDbPath, logger: { info() {}, warn() {} } });
    try {
      // Ohne sinceMinutes: der Default muss den 3-Stunden-Cron abdecken, sonst
      // fallen Karten dauerhaft durch — das Fenster wandert nur nach vorn.
      const ids = (await adapter.findRecentUnclassified(AGENT)).map((c) => c.id);
      assert.ok(ids.includes(ALT), "eine 100 Minuten alte Karte darf nicht durchs Raster fallen");
      assert.equal(ids.includes(AUSSERHALB), false, "uralte Karten bleiben außerhalb des Fensters");
    } finally {
      await adapter.shutdown();
    }
  });
});
