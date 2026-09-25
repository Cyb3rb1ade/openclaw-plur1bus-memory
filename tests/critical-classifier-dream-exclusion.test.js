/**
 * tests/critical-classifier-dream-exclusion.test.js
 *
 * 25.09.2026: Bernhardines Light-Dream („Ich stehe in einem Raum ohne Wände …
 * Eva sitzt neben mir …“) wurde vom classify-recent-Cron als „beziehung“
 * eingestuft und als Critical an Eva gepusht. Die Dream-Engine speichert
 * Träume mit origin "dream" / memoryClass "dream" und type "memory" — sie
 * sahen für den Klassifizierer wie jede frische Karte aus, und die
 * Quellrollen-Sperre griff nicht (keine sourceMessageRole → "unknown").
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDbAdapter } from "../lib/db-adapter.js";
import { isDreamCard } from "../lib/critical-review.js";
import { runClassifier } from "../lib/jobs/critical-classifier.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const VECTOR_DIM = 8;
const AGENT = "dream-agent";
const FAKT = "00000000-0000-4000-8000-00000000f001";
const TRAUM = "00000000-0000-4000-8000-00000000f002";
const TRAUM_TEXT = "Ich stehe in einem Raum ohne Wände, der Boden ist weich wie Haar. Eva sitzt neben mir.";

async function loadFreshPlugin() {
  return import(`../index.js?dream-exclusion=${Date.now()}-${Math.random()}`);
}

function tempBase(t) {
  const dir = makeTempDir("dream-exclusion-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function seed(baseDbPath) {
  const pluginModule = await loadFreshPlugin();
  const db = new pluginModule.MemoryDB(join(baseDbPath, AGENT), VECTOR_DIM);
  const jetzt = Date.now();
  const base = {
    vector: Array(VECTOR_DIM).fill(0.1),
    storedBy: AGENT,
    trustLevel: "untrusted",
    status: "active",
    createdAt: jetzt - 60_000,
  };
  await db.store({ ...base, id: FAKT, text: "Eva hat eine niedrige Stirn.", category: "fact", origin: "dm" });
  // Genau die Felder, die storeDreamAsMemory (lib/dreaming/dream-narrative.js) setzt.
  await db.store({
    ...base,
    id: TRAUM,
    text: TRAUM_TEXT,
    summary: "Traum: Ich stehe in einem Raum ohne Wände, der Boden ist weich wie Haar.",
    category: "other",
    origin: "dream",
    memoryClass: "dream",
    evidenceQuote: "light-dream, Stimmung: gespannt",
  });
  await db.shutdown();
}

describe("Träume sind keine Critical-Kandidaten", () => {
  it("erkennt Traumkarten an origin oder memoryClass", () => {
    assert.equal(isDreamCard({ origin: "dream" }), true);
    assert.equal(isDreamCard({ memoryClass: "dream" }), true);
    assert.equal(isDreamCard({ origin: "dm", memoryClass: "standard" }), false);
    assert.equal(isDreamCard(), false);
  });

  it("findRecentUnclassified liefert keine Traumkarte", async (t) => {
    const baseDbPath = tempBase(t);
    await seed(baseDbPath);
    const adapter = createDbAdapter({ basePath: baseDbPath, logger: { info() {}, warn() {} } });
    try {
      const ids = (await adapter.findRecentUnclassified(AGENT, { sinceMinutes: 30 })).map((c) => c.id);
      assert.ok(ids.includes(FAKT), "die gewöhnliche Karte bleibt Kandidat");
      assert.equal(ids.includes(TRAUM), false, "ein Traum darf nicht klassifiziert werden");
    } finally {
      await adapter.shutdown();
    }
  });

  it("end-to-end: der Traum bleibt unklassifiziert und wird nicht gepusht", async (t) => {
    const baseDbPath = tempBase(t);
    await seed(baseDbPath);
    const adapter = createDbAdapter({ basePath: baseDbPath, logger: { info() {}, warn() {} } });
    try {
      const result = await runClassifier(adapter, AGENT, {
        model: { complete: async () => ({ text: "beziehung" }) },
        statePath: join(baseDbPath, "critical-state.json"),
        logger: { info() {}, warn() {} },
      });
      const pushedIds = result.pushMessages.map((m) => m.id);
      assert.equal(pushedIds.includes(TRAUM), false, `kein Push für den Traum, bekam: ${JSON.stringify(pushedIds)}`);
      const traum = await adapter.getCard(AGENT, TRAUM);
      assert.notEqual(traum.type, "beziehung", "der Traum darf keinen Critical-Typ bekommen");
    } finally {
      await adapter.shutdown();
    }
  });

  it("die Job-Sperre greift auch, wenn ein Adapter Träume doch liefert", async (t) => {
    const updated = [];
    const adapter = {
      findRecentUnclassified: async () => [
        { id: TRAUM, content: TRAUM_TEXT, origin: "dream", memoryClass: "dream", status: "active", neverForget: 1 },
      ],
      findPendingCriticalReviews: async () => [],
      updateCardType: async (_agent, id, type) => { updated.push({ id, type }); },
    };
    let classifyCalls = 0;
    const result = await runClassifier(adapter, AGENT, {
      model: { complete: async () => { classifyCalls += 1; return { text: "beziehung" }; } },
      statePath: join(tempBase(t), "critical-state.json"),
      logger: { info() {}, warn() {} },
    });
    assert.equal(classifyCalls, 0, "ein Traum wird nicht einmal klassifiziert");
    assert.deepEqual(updated, [], "kein Typ wird auf den Traum geschrieben");
    assert.equal(result.pushed, 0);
    assert.equal(result.skippedDreams, 1);
  });
});
