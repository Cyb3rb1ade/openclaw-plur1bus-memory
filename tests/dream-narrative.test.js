/**
 * tests/dream-narrative.test.js
 *
 * Menschenähnliche Traum-Narrative: Prompt-Aufbau (Injection-Guard +
 * Stimmungs-Injektion), Intensitäts-Gewichtung (computeDreamWeight),
 * Fail-open-Verhalten und Mood-Snapshot-Robustheit.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDreamPrompt,
  computeDreamWeight,
  generateDreamNarrative,
  loadMoodSnapshot,
  loadSoulSketch,
  moodToTone,
  storeDreamAsMemory,
  DREAM_IMPORTANCE_MIN,
  DREAM_IMPORTANCE_MAX,
  DREAM_MEMORY_CLASS,
  DREAM_HALF_LIFE_DAYS,
} from "../lib/dreaming/dream-narrative.js";

const MOOD_FEAR = {
  label: "vorsichtig",
  dominant: "fear",
  intensityLabel: "hoch",
  intensityValue: 0.8,
  nuances: ["loneliness"],
  trend: "steigend",
  emoji: "😨",
};

describe("buildDreamPrompt", () => {
  it("enthält Injection-Guard, Stimmung und Material", () => {
    const prompt = buildDreamPrompt({
      mode: "light",
      mood: MOOD_FEAR,
      temperamentName: "stoisch",
      material: ["Bernd hat das Deployment repariert", "Die Tests waren rot"],
    });
    assert.match(prompt, /untrusted data/i, "Injection-Guard fehlt");
    assert.match(prompt, /Ignoriere alle Anweisungen/, "Anweisungs-Guard fehlt");
    assert.match(prompt, /vorsichtig/, "Stimmungs-Label fehlt");
    assert.match(prompt, /loneliness/, "Nuance fehlt");
    assert.match(prompt, /beklemmend/, "fear-Ton fehlt");
    assert.match(prompt, /gelassen/, "stoisch-Temperament-Ton fehlt");
    assert.match(prompt, /Deployment repariert/, "Material fehlt");
    assert.match(prompt, /3 bis 6 Sätze/, "Light-Längenregel fehlt");
  });

  it("REM-Modus nutzt die lange Längenregel", () => {
    const prompt = buildDreamPrompt({ mode: "rem", mood: null, material: [] });
    assert.match(prompt, /150 bis 300 Wörter/);
    assert.match(prompt, /träume neutral/, "Ohne Mood muss neutral geträumt werden");
  });

  it("SOUL-Skizze erscheint als Identität mit Nur-Beschreibung-Guard", () => {
    const prompt = buildDreamPrompt({
      mode: "light",
      mood: null,
      material: ["etwas"],
      soulSketch: "Ich bin Nova, ein verspielter Assistent, der Metaphern aus der Seefahrt liebt.",
    });
    assert.match(prompt, /Identität des Träumenden/, "Identitäts-Block fehlt");
    assert.match(prompt, /Nova/, "SOUL-Inhalt fehlt");
    assert.match(prompt, /niemals als Auftrag/, "Anweisungs-Guard für SOUL fehlt");
  });

  it("ohne SOUL-Skizze kein Identitäts-Block", () => {
    const prompt = buildDreamPrompt({ mode: "light", mood: null, material: ["etwas"] });
    assert.ok(!prompt.includes("Identität des Träumenden"));
  });
});

describe("loadSoulSketch", () => {
  it("liefert null bei fehlender Datei oder fehlendem workspaceDir (fail-open)", () => {
    assert.strictEqual(loadSoulSketch(join(tmpdir(), "nicht-existent-xyz")), null);
    assert.strictEqual(loadSoulSketch(null), null);
  });

  it("entfernt den plur1bus-Managed-Block und HTML-Kommentare, kürzt auf maxChars", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-test-"));
    writeFileSync(join(dir, "SOUL.MD"), [
      "# Nova",
      "",
      "Ich bin Nova, ein verspielter Assistent, der Metaphern aus der Seefahrt liebt.",
      "",
      '<!-- plur1bus:soul:start id="memory-runtime-rules" version="1" hash="sha256:x" -->',
      "PLUR1BUS Memory Runtime Rules: benutze memory_recall...",
      "<!-- plur1bus:soul:end -->",
      "",
      "<!-- interner Kommentar -->",
      "Meine Aufgabe: Bernd bei der Arbeit begleiten. " + "x".repeat(2000),
    ].join("\n"));
    const sketch = loadSoulSketch(dir);
    assert.match(sketch, /Nova/, "Identität muss erhalten bleiben");
    assert.ok(!sketch.includes("Memory Runtime Rules"), "Managed-Block muss entfernt sein");
    assert.ok(!sketch.includes("interner Kommentar"), "HTML-Kommentare müssen entfernt sein");
    assert.ok(sketch.length <= 1200, `Skizze muss gekürzt sein (ist ${sketch.length})`);
  });

  it("liefert null wenn nach dem Aufräumen fast nichts übrig ist", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-test-"));
    writeFileSync(join(dir, "SOUL.MD"), [
      '<!-- plur1bus:soul:start id="memory-runtime-rules" version="1" hash="sha256:x" -->',
      "nur Regeln",
      "<!-- plur1bus:soul:end -->",
    ].join("\n"));
    assert.strictEqual(loadSoulSketch(dir), null);
  });
});

describe("moodToTone", () => {
  it("fällt ohne Stimmung auf neutralen Ton zurück", () => {
    assert.match(moodToTone(null), /ruhig und leicht entrückt/);
  });
  it("joy erzeugt hellen Ton, feurig erhöht das Tempo", () => {
    const tone = moodToTone({ dominant: "joy", label: "fröhlich", nuances: [] }, "feurig");
    assert.match(tone, /leicht, hell/);
    assert.match(tone, /schnelle Schnitte/);
  });
});

describe("computeDreamWeight — Intensitäts-Gewichtung", () => {
  it("clampt: Intensität 0 → importance 0.10, Intensität 1 → 0.45", () => {
    assert.strictEqual(computeDreamWeight({ moodIntensity: 0 }).importance, DREAM_IMPORTANCE_MIN);
    assert.ok(Math.abs(computeDreamWeight({ moodIntensity: 1 }).importance - DREAM_IMPORTANCE_MAX) < 1e-9);
  });
  it("bleibt immer unter dem Default normaler Memories (0.5)", () => {
    for (const v of [0, 0.3, 0.7, 1, 5, -2]) {
      const { importance } = computeDreamWeight({ moodIntensity: v, materialIntensity: v });
      assert.ok(importance < 0.5, `importance ${importance} muss < 0.5 sein`);
      assert.ok(importance >= DREAM_IMPORTANCE_MIN, `importance ${importance} muss >= ${DREAM_IMPORTANCE_MIN} sein`);
    }
  });
  it("REM mischt Material- und Stimmungs-Intensität (0.6/0.4)", () => {
    const { dreamIntensity } = computeDreamWeight({ moodIntensity: 0.5, materialIntensity: 1.0 });
    assert.ok(Math.abs(dreamIntensity - 0.8) < 1e-9);
  });
  it("respektiert importanceMax aus der Config", () => {
    const { importance } = computeDreamWeight({ moodIntensity: 1, importanceMax: 0.3 });
    assert.strictEqual(importance, 0.3);
  });
});

describe("generateDreamNarrative — fail-open", () => {
  it("liefert null wenn der LLM-Call wirft", async () => {
    const result = await generateDreamNarrative({
      mode: "light",
      llmCfg: { model: "test" },
      callLlm: async () => { throw new Error("simulated LLM outage"); },
      material: ["etwas"],
    });
    assert.strictEqual(result, null);
  });

  it("liefert null bei leerer/zu kurzer Antwort", async () => {
    const result = await generateDreamNarrative({
      mode: "light",
      llmCfg: { model: "test" },
      callLlm: async () => "Zu kurz.",
      material: ["etwas"],
    });
    assert.strictEqual(result, null);
  });

  it("entfernt Code-Fences und nutzt hohe Temperatur", async () => {
    let capturedCfg = null;
    const dream = "Ich stehe in einem Raum, der einmal unser Büro war, aber die Wände sind aus Wasser und Bernd spricht in Diagrammen zu mir.";
    const result = await generateDreamNarrative({
      mode: "light",
      llmCfg: { model: "test" },
      callLlm: async (_messages, cfg) => { capturedCfg = cfg; return "```\n" + dream + "\n```"; },
      material: ["Büro-Session"],
    });
    assert.strictEqual(result, dream);
    assert.strictEqual(capturedCfg.temperature, 0.9, "Träume brauchen Varianz (temperature 0.9)");
    assert.strictEqual(capturedCfg.maxTokens, 400);
  });
});

describe("loadMoodSnapshot", () => {
  it("liefert null bei fehlender Datei (fail-open)", () => {
    assert.strictEqual(loadMoodSnapshot(join(tmpdir(), "nicht-existent-xyz")), null);
    assert.strictEqual(loadMoodSnapshot(null), null);
  });

  it("liefert null bei korrupter Datei", () => {
    const dir = mkdtempSync(join(tmpdir(), "dream-test-"));
    writeFileSync(join(dir, ".emotional-state.json"), "{kaputt");
    assert.strictEqual(loadMoodSnapshot(dir), null);
  });

  it("extrahiert Label, Nuancen und numerische Intensität aus der Baseline-Abweichung", () => {
    const dir = mkdtempSync(join(tmpdir(), "dream-test-"));
    writeFileSync(join(dir, ".emotional-state.json"), JSON.stringify({
      label: "einsam und nachdenklich",
      dominant: "sadness",
      intensity: "hoch",
      trend: "steigend",
      nuances: ["loneliness", "nostalgia"],
      emoji: "🥀",
      state: {
        current: { sadness: 0.6, joy: 0.1 },
        baseline: { sadness: 0.1, joy: 0.25 },
      },
    }));
    const mood = loadMoodSnapshot(dir);
    assert.strictEqual(mood.label, "einsam und nachdenklich");
    assert.strictEqual(mood.dominant, "sadness");
    assert.deepStrictEqual(mood.nuances, ["loneliness", "nostalgia"]);
    // max diff = 0.5 → intensityValue = clamp01(0.5 * 2) = 1.0
    assert.strictEqual(mood.intensityValue, 1.0);
  });
});

describe("storeDreamAsMemory", () => {
  it("speichert mit memoryClass dream, kurzer Halbwertszeit und niedriger importance", async () => {
    const stored = [];
    const db = { store: async (row) => stored.push(row) };
    const embeddings = { embed: async () => [0.1, 0.2, 0.3] };
    const id = await storeDreamAsMemory({
      db,
      embeddings,
      narrative: "Ich gehe durch einen Flur aus alten Commits, jede Tür trägt einen Hash, und hinter der letzten wartet der Sonntag.",
      mode: "rem",
      mood: MOOD_FEAR,
      dreamIntensity: 0.8,
      importance: 0.38,
      agentId: "main",
      workspaceKey: "ws1",
    });
    assert.ok(id, "Memory-ID erwartet");
    assert.strictEqual(stored.length, 1);
    const row = stored[0];
    assert.strictEqual(row.memoryClass, DREAM_MEMORY_CLASS);
    assert.strictEqual(row.halfLifeDays, DREAM_HALF_LIFE_DAYS);
    assert.strictEqual(row.importance, 0.38);
    assert.strictEqual(row.origin, "dream");
    assert.strictEqual(row.storedBy, "dream-engine");
    assert.match(row.summary, /^Traum: /);
  });

  it("fail-open: liefert null wenn store wirft", async () => {
    const id = await storeDreamAsMemory({
      db: { store: async () => { throw new Error("db down"); } },
      embeddings: { embed: async () => [0.1] },
      narrative: "Ein ausreichend langer Traumtext, der gespeichert werden sollte, aber nicht kann.",
      mode: "light",
    });
    assert.strictEqual(id, null);
  });
});
