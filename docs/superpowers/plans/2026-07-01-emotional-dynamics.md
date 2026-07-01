# Emotionale Dynamik Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agenten (main/Bernd, bernhardine, heisenberg) bekommen eine spürbar dynamische, per-Agent temperierte Stimmung, die aus Gesprächsinhalten via EmotionEngine entsteht, auf allen Memory-Karten landet, das Vergessen moduliert und per `/plur1bus temperament` wählbar ist.

**Architecture:** Gezielte Reparatur der bestehenden Module (Ansatz A der Spec `docs/superpowers/specs/2026-07-01-emotional-dynamics-design.md`): `lib/emotional-state.js` bekommt Engine-Anbindung, Diff-Dominanz, Temperamente und Persistenz; `lib/emotion-engine.js` bekommt konfigurierbare Tier-3-Eskalation mit Timeout; `lib/memory-dynamics.js` moduliert Halbwertszeiten mit der emotionalen Intensität; `index.js` verdrahtet alles im Auto-Recall- und Store-Pfad.

**Tech Stack:** Node.js ESM, `node --test` (node:test + node:assert), keine neuen Dependencies, keine LanceDB-Schema-Änderung.

## Global Constraints

- **NIEMALS** "Generated with Claude Code"-Footer in Commits (User-Vorgabe).
- Testsuite-Baseline: **4 pre-existing Failures** in `tests/memory-store-decision-trace.test.js` (2×) und `tests/memory-store-merge-safety.test.js` (2×), 1 skipped. Diese 4 dürfen weiterhin fehlschlagen — es dürfen aber **keine neuen** Failures hinzukommen.
- Testlauf komplett: `cd /root/openclaw-plur1bus-memory && npm test` (~45s). Einzeldatei: `node --test <pfad>`.
- Kommentare auf Deutsch, im Stil der umliegenden Module.
- Keine Änderungen an Obsidian-Bridge, Managed Blocks, LanceDB-Schema.
- Konfig-Defaults exakt wie in der Spec: `escalationConfidence` 0.85, `timeoutMs` 4000, Blend 0.5, „ausgeglichen"-Schwelle 0.05, `moodInfluence` 0.3, `intensityHalfLifeFactor` 1.0, Flashbulb-Minimum 90 Tage.

---

### Task 1: memory-dynamics — HalfLife-Modulation + Flashbulb-Fix

**Files:**
- Modify: `lib/memory-dynamics.js` (Funktionen `applyFlashbulbEncoding`, `applyDynamicsDefaults`; neue Funktion `modulateHalfLifeDays`)
- Test: `tests/memory-dynamics-halflife.test.js` (neu)

**Interfaces:**
- Consumes: bestehende Exporte `resolveHalfLifeDays`, `applyCoreMemoryEncoding`, interne `clamp`
- Produces:
  - `modulateHalfLifeDays(baseDays: number, emotionalIntensity: number, factor?: number): number`
  - `applyFlashbulbEncoding(row, now, threshold = 0.70, baseHalfLifeDays = 0)` — 4. Parameter neu; `halfLifeDays` im Ergebnis ist jetzt `Math.max(baseHalfLifeDays, 90)`
  - `applyDynamicsDefaults(entry, now, halfLifeOverrides, opts = {})` — 4. Parameter neu; `opts.intensityHalfLifeFactor` (Default 1.0)

- [ ] **Step 1: Failing Tests schreiben**

Datei `tests/memory-dynamics-halflife.test.js` anlegen:

```js
/**
 * tests/memory-dynamics-halflife.test.js — Emotionale Intensität moduliert
 * die Halbwertszeit: je intensiver, desto langsamer das Vergessen.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  modulateHalfLifeDays,
  applyFlashbulbEncoding,
  applyDynamicsDefaults,
} from "../lib/memory-dynamics.js";

describe("modulateHalfLifeDays", () => {
  it("verlängert die Halbwertszeit proportional zur Intensität", () => {
    assert.strictEqual(modulateHalfLifeDays(600, 0.8, 1.0), 1080);
  });

  it("lässt emotionslose Memories unverändert", () => {
    assert.strictEqual(modulateHalfLifeDays(60, 0, 1.0), 60);
  });

  it("clampt Intensität auf [0,1]", () => {
    assert.strictEqual(modulateHalfLifeDays(100, 5, 1.0), 200);
  });

  it("factor 0 deaktiviert die Modulation", () => {
    assert.strictEqual(modulateHalfLifeDays(600, 1.0, 0), 600);
  });

  it("gibt ungültige Basis unverändert zurück", () => {
    assert.strictEqual(modulateHalfLifeDays(undefined, 0.5, 1.0), undefined);
  });
});

describe("applyFlashbulbEncoding mit Basis-Halbwertszeit", () => {
  const flashbulbRow = { emotionalIntensity: 0.9, importance: 0.9, novelty: 0.5, userCorrection: 0 };

  it("verkürzt lange Halbwertszeiten nicht mehr", () => {
    const result = applyFlashbulbEncoding(flashbulbRow, Date.now(), 0.70, 600);
    assert.ok(result, "Flashbulb sollte greifen (Score >= 0.70)");
    assert.strictEqual(result.halfLifeDays, 600);
  });

  it("hebt kurze Halbwertszeiten auf mindestens 90 Tage", () => {
    const result = applyFlashbulbEncoding(flashbulbRow, Date.now(), 0.70, 60);
    assert.strictEqual(result.halfLifeDays, 90);
  });

  it("Rückwärtskompatibilität: ohne Basis bleibt 90", () => {
    const result = applyFlashbulbEncoding(flashbulbRow, Date.now());
    assert.strictEqual(result.halfLifeDays, 90);
  });
});

describe("applyDynamicsDefaults mit Intensitäts-Modulation", () => {
  it("moduliert die Halbwertszeit neuer Memories mit der Intensität", () => {
    // project → Basis 600d; Intensität 0.5 × Faktor 1.0 → 900d.
    // Flashbulb-Score: 0.5*0.35 + 0.5*0.35 = 0.35 < 0.70 → Standard-Zweig.
    const entry = { id: "x", category: "project", emotionalIntensity: 0.5, importance: 0.5 };
    const out = applyDynamicsDefaults(entry, Date.now(), {}, { intensityHalfLifeFactor: 1.0 });
    assert.strictEqual(out.halfLifeDays, 900);
  });

  it("respektiert explizit gesetzte halfLifeDays", () => {
    const entry = { id: "x", category: "project", emotionalIntensity: 0.9, importance: 0.5, halfLifeDays: 42 };
    const out = applyDynamicsDefaults(entry, Date.now(), {}, { intensityHalfLifeFactor: 1.0 });
    assert.strictEqual(out.halfLifeDays, 42);
  });

  it("Flashbulb-Memories erben die modulierte Basis statt fixer 90 Tage", () => {
    // Score: 0.9*0.35 + 0.9*0.35 = 0.63 + novelty 0.5*0.15 = 0.705 >= 0.70 → Flashbulb.
    // Kein Core (emotionalIntensity 0.9 < 0.95). Basis: 600 × (1 + 0.9) = 1140.
    const entry = { id: "x", category: "project", emotionalIntensity: 0.9, importance: 0.9, novelty: 0.5 };
    const out = applyDynamicsDefaults(entry, Date.now(), {}, { intensityHalfLifeFactor: 1.0 });
    assert.strictEqual(out.memoryClass, "flashbulb");
    assert.strictEqual(out.halfLifeDays, 1140);
  });

  it("ohne opts bleibt das bisherige Verhalten (Faktor 1.0 Default, Intensität 0)", () => {
    const entry = { id: "x", category: "fact", importance: 0.5 };
    const out = applyDynamicsDefaults(entry, Date.now(), {});
    assert.strictEqual(out.halfLifeDays, 60);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `cd /root/openclaw-plur1bus-memory && node --test tests/memory-dynamics-halflife.test.js`
Expected: FAIL — `modulateHalfLifeDays` ist nicht exportiert (SyntaxError/ImportError), bzw. Flashbulb-Assertions schlagen fehl.

- [ ] **Step 3: Implementierung in `lib/memory-dynamics.js`**

Nach `computeFlashbulbScore` (Zeile ~137) einfügen:

```js
/**
 * Skaliert eine Basis-Halbwertszeit mit der emotionalen Intensität:
 * je intensiver die Erinnerung, desto langsamer das Vergessen.
 * halfLife' = halfLife × (1 + intensity × factor)
 */
export function modulateHalfLifeDays(baseDays, emotionalIntensity, factor = 1.0) {
  const base = Number(baseDays);
  if (!Number.isFinite(base) || base <= 0) return baseDays;
  const intensity = clamp(emotionalIntensity ?? 0, 0, 1);
  const f = Number.isFinite(Number(factor)) ? Math.max(0, Number(factor)) : 1.0;
  return Math.round(base * (1 + intensity * f));
}
```

`applyFlashbulbEncoding` ersetzen (bisheriger Body setzt `halfLifeDays: 90` hart):

```js
export function applyFlashbulbEncoding(row = {}, now = Date.now(), threshold = 0.70, baseHalfLifeDays = 0) {
  const score = computeFlashbulbScore(row);
  if (score < threshold) return null;

  return {
    memoryStrength: 0.95,
    // Flashbulb darf die Halbwertszeit nur verlängern, nie verkürzen —
    // sonst würden z.B. Projekt-Memories (600d) auf 90d gestutzt.
    halfLifeDays: Math.max(Number(baseHalfLifeDays) || 0, 90),
    lastStrengthenedAt: now,
    lastDynamicsAt: now,
  };
}
```

In `applyDynamicsDefaults` Signatur + isNew-Zweig anpassen. Alt:

```js
export function applyDynamicsDefaults(entry = {}, now = Date.now(), halfLifeOverrides = {}) {
  const isNew = !entry.lastDynamicsAt;
  const out = { ...entry };

  if (isNew) {
    const core = applyCoreMemoryEncoding(out, now);
    const flashbulb = core ? null : applyFlashbulbEncoding(out, now);
```

Neu:

```js
export function applyDynamicsDefaults(entry = {}, now = Date.now(), halfLifeOverrides = {}, opts = {}) {
  const isNew = !entry.lastDynamicsAt;
  const out = { ...entry };

  if (isNew) {
    const baseHalfLifeDays = entry.halfLifeDays ?? modulateHalfLifeDays(
      resolveHalfLifeDays(entry.category, entry.memoryClass, halfLifeOverrides),
      entry.emotionalIntensity,
      opts.intensityHalfLifeFactor ?? 1.0,
    );
    const core = applyCoreMemoryEncoding(out, now);
    const flashbulb = core ? null : applyFlashbulbEncoding(out, now, 0.70, baseHalfLifeDays);
```

Und im Standard-Zweig (heute `out.halfLifeDays = entry.halfLifeDays ?? resolveHalfLifeDays(entry.category, entry.memoryClass, halfLifeOverrides);`):

```js
      out.memoryStrength = entry.memoryStrength ?? 1.0;
      out.halfLifeDays = baseHalfLifeDays;
```

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run: `node --test tests/memory-dynamics-halflife.test.js`
Expected: PASS (alle 13 Tests).

- [ ] **Step 5: Regressionscheck angrenzender Tests**

Run: `node --test tests/memory-dynamics-maintenance.test.js tests/safe-update-preserves-dynamics.test.js 2>/dev/null || node --test tests/memory-dynamics-maintenance.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/memory-dynamics.js tests/memory-dynamics-halflife.test.js
git commit -m "feat(dynamics): emotional intensity slows memory decay; flashbulb never shortens half-life"
```

---

### Task 2: EmotionEngine — konfigurierbare Eskalation, T1/T2-Widerspruch, T3-Timeout

**Files:**
- Modify: `lib/emotion-engine.js` (constructor, `_defaultRouting`; neue Methode `_maybeT3`)
- Modify: `lib/emotion.js:43-62` (`getEngine` — neue Config-Keys durchreichen)
- Test: `test/emotion-engine-escalation.test.js` (neu)

**Interfaces:**
- Consumes: `Tier3LLMClassifier.classify(text, source, fallback)` (bestehend, nutzt `callLlm` wenn gesetzt)
- Produces:
  - `new EmotionEngine({ escalationConfidence?: number, tier3: { timeoutMs?: number, ... } })` — `escalationConfidence` Default 0.7 (bisheriges Verhalten), `timeoutMs` Default 4000
  - `setEmotionConfig({ escalationConfidence, t3: { timeoutMs, ... } })` wird von `getEngine()` durchgereicht (Task 7 setzt die Werte aus der Plugin-Config)

- [ ] **Step 1: Failing Tests schreiben**

Datei `test/emotion-engine-escalation.test.js` anlegen:

```js
/**
 * test/emotion-engine-escalation.test.js — Konfigurierbare T3-Eskalation:
 * beim kleinsten Zweifel (Konfidenz < escalationConfidence, T1/T2-Widerspruch)
 * geht die Analyse zu Tier 3; T3-Timeout fällt sauber zurück.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { EmotionEngine } from "../lib/emotion-engine.js";
import { EmotionScore } from "../lib/emotion-score.js";

function makeScore(props) {
  return new EmotionScore({
    valence: 0, arousal: 0, dominance: 0, intensity: 0.5,
    secondary_emotion: null, emotion_labels: {}, language: "de",
    source: "user", confidence: 0.5, timestamp: new Date(),
    ...props,
  });
}

const t3Response = {
  valence: -0.8, arousal: 0.6, dominance: 0, intensity: 0.9,
  primary_emotion: "anger", secondary_emotion: null,
  emotion_labels: { anger: 0.9 }, confidence: 0.9, language: "de",
};

function t3Stub(result = t3Response) {
  return { enabled: true, callLlm: async () => JSON.stringify(result) };
}

describe("EmotionEngine Eskalations-Schwelle", () => {
  it("eskaliert T1-Ergebnisse unterhalb der Schwelle zu T3", async () => {
    const engine = new EmotionEngine({ escalationConfidence: 0.95, tier3: t3Stub() });
    // T1 liefert konfident-aber-unter-Schwelle (nicht ambivalent, nicht schwach)
    engine._tier1 = { classify: () => makeScore({ primary_emotion: "joy", valence: 0.6, confidence: 0.6, tier_used: 1 }) };
    const score = await engine.analyze("egal", "user");
    assert.strictEqual(score.tier_used, 3);
    assert.strictEqual(score.primary_emotion, "anger");
  });

  it("bleibt bei T1 wenn Konfidenz über der Schwelle liegt", async () => {
    const engine = new EmotionEngine({ escalationConfidence: 0.5, tier3: t3Stub() });
    engine._tier1 = { classify: () => makeScore({ primary_emotion: "joy", valence: 0.6, confidence: 0.6, tier_used: 1 }) };
    const score = await engine.analyze("egal", "user");
    assert.strictEqual(score.tier_used, 1);
    assert.strictEqual(score.primary_emotion, "joy");
  });

  it("eskaliert bei T1/T2-Widerspruch zu T3", async () => {
    const engine = new EmotionEngine({ escalationConfidence: 0.7, tier3: t3Stub() });
    // ambivalent (|valence| < 0.2) → T2-Pfad; T2 widerspricht T1
    engine._tier1 = { classify: () => makeScore({ primary_emotion: "joy", valence: 0.1, confidence: 0.4, tier_used: 1 }) };
    engine._tier2 = { classify: () => makeScore({ primary_emotion: "sadness", valence: -0.5, confidence: 0.75, tier_used: 2 }) };
    const score = await engine.analyze("egal", "user");
    assert.strictEqual(score.tier_used, 3);
  });

  it("ohne T3 bleibt der Widerspruchsfall beim besseren lokalen Ergebnis", async () => {
    const engine = new EmotionEngine({ escalationConfidence: 0.7, tier3: { enabled: false } });
    engine._tier1 = { classify: () => makeScore({ primary_emotion: "joy", valence: 0.1, confidence: 0.4, tier_used: 1 }) };
    engine._tier2 = { classify: () => makeScore({ primary_emotion: "sadness", valence: -0.5, confidence: 0.75, tier_used: 2 }) };
    const score = await engine.analyze("egal", "user");
    assert.strictEqual(score.tier_used, 2, "Sollte das konfidentere T2-Ergebnis nehmen");
    assert.strictEqual(score.primary_emotion, "sadness");
  });
});

describe("EmotionEngine T3-Timeout", () => {
  it("fällt bei hängendem T3-Call auf das lokale Ergebnis zurück", async () => {
    const engine = new EmotionEngine({
      escalationConfidence: 0.95,
      tier3: { enabled: true, timeoutMs: 50, callLlm: () => new Promise(() => {}) },
    });
    engine._tier1 = { classify: () => makeScore({ primary_emotion: "joy", valence: 0.6, confidence: 0.6, tier_used: 1 }) };
    const start = Date.now();
    const score = await engine.analyze("egal", "user");
    assert.ok(Date.now() - start < 2000, "Timeout sollte schnell greifen");
    assert.strictEqual(score.primary_emotion, "joy");
    assert.strictEqual(score.tier_used, 1);
  });

  it("fällt bei T3-Fehler auf das lokale Ergebnis zurück", async () => {
    const engine = new EmotionEngine({
      escalationConfidence: 0.95,
      tier3: { enabled: true, callLlm: async () => { throw new Error("boom"); } },
    });
    engine._tier1 = { classify: () => makeScore({ primary_emotion: "trust", valence: 0.6, confidence: 0.6, tier_used: 1 }) };
    const score = await engine.analyze("egal", "user");
    assert.strictEqual(score.primary_emotion, "trust");
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `node --test test/emotion-engine-escalation.test.js`
Expected: FAIL — z.B. „eskaliert T1-Ergebnisse unterhalb der Schwelle" bekommt `tier_used: 1` statt 3 (altes Routing kennt keine Schwelle für konfidente T1).

- [ ] **Step 3: `lib/emotion-engine.js` anpassen**

Im Constructor nach `this._t2Enabled = ...` (Zeile ~36) einfügen:

```js
    /** @type {number} — Konfidenz-Schwelle: darunter wird zu T3 eskaliert ("beim kleinsten Zweifel") */
    this._escalationConfidence = Number.isFinite(config.escalationConfidence)
      ? config.escalationConfidence
      : TIER2_CONFIDENCE_THRESHOLD;
    /** @type {number} — Timeout für T3-LLM-Calls; danach gilt das lokale Fallback-Ergebnis */
    this._t3TimeoutMs = Number.isFinite(config.tier3?.timeoutMs) ? config.tier3.timeoutMs : 4000;
```

`_defaultRouting` komplett ersetzen (JSDoc-Kommentar über `analyze` bei Schritt 5 mit anpassen):

```js
  /**
   * Default multi-tier routing.
   *
   * "Beim kleinsten Zweifel Tier 3": jedes lokale Ergebnis unterhalb von
   * escalationConfidence — und jeder T1/T2-Widerspruch — eskaliert zu T3
   * (sofern enabled). T3-Ausfälle fallen auf das lokale Ergebnis zurück.
   *
   * @param {string} text
   * @param {"user" | "assistant"} source
   * @returns {Promise<EmotionScore>}
   */
  async _defaultRouting(text, source) {
    const t1 = this._t1.classify(text, source);

    // No tier1 match → tier2 → maybe tier3
    if (!t1) {
      if (!this._t2Enabled) {
        return this._fallbackScore(source);
      }
      const t2 = this._t2.classify(text, source);
      if (t2.confidence >= this._escalationConfidence) return t2;
      return this._maybeT3(text, source, t2);
    }

    // Tier1 ambivalent or low confidence → try tier2
    const t1Ambivalent = Math.abs(t1.valence) < TIER1_AMBIVALENCE_THRESHOLD;
    const t1Weak = t1.confidence < 0.5;
    if (t1Ambivalent || t1Weak) {
      if (!this._t2Enabled) {
        return this._maybeT3(text, source, t1);
      }
      const t2 = this._t2.classify(text, source);
      // T1/T2-Widerspruch → immer eskalieren (Fallback: das konfidentere Ergebnis)
      if (t2.primary_emotion !== t1.primary_emotion) {
        const better = t2.confidence > t1.confidence ? t2 : t1;
        return this._maybeT3(text, source, better);
      }
      const best = t2.confidence > t1.confidence + 0.2 ? t2 : t1;
      if (best.confidence >= this._escalationConfidence) return best;
      return this._maybeT3(text, source, best);
    }

    if (t1.confidence >= this._escalationConfidence) return t1;
    return this._maybeT3(text, source, t1);
  }

  /**
   * Eskaliert zu Tier-3 mit Timeout-Schutz. Bei disabled/Timeout/Fehler
   * kommt das lokale Fallback-Ergebnis zurück — die Analyse blockiert nie.
   *
   * @param {string} text
   * @param {"user" | "assistant"} source
   * @param {EmotionScore|null} fallback
   * @returns {Promise<EmotionScore>}
   */
  async _maybeT3(text, source, fallback) {
    if (!this._t3Enabled) return fallback || this._fallbackScore(source);
    try {
      const result = await Promise.race([
        this._t3.classify(text, source, fallback),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), this._t3TimeoutMs);
          if (typeof timer?.unref === "function") timer.unref();
        }),
      ]);
      return result || fallback || this._fallbackScore(source);
    } catch (_err) {
      return fallback || this._fallbackScore(source);
    }
  }
```

- [ ] **Step 4: `lib/emotion.js` — Config durchreichen**

In `getEngine()` (Zeile ~43) das `EmotionEngine`-Options-Objekt erweitern:

```js
    _engine = new EmotionEngine({
      tier1: { language: "de" },
      tier2: {
        modelName: "j-hartmann/emotion-english-distilroberta-base",
        enabled: cfg.t2?.enabled !== false,
      },
      tier3: {
        model: cfg.t3?.model || "gpt-4o-mini",
        enabled: cfg.t3?.enabled === true,
        apiKey: cfg.t3?.apiKey || null,
        baseUrl: cfg.t3?.baseUrl || null,
        callLlm: cfg.t3?.callLlm || null,
        timeoutMs: cfg.t3?.timeoutMs ?? 4000,
      },
      escalationConfidence: cfg.escalationConfidence,
    });
```

- [ ] **Step 5: Tests laufen lassen — müssen bestehen**

Run: `node --test test/emotion-engine-escalation.test.js test/emotion-tier-config.test.js test/emotion-nuances.test.js tests/emotion-input-safety.test.js`
Expected: PASS. Falls `test/emotion-tier-config.test.js` eine Assertion hat, die konfidente T1-Ergebnisse unterhalb der Schwelle bei aktivem T3 auf `tier_used === 1` festnagelt: Erwartung auf die neue, beabsichtigte Eskalation anpassen und im Commit-Text erwähnen. JSDoc-Routing-Kommentar über `analyze()` (Zeile ~82-92) an das neue Verhalten anpassen.

- [ ] **Step 6: Commit**

```bash
git add lib/emotion-engine.js lib/emotion.js test/emotion-engine-escalation.test.js test/emotion-tier-config.test.js
git commit -m "feat(emotion): configurable T3 escalation threshold, T1/T2-disagreement escalation, T3 timeout guard"
```

---

### Task 3: EmotionalState — Temperament-Optionen + applyEmotionScore + Decay-Multiplikator

**Files:**
- Modify: `lib/emotional-state.js` (constructor, `_applyDecay`; neue Methode `applyEmotionScore`)
- Test: `test/emotional-dynamics.test.js` (neu)

**Interfaces:**
- Consumes: Legacy-Valenz-Format von `inferEmotionalValenceAsync` — `{ joy..surprise: number, emotionalIntensity: number, emotionalDominant: string, nuances: [{label, intensity}] }`
- Produces:
  - `new EmotionalState({ baseline?, sensitivity?, decayMultiplier?, blendFactor?, moodInfluence?, maxHistory? })` — Defaults: sensitivity 1.0, decayMultiplier 1.0, blendFactor 0.5, moodInfluence 0.3
  - `state.applyEmotionScore(valence): void` — blendet ein Legacy-Valenz-Objekt in die Stimmung ein
  - Instanz-Properties `sensitivity`, `decayMultiplier`, `blendFactor`, `moodInfluence` (von Task 4/5 genutzt)

- [ ] **Step 1: Failing Tests schreiben**

Datei `test/emotional-dynamics.test.js` anlegen:

```js
/**
 * test/emotional-dynamics.test.js — Emotionale Dynamik: Engine-getriebene
 * Stimmungs-Updates, Temperamente, Diff-Dominanz, Persistenz.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { EmotionalState } from "../lib/emotional-state.js";

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
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `node --test test/emotional-dynamics.test.js`
Expected: FAIL — `state.applyEmotionScore is not a function`.

- [ ] **Step 3: `lib/emotional-state.js` implementieren**

Constructor ersetzen (Zeile ~51-58):

```js
  constructor(options = {}) {
    this.baseline = { ...BASELINE_MOOD, ...(options.baseline || {}) };
    this.current = { ...this.baseline };
    // Temperament-Parameter (v3): steuern Stärke und Dauer des Ausschlags —
    // die Stimmung selbst entsteht weiterhin nur aus Gesprächsinhalten.
    this.sensitivity = Number.isFinite(options.sensitivity) && options.sensitivity > 0 ? options.sensitivity : 1.0;
    this.decayMultiplier = Number.isFinite(options.decayMultiplier) && options.decayMultiplier > 0 ? options.decayMultiplier : 1.0;
    this.blendFactor = Number.isFinite(options.blendFactor) ? clamp01(options.blendFactor) : 0.5;
    this.moodInfluence = Number.isFinite(options.moodInfluence) && options.moodInfluence >= 0 ? options.moodInfluence : 0.3;
    this.nuanceState = {}; // { label: intensity }
    this.lastUpdateAt = Date.now();
    this.moodHistory = []; // { timestamp, mood, trigger }
    this.maxHistory = options.maxHistory || 100;
    this._hydrated = false;
  }
```

Nach `updateFromMessages` neue Methode einfügen:

```js
  /**
   * Blendet ein Emotions-Ergebnis der EmotionEngine (Legacy-Valenz-Format von
   * inferEmotionalValenceAsync) in die Stimmung ein. Ersetzt die alte
   * Regex-Heuristik als primärer Update-Pfad.
   *
   * @param {{joy?:number, trust?:number, anticipation?:number, sadness?:number,
   *          disgust?:number, anger?:number, fear?:number, surprise?:number,
   *          emotionalIntensity?:number, nuances?:Array<{label:string,intensity:number}>}} valence
   */
  applyEmotionScore(valence) {
    if (!valence || typeof valence !== "object") return;

    this._applyDecay();

    const intensity = clamp01(valence.emotionalIntensity ?? 0);
    // Intensive Emotionen bewegen die Stimmung stärker; sensitivity ist das
    // Temperament des Agenten.
    const blend = clamp01(this.blendFactor * this.sensitivity * (0.5 + intensity * 0.5));

    for (const dim of EMOTION_DIMENSIONS) {
      const v = clamp01(valence[dim] ?? 0);
      const target = clamp01(this.baseline[dim] + v * this.sensitivity);
      this.current[dim] = clamp01(this.current[dim] * (1 - blend) + target * blend);
    }

    for (const nuance of Array.isArray(valence.nuances) ? valence.nuances : []) {
      const nIntensity = clamp01(nuance?.intensity ?? 0);
      if (nuance?.label && nIntensity > 0.2) {
        this.nuanceState[nuance.label] = Math.max(this.nuanceState[nuance.label] || 0, nIntensity);
      }
    }

    this.lastUpdateAt = Date.now();
    this._recordHistory("emotion_engine");
  }
```

In `_applyDecay` beide Halbwertszeit-Zeilen mit dem Multiplikator skalieren:

```js
      const halfLife = (DECAY_HALF_LIFE_MS[dim] || DEFAULT_DECAY_MS) * this.decayMultiplier;
```

und im Nuancen-Loop:

```js
      const halfLife = (NUANCE_DECAY_HALF_LIFE_MS[label] || DEFAULT_DECAY_MS) * this.decayMultiplier;
```

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run: `node --test test/emotional-dynamics.test.js test/emotion-nuances.test.js`
Expected: PASS (auch die bestehenden Nuancen-Tests — `updateFromRecalledMemory` und Decay-Reihenfolge bleiben kompatibel).

- [ ] **Step 5: Commit**

```bash
git add lib/emotional-state.js test/emotional-dynamics.test.js
git commit -m "feat(emotion): engine-driven mood updates via applyEmotionScore + temperament options"
```

---

### Task 4: EmotionalState — Diff-Dominanz, Trend, stärkerer Recall-Boost

**Files:**
- Modify: `lib/emotional-state.js` (`describeMood`, `computeRecallBoost`; neue Methoden `_totalDeviation`, `_computeTrend`)
- Test: `test/emotional-dynamics.test.js` (erweitern)

**Interfaces:**
- Consumes: Instanz-Properties aus Task 3 (`moodInfluence`)
- Produces:
  - `describeMood()` liefert zusätzlich `trend: "steigend"|"fallend"|"stabil"` und immer ein `emoji`; Dominanz nach **Baseline-Abweichung**, „ausgeglichen"-Schwelle 0.05
  - `computeRecallBoost(memoryValence, importance)` — Stimmungsanteil ±`moodInfluence` (Default ±0.3)

- [ ] **Step 1: Failing Tests ergänzen**

An `test/emotional-dynamics.test.js` anhängen:

```js
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
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `node --test test/emotional-dynamics.test.js`
Expected: FAIL — „erkennt gestiegenen Ärger" bekommt `label: "ausgeglichen"` bzw. `dominant: "trust"` (alter Absolutwert-Sort); Boost-Test bekommt 1.15 statt 1.3 bei `moodInfluence: 0.3`.

- [ ] **Step 3: `describeMood` und `computeRecallBoost` umbauen**

In `describeMood()` den Block von `entries.sort(...)` bis zum „ausgeglichen"-Return ersetzen. Alt:

```js
    entries.sort((a, b) => b.value - a.value);

    const dominant = entries[0];
```

Neu:

```js
    // v3: Dominanz nach Abweichung von der Baseline, nicht nach Absolutwert —
    // sonst gewinnt der Trust-Sockel (0.45) gegen jede echte Regung.
    entries.sort((a, b) => b.diff - a.diff);

    const dominant = entries[0];
```

Den „ausgeglichen"-Check ersetzen. Alt:

```js
    // Wenn die dominante Emotion nur leicht über dem Baseline liegt
    if (Math.abs(dominant.diff) < 0.1 && activeNuances.length === 0) {
      return { label: "ausgeglichen", dominant: dominant.dim, intensity: "niedrig", details: this.current, nuances: [] };
    }

    const intensity =
      dominant.value > 0.7 ? "hoch" :
      dominant.value > 0.4 ? "mittel" : "niedrig";
```

Neu:

```js
    // Wenn die dominante Emotion nur minimal über der Baseline liegt
    if (dominant.diff < 0.05 && activeNuances.length === 0) {
      return { label: "ausgeglichen", dominant: dominant.dim, intensity: "niedrig", trend: this._computeTrend(), details: this.current, nuances: [], emoji: "🧘" };
    }

    const intensity =
      dominant.diff > 0.35 ? "hoch" :
      dominant.diff > 0.15 ? "mittel" : "niedrig";
```

Im finalen Return-Objekt von `describeMood` das Feld `trend: this._computeTrend(),` ergänzen (nach `intensity`).

Nach `describeMood` zwei Hilfsmethoden einfügen:

```js
  /** Summe der absoluten Abweichungen von der Baseline über alle Dimensionen. */
  _totalDeviation(mood) {
    let sum = 0;
    for (const dim of EMOTION_DIMENSIONS) {
      sum += Math.abs((mood?.[dim] ?? 0) - this.baseline[dim]);
    }
    return sum;
  }

  /**
   * Trend gegenüber dem letzten Stimmungs-Snapshot: baut sich die Emotion
   * gerade auf ("steigend"), klingt sie ab ("fallend") oder ist sie "stabil"?
   */
  _computeTrend() {
    const history = this.moodHistory;
    if (history.length === 0) return "stabil";
    const nowDev = this._totalDeviation(this.current);
    let ref = history[history.length - 1];
    // Direkt nach einem Update entspricht der letzte Eintrag dem aktuellen
    // Zustand — dann gegen den vorherigen vergleichen.
    if (history.length >= 2 && Math.abs(this._totalDeviation(ref.mood) - nowDev) < 1e-9) {
      ref = history[history.length - 2];
    }
    const prevDev = this._totalDeviation(ref.mood);
    if (nowDev > prevDev + 0.03) return "steigend";
    if (nowDev < prevDev - 0.03) return "fallend";
    return "stabil";
  }
```

In `computeRecallBoost` die Boost-Zeile ersetzen. Alt:

```js
    const moodBoost = (compatibility - 0.5) * 0.3; // ±0.15 Max
```

Neu:

```js
    const moodBoost = (compatibility - 0.5) * (this.moodInfluence * 2); // ±moodInfluence Max (Default ±0.3)
```

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run: `node --test test/emotional-dynamics.test.js test/emotion-nuances.test.js`
Expected: PASS. (Der Nuancen-Test „speichert Nuancen aus Memory-Valenz" bleibt grün: gratitude-Nuance > 0.2 verhindert den „ausgeglichen"-Zweig wie bisher.)

- [ ] **Step 5: Commit**

```bash
git add lib/emotional-state.js test/emotional-dynamics.test.js
git commit -m "feat(emotion): deviation-based mood dominance, trend, stronger mood-congruent recall"
```

---

### Task 5: EmotionalState — Persistenz, Pool-Temperamente, Presets, Format-Helpers

**Files:**
- Modify: `lib/emotional-state.js` (fs-Import; Methoden `serializeState`, `hydrateOnce`; Konstanten `TEMPERAMENT_PRESETS`, `DEFAULT_TEMPERAMENTS`; `createEmotionalStatePool(options)`; Funktionen `formatMoodLine`, `formatMoodFile`, `extractMessageText`)
- Test: `test/emotional-dynamics.test.js` (erweitern)

**Interfaces:**
- Consumes: Task-3/4-Zustand (`current`, `nuanceState`, `lastUpdateAt`, `describeMood()`)
- Produces (alles von Task 7/8 konsumiert):
  - `state.serializeState(): { version: 2, current, nuanceState, lastUpdateAt, baseline }`
  - `state.hydrateOnce(filePath: string): boolean` — lädt einmalig `.emotional-state.json` (Feld `state`), decayed ab `lastUpdateAt` weiter; false bei fehlender/kaputter Datei
  - `TEMPERAMENT_PRESETS`: `{ ausgewogen, warm, "kühl", feurig, stoisch }` mit `{ baseline?, sensitivity, decayMultiplier }`
  - `DEFAULT_TEMPERAMENTS`: `{ main, bernhardine, heisenberg, default }`
  - `createEmotionalStatePool({ temperaments?, moodInfluence? })` — merged User-Config über `DEFAULT_TEMPERAMENTS`
  - `formatMoodLine(mood): string` — z.B. `😤 Aktuelle Stimmung: angespannt (mittel, steigend)`
  - `formatMoodFile(mood, agentId, now?): string` — mehrzeiliger `.current-mood.txt`-Inhalt
  - `extractMessageText(msg): string` — Export der bisher privaten `extractText`-Funktion

- [ ] **Step 1: Failing Tests ergänzen**

An `test/emotional-dynamics.test.js` anhängen (Imports oben in der Datei erweitern):

```js
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEmotionalStatePool,
  TEMPERAMENT_PRESETS,
  DEFAULT_TEMPERAMENTS,
  formatMoodLine,
  formatMoodFile,
  extractMessageText,
} from "../lib/emotional-state.js";
```

```js
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
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `node --test test/emotional-dynamics.test.js`
Expected: FAIL — `TEMPERAMENT_PRESETS`/`formatMoodLine`/... nicht exportiert.

- [ ] **Step 3: `lib/emotional-state.js` implementieren**

Oben ergänzen:

```js
import { readFileSync } from "node:fs";
```

Nach `snapshot()` zwei Methoden einfügen:

```js
  /**
   * Vollständiger, wiederherstellbarer Zustand für die Restart-Persistenz.
   */
  serializeState() {
    this._applyDecay();
    return {
      version: 2,
      current: { ...this.current },
      nuanceState: { ...this.nuanceState },
      lastUpdateAt: this.lastUpdateAt,
      baseline: { ...this.baseline },
    };
  }

  /**
   * Lädt den Zustand einmalig aus einer .emotional-state.json (Feld `state`).
   * Der Decay rechnet ab dem persistierten lastUpdateAt weiter — ein Restart
   * lässt die Stimmung natürlich abklingen statt sie zu löschen.
   *
   * @param {string} filePath
   * @returns {boolean} true wenn Zustand übernommen wurde
   */
  hydrateOnce(filePath) {
    if (this._hydrated) return false;
    this._hydrated = true;
    try {
      const data = JSON.parse(readFileSync(filePath, "utf8"));
      const st = data?.state;
      if (!st || typeof st !== "object" || !st.current || typeof st.current !== "object") return false;
      for (const dim of EMOTION_DIMENSIONS) {
        if (Number.isFinite(st.current[dim])) this.current[dim] = clamp01(st.current[dim]);
      }
      if (st.nuanceState && typeof st.nuanceState === "object") {
        for (const [label, intensity] of Object.entries(st.nuanceState)) {
          if (Number.isFinite(intensity) && intensity > 0) this.nuanceState[label] = clamp01(intensity);
        }
      }
      if (Number.isFinite(st.lastUpdateAt) && st.lastUpdateAt > 0 && st.lastUpdateAt <= Date.now()) {
        this.lastUpdateAt = st.lastUpdateAt;
      }
      this._applyDecay();
      return true;
    } catch (_e) {
      return false;
    }
  }
```

`extractText` exportieren — Funktionskopf ändern von `function extractText(msg) {` zu:

```js
export function extractMessageText(msg) {
```

und die beiden internen Aufrufe (`extractText(msg)` in `updateFromMessages`) auf `extractMessageText(msg)` umstellen.

Vor `createEmotionalStatePool` Konstanten und Helpers einfügen:

```js
/**
 * Benannte Temperament-Presets — wählbar via `/plur1bus temperament <name>`.
 */
export const TEMPERAMENT_PRESETS = Object.freeze({
  ausgewogen: { sensitivity: 1.0, decayMultiplier: 1.0 },
  warm: { baseline: { joy: 0.35, trust: 0.5 }, sensitivity: 1.5, decayMultiplier: 1.3 },
  "kühl": { baseline: { anticipation: 0.3, joy: 0.15 }, sensitivity: 0.8, decayMultiplier: 0.7 },
  feurig: { baseline: { joy: 0.3, anticipation: 0.3 }, sensitivity: 1.8, decayMultiplier: 1.5 },
  stoisch: { sensitivity: 0.5, decayMultiplier: 0.6 },
});

/**
 * Ausgelieferte Default-Temperamente pro Agent (überschreibbar via
 * `emotion.temperaments.<agentId>` in der Plugin-Config).
 */
export const DEFAULT_TEMPERAMENTS = Object.freeze({
  main: { sensitivity: 1.2, decayMultiplier: 1.0 },
  bernhardine: { ...TEMPERAMENT_PRESETS.warm },
  heisenberg: { ...TEMPERAMENT_PRESETS["kühl"] },
  default: { ...TEMPERAMENT_PRESETS.ausgewogen },
});

/**
 * Einzeiler für den injizierten Prompt-Kontext.
 * @param {ReturnType<EmotionalState["describeMood"]>} mood
 */
export function formatMoodLine(mood) {
  if (!mood || !mood.label) return "";
  const trend = mood.trend && mood.trend !== "stabil" ? `, ${mood.trend}` : "";
  return `${mood.emoji || "🧠"} Aktuelle Stimmung: ${mood.label} (${mood.intensity}${trend})`;
}

/**
 * Menschenlesbarer Inhalt für .current-mood.txt.
 * @param {ReturnType<EmotionalState["describeMood"]>} mood
 * @param {string} agentId
 * @param {Date|number} [now]
 */
export function formatMoodFile(mood, agentId = "default", now = new Date()) {
  if (!mood) return "";
  const trend = mood.trend && mood.trend !== "stabil" ? `, ${mood.trend}` : "";
  const nuances = mood.nuances?.length ? mood.nuances.join(", ") : "—";
  const top = Object.entries(mood.details || {})
    .filter(([key]) => EMOTION_DIMENSIONS.includes(key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, value]) => `${key} ${Number(value).toFixed(2)}`)
    .join(" · ");
  return [
    `${mood.emoji || "🧠"} ${mood.label} (${mood.intensity}${trend})`,
    `Dominant: ${mood.dominant} · Nuancen: ${nuances}`,
    `Top: ${top}`,
    `Stand: ${new Date(now).toISOString()} (agent: ${agentId})`,
  ].join("\n") + "\n";
}
```

`createEmotionalStatePool` ersetzen:

```js
/**
 * Factory für pro-Agent EmotionalState-Instanzen mit Temperament-Profilen.
 *
 * @param {object} [options]
 * @param {object} [options.temperaments] — per-Agent-Overrides, gemerged über DEFAULT_TEMPERAMENTS
 * @param {number} [options.moodInfluence] — Stärke des stimmungskongruenten Recall-Boosts
 */
export function createEmotionalStatePool(options = {}) {
  const states = new Map();
  const temperaments = { ...DEFAULT_TEMPERAMENTS, ...(options.temperaments || {}) };

  const resolveProfile = (id) => {
    const profile = temperaments[id] || temperaments.default || {};
    return {
      ...profile,
      moodInfluence: Number.isFinite(profile.moodInfluence) ? profile.moodInfluence : options.moodInfluence,
    };
  };

  return {
    get(agentId) {
      const id = agentId || "default";
      if (!states.has(id)) {
        states.set(id, new EmotionalState(resolveProfile(id)));
      }
      return states.get(id);
    },

    snapshot(agentId) {
      return this.get(agentId).snapshot();
    },

    describe(agentId) {
      return this.get(agentId).describeMood();
    },

    // Wartung: Decay für alle States anwenden (z.B. im Cron)
    decayAll() {
      for (const state of states.values()) {
        state.decay();
      }
    },

    // Status für /zustand Command
    status() {
      const out = {};
      for (const [id, state] of states.entries()) {
        out[id] = state.describeMood();
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run: `node --test test/emotional-dynamics.test.js test/emotion-nuances.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/emotional-state.js test/emotional-dynamics.test.js
git commit -m "feat(emotion): restart persistence, per-agent temperament pool, presets, mood formatters"
```

---

### Task 6: Temperament-Command-Helpers (pure, testbar)

**Files:**
- Create: `lib/temperament-command.js`
- Test: `test/temperament-command.test.js` (neu)

**Interfaces:**
- Consumes: `TEMPERAMENT_PRESETS`, `DEFAULT_TEMPERAMENTS` aus `lib/emotional-state.js`
- Produces (von Task 7 in index.js verdrahtet):
  - `renderTemperamentOverview({ agentId, temperamentsCfg, lang }): string` — aktuelles Temperament + Preset-Liste + Anleitung
  - `applyTemperamentToRawConfig(rawCfg, pluginKey, agentId, presetName): { ok: true, merged: object } | { error: string }` — pure Transformation der geparsten openclaw.json (kein I/O)

- [ ] **Step 1: Failing Tests schreiben**

Datei `test/temperament-command.test.js` anlegen:

```js
/**
 * test/temperament-command.test.js — /plur1bus temperament: Anzeige und
 * Config-Transformation (pure Helpers, I/O passiert in index.js).
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { renderTemperamentOverview, applyTemperamentToRawConfig } from "../lib/temperament-command.js";

describe("renderTemperamentOverview", () => {
  it("zeigt Default-Temperament wenn nichts konfiguriert ist", () => {
    const txt = renderTemperamentOverview({ agentId: "bernhardine", temperamentsCfg: {}, lang: "de" });
    assert.ok(txt.includes("bernhardine"));
    assert.ok(txt.includes("warm"), "Default für bernhardine ist das warm-Preset");
    assert.ok(txt.includes("/plur1bus temperament"));
    for (const preset of ["ausgewogen", "warm", "kühl", "feurig", "stoisch"]) {
      assert.ok(txt.includes(preset), `Preset ${preset} sollte gelistet sein`);
    }
  });

  it("zeigt konfiguriertes Preset an", () => {
    const txt = renderTemperamentOverview({
      agentId: "main",
      temperamentsCfg: { main: { preset: "feurig", sensitivity: 1.8, decayMultiplier: 1.5 } },
      lang: "de",
    });
    assert.ok(txt.includes("feurig"));
  });

  it("rendert auch auf Englisch", () => {
    const txt = renderTemperamentOverview({ agentId: "main", temperamentsCfg: {}, lang: "en" });
    assert.ok(txt.includes("Available presets") || txt.includes("preset"));
  });
});

describe("applyTemperamentToRawConfig", () => {
  const pluginKey = "memory-lancedb-namespaced";
  const makeRawCfg = () => ({
    plugins: { entries: { [pluginKey]: { config: { emotion: {} } } } },
  });

  it("schreibt das Preset unter emotion.temperaments.<agentId>", () => {
    const result = applyTemperamentToRawConfig(makeRawCfg(), pluginKey, "heisenberg", "feurig");
    assert.strictEqual(result.error, undefined);
    const t = result.merged.plugins.entries[pluginKey].config.emotion.temperaments.heisenberg;
    assert.strictEqual(t.preset, "feurig");
    assert.strictEqual(t.sensitivity, 1.8);
    assert.strictEqual(t.decayMultiplier, 1.5);
  });

  it("unbekanntes Preset → error", () => {
    const result = applyTemperamentToRawConfig(makeRawCfg(), pluginKey, "main", "cholerisch");
    assert.ok(result.error, "Sollte error liefern");
    assert.ok(result.error.includes("cholerisch"));
  });

  it("fehlende Plugin-Config → error", () => {
    const result = applyTemperamentToRawConfig({ plugins: { entries: {} } }, pluginKey, "main", "warm");
    assert.ok(result.error);
  });

  it("mutiert das Original nicht", () => {
    const raw = makeRawCfg();
    applyTemperamentToRawConfig(raw, pluginKey, "main", "warm");
    assert.strictEqual(raw.plugins.entries[pluginKey].config.emotion.temperaments, undefined);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `node --test test/temperament-command.test.js`
Expected: FAIL — Modul `lib/temperament-command.js` existiert nicht.

- [ ] **Step 3: `lib/temperament-command.js` implementieren**

```js
/**
 * lib/temperament-command.js — Pure Helpers für /plur1bus temperament.
 *
 * Anzeige der verfügbaren Temperament-Presets und Transformation der
 * geparsten openclaw.json. Datei-I/O und Locking passieren in index.js
 * (analog /plur1bus setup).
 */

import { TEMPERAMENT_PRESETS, DEFAULT_TEMPERAMENTS } from "./emotional-state.js";

/**
 * Beschreibt ein Preset als Listenzeile.
 */
function describePreset(name, preset) {
  const baseline = preset.baseline
    ? `, Baseline ${Object.entries(preset.baseline).map(([dim, value]) => `${dim}=${value}`).join(" ")}`
    : "";
  return `• ${name} — Sensitivity ${preset.sensitivity}, Decay ×${preset.decayMultiplier}${baseline}`;
}

/**
 * Ermittelt das Label des aktuell wirksamen Temperaments eines Agenten.
 */
function currentTemperamentLabel(agentId, temperamentsCfg) {
  const configured = temperamentsCfg?.[agentId];
  if (configured) return configured.preset || "custom";
  const fallback = DEFAULT_TEMPERAMENTS[agentId];
  if (fallback) {
    const match = Object.entries(TEMPERAMENT_PRESETS).find(([, preset]) =>
      preset.sensitivity === fallback.sensitivity && preset.decayMultiplier === fallback.decayMultiplier);
    return match ? `${match[0]} (Default)` : "default";
  }
  return "ausgewogen (Default)";
}

/**
 * Übersicht: aktuelles Temperament + Preset-Liste + Anleitung.
 *
 * @param {{ agentId: string, temperamentsCfg: object, lang: string }} params
 * @returns {string}
 */
export function renderTemperamentOverview({ agentId, temperamentsCfg = {}, lang = "de" }) {
  const de = lang === "de";
  const current = currentTemperamentLabel(agentId, temperamentsCfg);
  const lines = [
    de ? `🎭 Temperament für ${agentId}: ${current}` : `🎭 Temperament for ${agentId}: ${current}`,
    "",
    de ? "Verfügbare Presets:" : "Available presets:",
    ...Object.entries(TEMPERAMENT_PRESETS).map(([name, preset]) => describePreset(name, preset)),
    "",
    de
      ? "Setzen mit: /plur1bus temperament <preset> (Gateway-Restart nötig)"
      : "Set with: /plur1bus temperament <preset> (gateway restart required)",
  ];
  return lines.join("\n");
}

/**
 * Schreibt ein Preset in eine Kopie der geparsten openclaw.json.
 *
 * @param {object} rawCfg — geparste openclaw.json
 * @param {string} pluginKey — Key unter plugins.entries
 * @param {string} agentId
 * @param {string} presetName
 * @returns {{ ok: true, merged: object } | { error: string }}
 */
export function applyTemperamentToRawConfig(rawCfg, pluginKey, agentId, presetName) {
  const preset = TEMPERAMENT_PRESETS[presetName];
  if (!preset) {
    return { error: `Unbekanntes Preset: ${presetName}. Verfügbar: ${Object.keys(TEMPERAMENT_PRESETS).join(", ")}` };
  }
  const pluginCfg = rawCfg?.plugins?.entries?.[pluginKey]?.config;
  if (!pluginCfg || typeof pluginCfg !== "object") {
    return { error: `Plugin-Config für "${pluginKey}" nicht in openclaw.json gefunden` };
  }
  const merged = structuredClone(rawCfg);
  const mergedPluginCfg = merged.plugins.entries[pluginKey].config;
  mergedPluginCfg.emotion = mergedPluginCfg.emotion || {};
  mergedPluginCfg.emotion.temperaments = mergedPluginCfg.emotion.temperaments || {};
  mergedPluginCfg.emotion.temperaments[agentId] = { ...preset, preset: presetName };
  return { ok: true, merged };
}
```

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run: `node --test test/temperament-command.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/temperament-command.js test/temperament-command.test.js
git commit -m "feat(emotion): temperament command helpers (preset overview + config transform)"
```

---

### Task 7: index.js-Verdrahtung — Config, Pool, Recall-Pfad, Mood-Injection, Command

**Files:**
- Modify: `index.js:196` (Import), `index.js:~2023-2051` (Emotion-Config), `index.js:~2221` (Pool), `index.js:~2859-2877` (start-Anzeige), `index.js:~2878` (neuer temperament-Command vor dem setup-Block), `index.js:~3221` (Command-Tabelle), `index.js:~3989/~4575/~4623` (applyDynamicsDefaults-Aufrufe mit Emotion), `index.js:~5060-5067` (Recall-Pfad), `index.js:~5517` (fullMemoriesContext)
- Modify: `lib/i18n-dictionary.js:418,421` (Quick-Help um temperament-Zeile ergänzen)

**Interfaces:**
- Consumes: alles aus Tasks 1-6 — `modulateHalfLifeDays`-Verhalten via `applyDynamicsDefaults(entry, now, halfLifeOverrides, { intensityHalfLifeFactor })`; `formatMoodLine`, `formatMoodFile`, `extractMessageText`, `createEmotionalStatePool(options)`, `hydrateOnce`, `serializeState`, `applyEmotionScore`; `renderTemperamentOverview`, `applyTemperamentToRawConfig`
- Produces: neue Config-Keys `emotion.t3.escalationConfidence` (0.85), `emotion.t3.timeoutMs` (4000), `emotion.moodInfluence` (0.3), `emotion.intensityHalfLifeFactor` (1.0), `emotion.temperaments.<agentId>`; Command `/plur1bus temperament`

**WICHTIG:** Zeilennummern verschieben sich mit jedem Edit — immer über die zitierten Code-Anker suchen, nicht über Zeilennummern.

- [ ] **Step 1: Import erweitern**

`index.js:196` alt:

```js
import { createEmotionalStatePool } from "./lib/emotional-state.js";
```

neu:

```js
import { createEmotionalStatePool, formatMoodLine, formatMoodFile, extractMessageText, DEFAULT_TEMPERAMENTS } from "./lib/emotional-state.js";
import { renderTemperamentOverview, applyTemperamentToRawConfig } from "./lib/temperament-command.js";
```

- [ ] **Step 2: Emotion-Config erweitern**

Direkt vor dem `setEmotionConfig({...})`-Aufruf (Anker: `setEmotionConfig({`, ~Zeile 2044) einfügen:

```js
    // Emotionale Dynamik (Spec 2026-07-01): aggressive T3-Eskalation,
    // Timeout-Schutz, Recall-Gewicht und Decay-Kopplung.
    const emotionT3EscalationConfidence = emotionCfg.t3?.escalationConfidence ?? 0.85;
    const emotionT3TimeoutMs = emotionCfg.t3?.timeoutMs ?? 4000;
    const emotionMoodInfluence = emotionCfg.moodInfluence ?? 0.3;
    const emotionIntensityHalfLifeFactor = emotionCfg.intensityHalfLifeFactor ?? 1.0;
```

Den `setEmotionConfig`-Aufruf ersetzen:

```js
    setEmotionConfig({
      tier: emotionTier,
      t2: { enabled: emotionT2Enabled },
      t3: { enabled: emotionT3Enabled, model: emotionT3Model, callLlm: emotionT3CallLlm, apiKey: emotionCfg.t3?.apiKey || null, baseUrl: emotionCfg.t3?.baseUrl || undefined, timeoutMs: emotionT3TimeoutMs },
      escalationConfidence: emotionT3EscalationConfidence,
    });
```

- [ ] **Step 3: Pool mit Temperamenten erzeugen**

Anker `const emotionalPool = createEmotionalStatePool();` (~Zeile 2221) ersetzen durch:

```js
    const emotionalPool = createEmotionalStatePool({
      temperaments: emotionCfg.temperaments || {},
      moodInfluence: emotionMoodInfluence,
    });
```

Hinweis: `emotionCfg` ist ab ~Zeile 2023 im selben Funktions-Scope definiert — Reihenfolge prüfen (Emotion-Config-Block steht VOR der Pool-Erzeugung).

- [ ] **Step 4: Recall-Pfad — Engine-Update, Rehydrierung, Mood-Dateien**

Anker (aktuell ~5060-5067):

```js
          emotionalPool.get(agentId).updateFromMessages(voiceMessages);
          if (ctx?.workspaceDir) {
            try {
              writeFileSync(join(ctx.workspaceDir, ".emotional-state.json"), JSON.stringify({ ...emotionalPool.describe(agentId), agentId, ts: Date.now() }));
            } catch (e) {
              dbg(e);
            }
          }
```

ersetzen durch:

```js
          const emoState = emotionalPool.get(agentId);
          // Restart-Persistenz: Zustand einmalig aus der Datei zurücklesen,
          // Decay rechnet ab persistiertem lastUpdateAt weiter.
          if (ctx?.workspaceDir) {
            try { emoState.hydrateOnce(join(ctx.workspaceDir, ".emotional-state.json")); } catch (e) { dbg(e); }
          }
          // Stimmung aus dem aktuellen Turn via EmotionEngine (T1→T2→T3)
          // statt der alten Regex-Heuristik ableiten.
          try {
            const promptText = typeof event.prompt === "string" ? event.prompt.trim() : "";
            const lastUserText = promptText
              || extractMessageText([...voiceMessages].reverse().find((m) => m && m.role === "user")).trim();
            if (lastUserText.length >= 3) {
              const turnEmotion = await inferEmotionalValenceAsync(lastUserText.slice(0, 2000), "user");
              emoState.applyEmotionScore(turnEmotion);
            } else {
              emoState.updateFromMessages(voiceMessages);
            }
          } catch (e) {
            dbg(e);
            emoState.updateFromMessages(voiceMessages);
          }
          if (ctx?.workspaceDir) {
            try {
              const moodNow = emoState.describeMood();
              writeFileSync(join(ctx.workspaceDir, ".emotional-state.json"), JSON.stringify({ ...moodNow, agentId, ts: Date.now(), state: emoState.serializeState() }));
              writeFileSync(join(ctx.workspaceDir, ".current-mood.txt"), formatMoodFile(moodNow, agentId));
            } catch (e) {
              dbg(e);
            }
          }
```

- [ ] **Step 5: Stimmungszeile in den injizierten Kontext**

Anker (aktuell ~5517):

```js
          const fullMemoriesContext = reactivationContext
            ? memoriesContext + "\n\n" + reactivationContext
            : memoriesContext;
```

ersetzen durch:

```js
          const moodLine = formatMoodLine(emotionalPool.describe(agentId));
          const fullMemoriesContext = [moodLine, memoriesContext, reactivationContext].filter(Boolean).join("\n\n");
```

- [ ] **Step 6: Intensitäts-Modulation an den drei Store-Sites**

An den drei `applyDynamicsDefaults(...)`-Aufrufen, die `emotionalValence`/`emotionalIntensity` setzen (Anker: `moodContextAtCapture: serializeEmotionalValence(`, drei Treffer: Auto-Capture ~3989, Merged-Store ~4575, Normal-Store ~4623), jeweils den dritten Parameter `halfLifeOverrides)` um den vierten ergänzen:

```js
}, captureTimestamp, halfLifeOverrides, { intensityHalfLifeFactor: emotionIntensityHalfLifeFactor });
```

bzw. an den beiden Stellen mit `Date.now()`:

```js
}, Date.now(), halfLifeOverrides, { intensityHalfLifeFactor: emotionIntensityHalfLifeFactor });
```

Die übrigen `applyDynamicsDefaults`-Aufrufe (erste Store-Implementierung ~2386/~2423, `lib/wiki-command.js`) bleiben unverändert — dort gibt es keine `emotionalIntensity`, die Modulation wäre ein No-Op.

- [ ] **Step 7: `/plur1bus temperament`-Command**

Direkt VOR dem Block `if (actionKey === "setup") {` (~Zeile 2878) einfügen:

```js
            if (actionKey === "temperament") {
              const { lang, tone } = resolveCommandLocale(commandCtx);
              const de = lang === "de";
              const temperamentAgentId = commandCtx?.agentId || "default";
              const presetName = (sub || "").toLowerCase();
              if (!presetName) {
                return { text: renderTemperamentOverview({ agentId: temperamentAgentId, temperamentsCfg: cfg.emotion?.temperaments || {}, lang }) };
              }
              const denied = checkAuth(commandCtx, { destructive: true });
              if (denied) return denied;
              if (cfg.security?.allowChatConfigCommands === false) {
                return { text: t("plur1bus.setup_blocked", { lang, tone }) };
              }
              const openclawHome = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
              const openclawConfigPath = process.env.OPENCLAW_CONFIG_PATH || join(openclawHome, "openclaw.json");
              const writeResult = withConfigLock(openclawConfigPath, () => {
                let rawTemperamentCfg;
                try {
                  rawTemperamentCfg = JSON.parse(readFileSync(openclawConfigPath, "utf8"));
                } catch (err) {
                  return { error: `openclaw.json not readable: ${err.message}` };
                }
                const applied = applyTemperamentToRawConfig(rawTemperamentCfg, PLUGIN_KEY, temperamentAgentId, presetName);
                if (applied.error) return { error: applied.error };
                try {
                  const tmp = `${openclawConfigPath}.tmp-${process.pid}-${Date.now()}`;
                  writeFileSync(tmp, JSON.stringify(applied.merged, null, 2));
                  renameSync(tmp, openclawConfigPath);
                } catch (err) {
                  return { error: `Saving config failed: ${err.message}` };
                }
                return { ok: true };
              });
              if (writeResult?.error) return { text: `❌ ${writeResult.error}` };
              return { text: de
                ? `🎭 Temperament für ${temperamentAgentId} auf "${presetName}" gesetzt. ${t("plur1bus.setup_restart", { lang, tone })}`
                : `🎭 Temperament for ${temperamentAgentId} set to "${presetName}". ${t("plur1bus.setup_restart", { lang, tone })}` };
            }
```

- [ ] **Step 8: start-Anzeige + Command-Tabelle + Hilfe**

Im `if (actionKey === "start")`-Block nach `lines.push(statusText);` (~Zeile 2870) einfügen:

```js
              const startAgentId = commandCtx?.agentId || "default";
              const startTemperament = cfg.emotion?.temperaments?.[startAgentId];
              const startTemperamentLabel = startTemperament?.preset || (startTemperament ? "custom" : (DEFAULT_TEMPERAMENTS[startAgentId] ? "default-Profil" : "ausgewogen"));
              lines.push("", `🎭 Temperament (${startAgentId}): ${startTemperamentLabel} — ändern mit /plur1bus temperament <preset>`);
```

In der Command-Tabelle (~Zeile 3221, nach dem `plur1bus_start`-Eintrag) ergänzen:

```js
          { name: "plur1bus_temperament", description: "Show or set the agent's emotional temperament.", acceptsArgs: true, prefixTokens: ["temperament"] },
```

In `lib/i18n-dictionary.js` in den Quick-Help-Texten (Keys ~418 de / ~421 en) nach der `/plur1bus setup <profil>`-Zeile jeweils ergänzen:

- de: `/plur1bus temperament <preset> — Temperament des Agenten wählen (ausgewogen, warm, kühl, feurig, stoisch)`
- en: `/plur1bus temperament <preset> — choose the agent's temperament (ausgewogen, warm, kühl, feurig, stoisch)`

- [ ] **Step 9: Syntax- und Volltest**

Run: `node --check index.js && npm test 2>&1 | tail -20`
Expected: Syntax OK; Testsuite mit exakt den 4 bekannten pre-existing Failures (`memory-store-decision-trace` 2×, `memory-store-merge-safety` 2×), **keine neuen** Failures. Insbesondere müssen `tests/auto-recall-*.test.js`, `test/status.test.js` und `test/i18n-*`-Tests grün bleiben.

- [ ] **Step 10: Commit**

```bash
git add index.js lib/i18n-dictionary.js
git commit -m "feat(emotion): wire emotional dynamics — engine-driven mood, persistence, prompt injection, /plur1bus temperament"
```

---

### Task 8: README-Doku + Abschlussverifikation

**Files:**
- Modify: `README.md` (Emotion-Config-Beispiel ~Zeile 221 und Config-Key-Liste ~Zeile 327)

**Interfaces:**
- Consumes: Config-Keys aus Task 7
- Produces: dokumentierte Keys für Endnutzer/ClawHub

- [ ] **Step 1: README erweitern**

Im Config-Beispiel (`"emotion": {` ~Zeile 221) die neuen Keys zeigen:

```json
          "emotion": {
            "tier": "auto",
            "t3": {
              "enabled": true,
              "model": "kimi-for-coding",
              "escalationConfidence": 0.85,
              "timeoutMs": 4000
            },
            "moodInfluence": 0.3,
            "intensityHalfLifeFactor": 1.0,
            "temperaments": {
              "bernhardine": { "preset": "warm", "baseline": { "joy": 0.35, "trust": 0.5 }, "sensitivity": 1.5, "decayMultiplier": 1.3 }
            }
          }
```

(Bestehende Keys im Beispiel beibehalten, nur ergänzen.)

In der Config-Key-Liste (~Zeile 327) ergänzen: `emotion.t3.escalationConfidence`, `emotion.t3.timeoutMs`, `emotion.moodInfluence`, `emotion.intensityHalfLifeFactor`, `emotion.temperaments.<agentId>`.

Nach dem `**emotion.t3**`-Absatz (~Zeile 264) einen kurzen Absatz ergänzen:

```markdown
**`emotion.temperaments`** — per-agent emotional temperament. Ships with defaults for `main` (balanced-direct), `bernhardine` (warm/expressive), `heisenberg` (cool/analytical). Pick a preset via `/plur1bus temperament <preset>` (`ausgewogen`, `warm`, `kühl`, `feurig`, `stoisch`) — requires a gateway restart. Mood always derives from conversation content; the temperament only shapes how strongly and how long it swings. The current mood is written to `.emotional-state.json` (machine-readable, survives restarts) and `.current-mood.txt` (human-readable) in the agent workspace, injected as a mood line into the recall context, stamped on every memory card (`moodContextAtCapture`), and emotionally intense memories decay slower (`intensityHalfLifeFactor`).
```

- [ ] **Step 2: Abschlussverifikation**

Run: `npm test 2>&1 | tail -5`
Expected: identische Baseline (4 pre-existing Failures, keine neuen).

Manueller Smoke-Test (optional, wenn Gateway-Umgebung verfügbar): nach Deployment + Restart eine emotional gefärbte Nachricht an einen Agenten senden und prüfen, dass `.emotional-state.json` ein Label ≠ „ausgeglichen" und `.current-mood.txt` existiert.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: emotional dynamics config keys, temperament presets, mood files"
```
