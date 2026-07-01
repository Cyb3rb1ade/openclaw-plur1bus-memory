/**
 * test/emotional-dynamics.test.js — Emotionale Dynamik: Engine-getriebene
 * Stimmungs-Updates, Temperamente, Diff-Dominanz, Persistenz.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmotionalState } from "../lib/emotional-state.js";
import {
  createEmotionalStatePool,
  TEMPERAMENT_PRESETS,
  DEFAULT_TEMPERAMENTS,
  formatMoodLine,
  formatMoodFile,
  extractMessageText,
} from "../lib/emotional-state.js";

describe("applyEmotionScore", () => {
  it("bewegt die Stimmung deutlich bei starkem Signal", () => {
    const state = new EmotionalState();
    state.applyEmotionScore({ anger: 0.8, emotionalIntensity: 0.8, emotionalDominant: "anger", nuances: [] });
    // Baseline anger 0.02 → target 0.82, blend 0.5×1.0×(0.5+0.4)=0.45 → ~0.38
    assert.ok(state.current.anger > 0.3, `anger sollte > 0.3 sein, ist ${state.current.anger}`);
  });

  it("sensitivity skaliert den Ausschlag", () => {
    const calm = new EmotionalState({ sensitivity: 0.5 });
    const hot = new EmotionalState({ sensitivity: 1.5 });
    const signal = { sadness: 0.6, emotionalIntensity: 0.6, emotionalDominant: "sadness", nuances: [] };
    calm.applyEmotionScore(signal);
    hot.applyEmotionScore(signal);
    assert.ok(hot.current.sadness > calm.current.sadness,
      `hot(${hot.current.sadness}) sollte > calm(${calm.current.sadness}) sein`);
  });

  it("übernimmt Nuancen aus dem Score", () => {
    const state = new EmotionalState();
    state.applyEmotionScore({
      joy: 0.5, emotionalIntensity: 0.5, emotionalDominant: "gratitude",
      nuances: [{ label: "gratitude", intensity: 0.7 }],
    });
    assert.ok((state.nuanceState.gratitude ?? 0) >= 0.69, `gratitude: ${state.nuanceState.gratitude}`);
  });

  it("ignoriert ungültige Eingaben ohne Crash", () => {
    const state = new EmotionalState();
    const before = { ...state.current };
    state.applyEmotionScore(null);
    state.applyEmotionScore("kaputt");
    assert.deepStrictEqual(state.current, before);
  });
});

describe("Temperament: decayMultiplier", () => {
  it("verlangsamt bzw. beschleunigt den Abfall zur Baseline", () => {
    const fast = new EmotionalState({ decayMultiplier: 0.5 });
    const slow = new EmotionalState({ decayMultiplier: 2.0 });
    for (const s of [fast, slow]) {
      s.current.anger = 0.9;
      s.lastUpdateAt = Date.now() - 60 * 60 * 1000; // 1h zurück
      s._applyDecay();
    }
    assert.ok(slow.current.anger > fast.current.anger,
      `slow(${slow.current.anger}) sollte > fast(${fast.current.anger}) sein`);
  });
});

describe("describeMood Diff-Dominanz", () => {
  it("erkennt gestiegenen Ärger trotz Trust-Sockel", () => {
    const state = new EmotionalState();
    state.current.anger = 0.35; // Baseline 0.02, Diff 0.33 — Trust bleibt bei 0.45
    const desc = state.describeMood();
    assert.strictEqual(desc.dominant, "anger");
    assert.strictEqual(desc.label, "angespannt");
    assert.strictEqual(desc.intensity, "mittel");
  });

  it("frische Baseline ist ausgeglichen mit Emoji und Trend", () => {
    const state = new EmotionalState();
    const desc = state.describeMood();
    assert.strictEqual(desc.label, "ausgeglichen");
    assert.strictEqual(desc.trend, "stabil");
    assert.ok(desc.emoji, "Auch ausgeglichen braucht ein Emoji");
  });

  it("Abweichung über 0.05 ist nicht mehr ausgeglichen", () => {
    const state = new EmotionalState();
    state.current.joy = state.baseline.joy + 0.08;
    const desc = state.describeMood();
    assert.notStrictEqual(desc.label, "ausgeglichen");
    assert.strictEqual(desc.dominant, "joy");
  });

  it("hohe Abweichung ergibt hohe Intensität", () => {
    const state = new EmotionalState();
    state.current.fear = state.baseline.fear + 0.5;
    const desc = state.describeMood();
    assert.strictEqual(desc.intensity, "hoch");
  });
});

describe("computeRecallBoost mit moodInfluence", () => {
  it("skaliert den Stimmungs-Boost mit moodInfluence", () => {
    const weak = new EmotionalState({ moodInfluence: 0.15 });
    const strong = new EmotionalState({ moodInfluence: 0.3 });
    // Valenz identisch zur aktuellen Stimmung → Kompatibilität 1.0
    const valence = { ...weak.current, emotionalIntensity: 0 };
    const bWeak = weak.computeRecallBoost(valence, 0.5);
    const bStrong = strong.computeRecallBoost(valence, 0.5);
    assert.ok(Math.abs(bWeak - 1.15) < 0.02, `~1.15 erwartet, ist ${bWeak}`);
    assert.ok(Math.abs(bStrong - 1.3) < 0.02, `~1.3 erwartet, ist ${bStrong}`);
  });

  it("wichtige Lektionen werden weiterhin nie unterdrückt", () => {
    const state = new EmotionalState({ moodInfluence: 0.3 });
    const lesson = { anger: 0.8, trust: 0.5, emotionalIntensity: 0.9 };
    const boost = state.computeRecallBoost(lesson, 0.9);
    assert.ok(boost >= 1.0, `Lektionen-Boost sollte >= 1.0 sein, ist ${boost}`);
  });
});

describe("Persistenz (serializeState / hydrateOnce)", () => {
  it("hydratisiert den Zustand aus der Datei und decayed ab lastUpdateAt", () => {
    const dir = mkdtempSync(join(tmpdir(), "emo-"));
    const file = join(dir, ".emotional-state.json");
    const state1 = new EmotionalState();
    state1.applyEmotionScore({ anger: 0.9, emotionalIntensity: 0.9, emotionalDominant: "anger", nuances: [] });
    writeFileSync(file, JSON.stringify({ agentId: "t", state: state1.serializeState() }));

    const state2 = new EmotionalState();
    assert.strictEqual(state2.hydrateOnce(file), true);
    assert.ok(state2.current.anger > 0.3, `anger nach Rehydrierung: ${state2.current.anger}`);
  });

  it("hydratisiert nur einmal", () => {
    const dir = mkdtempSync(join(tmpdir(), "emo-"));
    const file = join(dir, ".emotional-state.json");
    const donor = new EmotionalState();
    donor.applyEmotionScore({ joy: 0.9, emotionalIntensity: 0.9, emotionalDominant: "joy", nuances: [] });
    writeFileSync(file, JSON.stringify({ state: donor.serializeState() }));
    const state = new EmotionalState();
    assert.strictEqual(state.hydrateOnce(file), true);
    assert.strictEqual(state.hydrateOnce(file), false, "Zweiter Aufruf darf nichts tun");
  });

  it("kaputte Datei → Baseline-Fallback ohne Crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "emo-"));
    const file = join(dir, "broken.json");
    writeFileSync(file, "{not json");
    const state = new EmotionalState();
    assert.strictEqual(state.hydrateOnce(file), false);
    assert.strictEqual(state.current.trust, state.baseline.trust);
  });

  it("fehlende Datei → false ohne Crash", () => {
    const state = new EmotionalState();
    assert.strictEqual(state.hydrateOnce("/nonexistent/nowhere.json"), false);
  });
});

describe("Pool-Temperamente", () => {
  it("wendet Default-Temperamente pro Agent an", () => {
    const pool = createEmotionalStatePool();
    const bern = pool.get("bernhardine");
    assert.ok(Math.abs(bern.baseline.joy - 0.35) < 1e-9, `bernhardine joy-Baseline: ${bern.baseline.joy}`);
    assert.ok(Math.abs(bern.sensitivity - 1.5) < 1e-9);
    const heisen = pool.get("heisenberg");
    assert.ok(Math.abs(heisen.decayMultiplier - 0.7) < 1e-9);
    const main = pool.get("main");
    assert.ok(Math.abs(main.sensitivity - 1.2) < 1e-9);
  });

  it("User-Config überschreibt Defaults", () => {
    const pool = createEmotionalStatePool({ temperaments: { heisenberg: { sensitivity: 2.0 } } });
    assert.ok(Math.abs(pool.get("heisenberg").sensitivity - 2.0) < 1e-9);
  });

  it("moodInfluence wird an alle States durchgereicht", () => {
    const pool = createEmotionalStatePool({ moodInfluence: 0.4 });
    assert.ok(Math.abs(pool.get("irgendwer").moodInfluence - 0.4) < 1e-9);
  });

  it("Presets existieren vollständig", () => {
    for (const name of ["ausgewogen", "warm", "kühl", "feurig", "stoisch"]) {
      assert.ok(TEMPERAMENT_PRESETS[name], `Preset ${name} fehlt`);
      assert.ok(Number.isFinite(TEMPERAMENT_PRESETS[name].sensitivity));
      assert.ok(Number.isFinite(TEMPERAMENT_PRESETS[name].decayMultiplier));
    }
    assert.ok(DEFAULT_TEMPERAMENTS.main && DEFAULT_TEMPERAMENTS.bernhardine && DEFAULT_TEMPERAMENTS.heisenberg && DEFAULT_TEMPERAMENTS.default);
  });
});

describe("Integration: Nachricht → Stimmung → Abklingen", () => {
  it("stark negative Nachricht kippt das Label und klingt per Decay wieder ab", async () => {
    const { inferEmotionalValence } = await import("../lib/emotion.js");
    const state = new EmotionalState(); // Default-Temperament
    const emo = inferEmotionalValence("Ich bin so wütend, alles ist kaputt und ich ärgere mich furchtbar!");
    state.applyEmotionScore(emo);
    const desc = state.describeMood();
    assert.notStrictEqual(desc.label, "ausgeglichen", `Label nach Wut-Nachricht: ${desc.label}`);
    // 24 Stunden später (anger-Halbwertszeit 2h, Nuancen max. 12h): zurück zur Baseline
    state.lastUpdateAt = Date.now() - 24 * 60 * 60 * 1000;
    const later = state.describeMood();
    assert.strictEqual(later.label, "ausgeglichen", `Label nach 24h: ${later.label}`);
  });
});

describe("Format-Helpers", () => {
  it("formatMoodLine rendert Label, Intensität und Trend", () => {
    const line = formatMoodLine({ label: "angespannt", intensity: "mittel", trend: "steigend", emoji: "😤" });
    assert.strictEqual(line, "😤 Aktuelle Stimmung: angespannt (mittel, steigend)");
  });

  it("formatMoodLine lässt stabilen Trend weg", () => {
    const line = formatMoodLine({ label: "ausgeglichen", intensity: "niedrig", trend: "stabil", emoji: "🧘" });
    assert.strictEqual(line, "🧘 Aktuelle Stimmung: ausgeglichen (niedrig)");
  });

  it("formatMoodFile enthält Label, Dominanz, Top-Dimensionen und Zeitstempel", () => {
    const state = new EmotionalState();
    const mood = state.describeMood();
    const txt = formatMoodFile(mood, "main");
    assert.ok(txt.includes("ausgeglichen"));
    assert.ok(txt.includes("Dominant:"));
    assert.ok(txt.includes("Top:"));
    assert.ok(txt.includes("agent: main"));
  });

  it("extractMessageText kann String- und Block-Content", () => {
    assert.strictEqual(extractMessageText({ content: "hallo" }), "hallo");
    assert.strictEqual(extractMessageText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a b");
    assert.strictEqual(extractMessageText(null), "");
  });
});
