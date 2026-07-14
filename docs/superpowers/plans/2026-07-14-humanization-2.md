# Humanization 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sechs Humanization-Features aus der Spec `docs/superpowers/specs/2026-07-14-humanization-2-design.md`: Unsicherheits-Hedging, erweiterte Stil-Direktive, adaptiver Proactive Governor, Traum-Echos, Persona-Voice (Seed + Evolution), Nachgedanken, Reaktions-Neigung.

**Architecture:** Kleine pure lib-Module + dünne Orchestrierung in `index.js` an den bestehenden Kontextbau-Ankern (~5600–5680). Proaktive Features teilen sich einen adaptiven Budget-Regler (`proactive-governor`), der die vorhandenen reply-outcomes als Feedback liest. Kein Feature bricht je den Message-Flow (fail-open).

**Tech Stack:** Node.js ES Modules, Node test runner (`npm test`, `tests/*.test.js`), keine neuen Dependencies.

## Global Constraints

- **Generalisierung:** Nichts auf konkrete Agenten/User verdrahtet; jedes Feature funktioniert in frischen Installationen oder degradiert stillschweigend.
- **Fail-open:** try/catch → null/Fallback, nie den Message-Flow brechen. Kontextblöcke ≤ ~400 Zeichen, deutsche Direktiven.
- Config-Gates: alle neuen Features default **an**, außer proaktive Sends (Governor-gebremst) und `reactionNudge` (default `"auto"`).
- Zeit/Zufall injizierbar (`now`-Parameter), Tests ohne LLM-Aufrufe (callLlm als Mock-Funktion übergeben).
- Jede neue lib-Datei in `DEPLOY_FILES` in `scripts/lib/deploy-integrity.mjs` eintragen (Sektion `── humanization features ──`) — ein Test erzwingt das.
- Bestehende Signaturen nicht brechen: neue Parameter nur als optionale Objekt-Parameter mit Defaults.
- Test-Referenzstil: `tests/open-threads.test.js`, `tests/mood-style-directive.test.js` (describe/it, node:assert).
- reply-outcomes-Log-Einträge haben die Felder `{timestamp, outcome, userPrompt, agentId, sessionKey, ...}` mit `timestamp` in ms und `outcome` ∈ {confirmed_or_continued, continued_topic, acknowledged, asked_details, ignored_or_topic_shifted, corrected, rejected, neutral}. Reader: `readReplyOutcomeLog(workspaceDir, limit)` aus `lib/reply-outcome-tracking.js` (newest-first).

---

### Task 1: F3 Unsicherheits-Hedging (`lib/recall-confidence-framing.js`)

**Files:**
- Create: `lib/recall-confidence-framing.js`
- Modify: `lib/relevant-memory-context.js` (uncertain-Attribut + Instruktion, analog zum bestehenden faded-Mechanismus ~Zeile 88–118)
- Modify: `index.js:5634` (`formatRelevantMemoriesContext(associativeItems, …)` → gerahmte Items)
- Modify: `scripts/lib/deploy-integrity.mjs` (DEPLOY_FILES + `"lib/recall-confidence-framing.js"`)
- Test: `tests/recall-confidence-framing.test.js`

**Interfaces:**
- Produces: `frameRecallConfidence(memories, opts) → { items, hedgedIds }` — pure; markiert Kopien schwacher Treffer mit `recallUncertain: true`, mutiert nie die Originale.
- Der Formatter `formatRelevantMemoriesContext` rendert für markierte Items das Attribut `uncertain="true"` und hängt (einmalig) eine UNCERTAIN-RECALL-Instruktion an — exakt wie der bestehende faded-Mechanismus (`fadedInstruction`).

- [ ] **Step 1: Failing Tests schreiben** — `tests/recall-confidence-framing.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert";
import { frameRecallConfidence } from "../lib/recall-confidence-framing.js";

function mem(id, score) { return { id, relevanceScore: score, display: `text-${id}` }; }

describe("frameRecallConfidence", () => {
  it("markiert das untere Drittel als unsicher", () => {
    const items = [mem("a", 0.9), mem("b", 0.8), mem("c", 0.7), mem("d", 0.3), mem("e", 0.2), mem("f", 0.1)];
    const { items: framed, hedgedIds } = frameRecallConfidence(items);
    assert.deepStrictEqual([...hedgedIds].sort(), ["e", "f"]); // maxHedged=2, niedrigste zuerst
    assert.strictEqual(framed.find((m) => m.id === "f").recallUncertain, true);
    assert.strictEqual(framed.find((m) => m.id === "a").recallUncertain, undefined);
  });

  it("mutiert die Originale nicht", () => {
    const items = [mem("a", 0.9), mem("b", 0.5), mem("c", 0.1)];
    frameRecallConfidence(items);
    assert.strictEqual(items[2].recallUncertain, undefined);
  });

  it("hedgt nichts bei weniger als minItems", () => {
    const { hedgedIds } = frameRecallConfidence([mem("a", 0.9), mem("b", 0.1)]);
    assert.deepStrictEqual(hedgedIds, []);
  });

  it("hedgt nichts, wenn alle Scores gleich sind (kein Spread)", () => {
    const { hedgedIds } = frameRecallConfidence([mem("a", 0.5), mem("b", 0.5), mem("c", 0.5)]);
    assert.deepStrictEqual(hedgedIds, []);
  });

  it("ignoriert Items ohne numerischen relevanceScore", () => {
    const items = [mem("a", 0.9), mem("b", 0.8), { id: "x", display: "no-score" }, mem("c", 0.1)];
    const { hedgedIds, items: framed } = frameRecallConfidence(items);
    assert.ok(!hedgedIds.includes("x"));
    assert.strictEqual(framed.length, 4);
  });

  it("cap maxHedged greift", () => {
    const items = [mem("a", 0.9), mem("b", 0.8), mem("c", 0.7), mem("d", 0.03), mem("e", 0.02), mem("f", 0.01)];
    const { hedgedIds } = frameRecallConfidence(items, { maxHedged: 1 });
    assert.deepStrictEqual(hedgedIds, ["f"]);
  });

  it("fail-open bei kaputtem Input", () => {
    assert.deepStrictEqual(frameRecallConfidence(null).hedgedIds, []);
    assert.deepStrictEqual(frameRecallConfidence("nope").hedgedIds, []);
  });
});
```

- [ ] **Step 2: Test laufen lassen** — `node --test tests/recall-confidence-framing.test.js` → FAIL (module not found).

- [ ] **Step 3: Implementierung** — `lib/recall-confidence-framing.js`:

```js
/**
 * lib/recall-confidence-framing.js — Unsicherheits-Hedging nach Recall-Score.
 *
 * Markiert die relativ schwächsten Recall-Treffer (unteres Drittel der
 * Score-Verteilung, max. 2 pro Antwort) mit `recallUncertain: true`.
 * Die Textdarstellung übernimmt lib/relevant-memory-context.js
 * (uncertain="true"-Attribut + globale Instruktion, analog faded).
 *
 * Pure, fail-open, mutiert nie die Original-Items. Relative Schwelle statt
 * absoluter Zahl — robust gegenüber Provider-/Score-Skalen-Unterschieden.
 */

export function frameRecallConfidence(memories, opts = {}) {
  const passthrough = { items: Array.isArray(memories) ? memories : [], hedgedIds: [] };
  try {
    const { minItems = 3, bottomFraction = 1 / 3, maxHedged = 2 } = opts;
    if (!Array.isArray(memories) || memories.length < minItems) return passthrough;

    const scored = memories.filter((m) => Number.isFinite(m?.relevanceScore));
    if (scored.length < minItems) return passthrough;

    const scores = scored.map((m) => m.relevanceScore).sort((a, b) => a - b);
    const cut = scores[Math.max(0, Math.ceil(scores.length * bottomFraction) - 1)];
    const top = scores[scores.length - 1];
    if (!(top > cut)) return passthrough; // kein Spread → nichts hedgen

    const hedgedIds = scored
      .filter((m) => m.relevanceScore <= cut)
      .sort((a, b) => a.relevanceScore - b.relevanceScore)
      .slice(0, maxHedged)
      .map((m) => m.id);
    const hedgedSet = new Set(hedgedIds);

    const items = memories.map((m) => (hedgedSet.has(m?.id) ? { ...m, recallUncertain: true } : m));
    return { items, hedgedIds };
  } catch (_) {
    return passthrough;
  }
}
```

- [ ] **Step 4: Formatter erweitern** — in `lib/relevant-memory-context.js`:
  (a) Nach dem `fadedInstruction`-Block (~Zeile 93) analog ergänzen:

```js
  const hasUncertain = memories.some((m) => m.recallUncertain === true);
  const uncertainInstruction = hasUncertain
    ? `\nUNCERTAIN RECALL: Records marked uncertain matched only weakly. Do not present them as fact. Use uncertainty framing appropriate to the reply language — in German: "ich glaube", "wenn ich mich recht erinnere" — and when in doubt ask a short clarifying question instead of asserting.`
    : "";
```

  (b) In der Attribut-Assemblierung pro Item (bei `fadeAttr`/`dreamAttr`, ~Zeile 144):

```js
    const uncertainAttr = m.recallUncertain === true ? ' uncertain="true"' : "";
```

  und `uncertainAttr` in den Tag-String einfügen (direkt neben `fadeAttr`).
  (c) `uncertainInstruction` dort anhängen, wo `fadedInstruction` in den Output eingeht (per Grep nach `fadedInstruction` finden, gleiche Stelle).

- [ ] **Step 5: index.js-Integration** — an `index.js:5634` vor dem `formatRelevantMemoriesContext`-Aufruf:

```js
          let framedItems = associativeItems;
          try {
            if ((cfg.recallHedging?.enabled ?? true) !== false) {
              const { frameRecallConfidence } = await import("./lib/recall-confidence-framing.js");
              framedItems = frameRecallConfidence(associativeItems, cfg.recallHedging || {}).items;
            }
          } catch (_) { framedItems = associativeItems; }
```

  und im bestehenden Aufruf `formatRelevantMemoriesContext(associativeItems, {` → `formatRelevantMemoriesContext(framedItems, {`. **Wichtig:** `recordPendingReplyOutcome` (Zeile ~5608) nutzt weiterhin `associativeItems` — nicht anfassen.

- [ ] **Step 6: DEPLOY_FILES** — `"lib/recall-confidence-framing.js"` in `scripts/lib/deploy-integrity.mjs` unter `── humanization features ──` ergänzen.

- [ ] **Step 7: Volle Suite** — `npm test` → alles grün (insbesondere bestehende `relevant-memory-context`-Tests).

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat: recall confidence hedging (uncertain recall framing)"`

---

### Task 2: F4 Stil-Direktive erweitern (Meinung, Nachfragen, Tageszeit)

**Files:**
- Modify: `lib/mood-style-directive.js` (Signatur-Erweiterung, abwärtskompatibel)
- Modify: `index.js:5646` (Aufruf mit opts)
- Test: `tests/mood-style-directive.test.js` (erweitern, bestehende Tests bleiben grün)

**Interfaces:**
- Produces: `buildMoodStyleDirective(mood, opts = {})` mit `opts = { hour = null, temperamentName = null, opinion = false, askBack = false }`. Ohne opts identisches Verhalten wie bisher (bestehende Tests unverändert grün). Liefert auch bei ungültigem `mood` eine Direktive, wenn opts-Teile aktiv sind; null nur wenn gar nichts beizutragen ist.

- [ ] **Step 1: Failing Tests ergänzen** — in `tests/mood-style-directive.test.js` anhängen:

```js
describe("buildMoodStyleDirective — Erweiterungen (F4)", () => {
  const mood = { dominant: "joy", intensity: "mittel", trend: "stabil" };

  it("Tageszeit morgens: knapper", () => {
    const d = buildMoodStyleDirective(mood, { hour: 7 });
    assert.match(d, /knapp/i);
  });

  it("Tageszeit abends: gesprächiger", () => {
    const d = buildMoodStyleDirective(mood, { hour: 21 });
    assert.match(d, /gesprächiger/i);
  });

  it("Tageszeit mittags: kein Tageszeit-Zusatz", () => {
    const d = buildMoodStyleDirective(mood, { hour: 13 });
    assert.doesNotMatch(d, /Morgen|Abend/);
  });

  it("Meinung und Nachfragen als Zusätze", () => {
    const d = buildMoodStyleDirective(mood, { opinion: true, askBack: true });
    assert.match(d, /widersprechen/);
    assert.match(d, /Rückfrage/);
  });

  it("weiches Temperament → sanftere Meinungs-Formulierung", () => {
    const soft = buildMoodStyleDirective(mood, { opinion: true, temperamentName: "warm" });
    const hard = buildMoodStyleDirective(mood, { opinion: true, temperamentName: "ausgewogen" });
    assert.notStrictEqual(soft, hard);
    assert.match(soft, /sanft/);
  });

  it("liefert Direktive auch ohne gültige Mood, wenn opts aktiv", () => {
    const d = buildMoodStyleDirective(null, { opinion: true });
    assert.ok(typeof d === "string" && d.length > 0);
    assert.doesNotMatch(d, /Stimmung/); // NO_LABEL nur bei Mood-Teil
  });

  it("null wenn weder Mood noch opts etwas beitragen", () => {
    assert.strictEqual(buildMoodStyleDirective(null, {}), null);
  });

  it("Längen-Kappung: ganze hintere Teile fallen weg, nie über 400", () => {
    const d = buildMoodStyleDirective({ dominant: "sadness", intensity: "hoch", trend: "steigend" }, { hour: 21, opinion: true, askBack: true });
    assert.ok(d.length <= 400);
  });
});
```

- [ ] **Step 2: Run** — `node --test tests/mood-style-directive.test.js` → neue Tests FAIL.

- [ ] **Step 3: Implementierung** — `lib/mood-style-directive.js` erweitern (bestehende Konstanten bleiben; Funktion ersetzen):

```js
const TIME_MORNING = "Es ist früher Morgen — halte dich eher knapp und nüchtern.";
const TIME_EVENING = "Es ist Abend — du darfst etwas gesprächiger und lockerer sein.";
const OPINION_STANDARD = "Du darfst eine eigene Einschätzung haben und freundlich, aber klar widersprechen — du musst nicht validieren.";
const OPINION_SOFT = "Du darfst eine eigene Einschätzung haben und sanft widersprechen, wenn du anderer Meinung bist.";
const SOFT_TEMPERAMENTS = new Set(["warm", "sensibel"]);
const ASK_BACK = "Wenn eine Anfrage mehrdeutig ist, stelle EINE kurze Rückfrage, statt still die wahrscheinlichste Deutung anzunehmen.";

export function buildMoodStyleDirective(mood, opts = {}) {
  try {
    const { hour = null, temperamentName = null, opinion = false, askBack = false } = opts || {};

    // Mood-Basis (Priorität 1) — wie bisher
    const moodParts = [];
    if (mood && typeof mood === "object" && mood.dominant && KNOWN_DIMS.has(mood.dominant)) {
      const intensity = KNOWN_INTENSITIES.has(mood.intensity) ? mood.intensity : "mittel";
      const toneSentence = TONE_BY_DIM[mood.dominant][intensity];
      if (toneSentence) {
        moodParts.push(toneSentence);
        const energySentence = ENERGY_BY_TREND[mood.trend];
        if (energySentence) moodParts.push(energySentence);
        moodParts.push(NO_LABEL_INSTRUCTION);
      }
    }

    // Zusätze in Prioritätsreihenfolge: Tageszeit > Meinung > Nachfragen
    const extras = [];
    if (Number.isInteger(hour)) {
      if (hour < 10) extras.push(TIME_MORNING);
      else if (hour >= 20) extras.push(TIME_EVENING);
    }
    if (opinion) extras.push(SOFT_TEMPERAMENTS.has(temperamentName) ? OPINION_SOFT : OPINION_STANDARD);
    if (askBack) extras.push(ASK_BACK);

    if (moodParts.length === 0 && extras.length === 0) return null;

    // Ganze hintere Teile weglassen statt mitten im Satz zu kappen.
    let directive = moodParts.join(" ");
    for (const extra of extras) {
      const candidate = directive ? `${directive} ${extra}` : extra;
      if (candidate.length > MAX_CHARS) break;
      directive = candidate;
    }
    if (directive.length > MAX_CHARS) {
      directive = directive.slice(0, MAX_CHARS - 1).trimEnd() + "…";
    }
    return directive || null;
  } catch (_) {
    return null;
  }
}
```

- [ ] **Step 4: index.js-Aufruf erweitern** — `index.js:5646`:

```js
          const styleCfg = cfg.styleDirective || {};
          const moodStyleDirective = buildMoodStyleDirective(emotionalPool.describe(agentId), {
            hour: styleCfg.timeOfDay !== false ? new Date(nowMs).getHours() : null,
            temperamentName: cfg.emotion?.temperaments?.[agentId]?.preset ?? null,
            opinion: styleCfg.opinion !== false,
            askBack: styleCfg.askBack !== false,
          });
```

- [ ] **Step 5: Volle Suite** — `npm test` → grün (alte mood-style-Tests unverändert bestehen, da opts default inaktiv — Achtung: `opinion`/`askBack` default `false` in der lib, aktiviert nur via index.js-Config).

- [ ] **Step 6: Commit** — `git commit -am "feat: style directive extensions (opinion, ask-back, time of day)"`

---

### Task 3: Proactive Governor (`lib/proactive-governor.js`)

**Files:**
- Create: `lib/proactive-governor.js`
- Modify: `scripts/lib/deploy-integrity.mjs` (+ `"lib/proactive-governor.js"`)
- Test: `tests/proactive-governor.test.js`

**Interfaces (Produces — Tasks 4 und 7 verlassen sich exakt hierauf):**
- `createGovernorState(now)` → `{ schema: 1, budgetPerWeek: 2, sends: [], adjustedAt: 0 }`
- `applyOutcomeAdjustments(state, outcomes, { now })` → neuer State; `outcomes` = Einträge aus `readReplyOutcomeLog` (Feld `timestamp` ms, `outcome` String)
- `evaluateGovernor(state, now)` → `{ allowed: boolean, budgetPerWeek: number, reason: string }`
- `recordProactiveSend(state, featureId, now)` → neuer State
- `loadGovernorState(workspaceDir)` / `saveGovernorState(workspaceDir, state)` — Datei `.proactive-governor.json`, atomar (tmp+rename), fail-open (Load-Fehler → `createGovernorState()`)

- [ ] **Step 1: Failing Tests** — `tests/proactive-governor.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createGovernorState, applyOutcomeAdjustments, evaluateGovernor, recordProactiveSend,
} from "../lib/proactive-governor.js";

const H = 3600000, D = 86400000;
const T0 = 1750000000000;

describe("proactive-governor", () => {
  it("Startzustand: Budget 2, erlaubt", () => {
    const s = createGovernorState(T0);
    assert.strictEqual(s.budgetPerWeek, 2);
    assert.strictEqual(evaluateGovernor(s, T0).allowed, true);
  });

  it("blockt, wenn Wochenbudget verbraucht", () => {
    let s = createGovernorState(T0);
    s = recordProactiveSend(s, "dream-echo", T0);
    s = recordProactiveSend(s, "afterthought", T0 + D);
    assert.strictEqual(evaluateGovernor(s, T0 + 2 * D).allowed, false);
  });

  it("Wochenfenster-Rollover: alte Sends zählen nicht mehr", () => {
    let s = createGovernorState(T0);
    s = recordProactiveSend(s, "dream-echo", T0);
    s = recordProactiveSend(s, "dream-echo", T0 + D);
    assert.strictEqual(evaluateGovernor(s, T0 + 8 * D).allowed, true);
  });

  it("positive attribuierte Outcomes heben das Budget (+0.25, Cap 4)", () => {
    let s = createGovernorState(T0);
    s = recordProactiveSend(s, "dream-echo", T0);
    const outcomes = Array.from({ length: 20 }, (_, i) => ({
      timestamp: T0 + H + i, outcome: "confirmed_or_continued",
    }));
    s = applyOutcomeAdjustments(s, outcomes, { now: T0 + 2 * H });
    assert.strictEqual(s.budgetPerWeek, 4); // 2 + 20*0.25 geclampt auf 4
  });

  it("negative attribuierte Outcomes senken das Budget (Floor 1)", () => {
    let s = createGovernorState(T0);
    s = recordProactiveSend(s, "dream-echo", T0);
    const outcomes = Array.from({ length: 20 }, (_, i) => ({
      timestamp: T0 + H + i, outcome: "ignored_or_topic_shifted",
    }));
    s = applyOutcomeAdjustments(s, outcomes, { now: T0 + 2 * H });
    assert.strictEqual(s.budgetPerWeek, 1);
  });

  it("Outcomes außerhalb des 6h-Attribution-Fensters zählen nicht", () => {
    let s = createGovernorState(T0);
    s = recordProactiveSend(s, "dream-echo", T0);
    s = applyOutcomeAdjustments(s, [{ timestamp: T0 + 7 * H, outcome: "confirmed_or_continued" }], { now: T0 + 8 * H });
    assert.strictEqual(s.budgetPerWeek, 2);
  });

  it("Outcomes ohne vorherigen Send zählen nicht", () => {
    let s = createGovernorState(T0);
    s = applyOutcomeAdjustments(s, [{ timestamp: T0 + H, outcome: "confirmed_or_continued" }], { now: T0 + 2 * H });
    assert.strictEqual(s.budgetPerWeek, 2);
  });

  it("adjustedAt verhindert Doppelzählung bei erneutem Aufruf", () => {
    let s = createGovernorState(T0);
    s = recordProactiveSend(s, "dream-echo", T0);
    const outcomes = [{ timestamp: T0 + H, outcome: "confirmed_or_continued" }];
    s = applyOutcomeAdjustments(s, outcomes, { now: T0 + 2 * H });
    const budget = s.budgetPerWeek;
    s = applyOutcomeAdjustments(s, outcomes, { now: T0 + 3 * H });
    assert.strictEqual(s.budgetPerWeek, budget);
  });

  it("höheres Budget erlaubt mehr Sends pro Woche", () => {
    let s = createGovernorState(T0);
    s.budgetPerWeek = 4;
    s = recordProactiveSend(s, "a", T0);
    s = recordProactiveSend(s, "b", T0 + 1);
    s = recordProactiveSend(s, "c", T0 + 2);
    assert.strictEqual(evaluateGovernor(s, T0 + 3).allowed, true);
    s = recordProactiveSend(s, "d", T0 + 3);
    assert.strictEqual(evaluateGovernor(s, T0 + 4).allowed, false);
  });

  it("fail-open bei kaputtem State/Outcomes", () => {
    assert.strictEqual(evaluateGovernor(null, T0).allowed, true);
    const s = applyOutcomeAdjustments(createGovernorState(T0), null, { now: T0 });
    assert.strictEqual(s.budgetPerWeek, 2);
  });
});
```

- [ ] **Step 2: Run** — FAIL erwartet.

- [ ] **Step 3: Implementierung** — `lib/proactive-governor.js`:

```js
/**
 * lib/proactive-governor.js — adaptiver Frequenzregler für proaktive
 * Lebenszeichen (Traum-Echos, Nachgedanken, …).
 *
 * Budget-Modell: Start 2 Sends/Woche über alle Governor-Features gemeinsam.
 * Reply-Outcomes innerhalb von 6h nach einem proaktiven Send gelten als
 * Reaktion darauf: positiv (+0.25, Cap 4), ignoriert (−0.25, Floor 1).
 * Träge Anpassung — ein schlechter Tag kippt nichts.
 *
 * Pure Kernfunktionen + fail-open Datei-Helpers (.proactive-governor.json).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WEEK_MS = 7 * 86400000;
const ATTRIBUTION_MS = 6 * 3600000;
const STEP = 0.25;
const MIN_BUDGET = 1;
const MAX_BUDGET = 4;
const START_BUDGET = 2;
const STATE_FILE = ".proactive-governor.json";

const POSITIVE = new Set(["confirmed_or_continued", "continued_topic"]);
const NEGATIVE = new Set(["ignored_or_topic_shifted"]);

export function createGovernorState(now = Date.now()) {
  return { schema: 1, budgetPerWeek: START_BUDGET, sends: [], adjustedAt: 0, createdAt: now };
}

function normalizeState(state) {
  const s = state && typeof state === "object" ? state : {};
  return {
    schema: 1,
    budgetPerWeek: Number.isFinite(s.budgetPerWeek) ? s.budgetPerWeek : START_BUDGET,
    sends: Array.isArray(s.sends) ? s.sends.filter((x) => Number.isFinite(x?.ts)) : [],
    adjustedAt: Number.isFinite(s.adjustedAt) ? s.adjustedAt : 0,
    createdAt: Number.isFinite(s.createdAt) ? s.createdAt : Date.now(),
  };
}

export function applyOutcomeAdjustments(state, outcomes, { now = Date.now() } = {}) {
  const s = normalizeState(state);
  if (!Array.isArray(outcomes) || outcomes.length === 0) return s;

  let budget = s.budgetPerWeek;
  let adjustedAt = s.adjustedAt;
  const sorted = outcomes
    .filter((o) => Number.isFinite(o?.timestamp) && o.timestamp <= now)
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const o of sorted) {
    if (o.timestamp <= adjustedAt) continue;
    adjustedAt = o.timestamp;
    const attributed = s.sends.some(
      (send) => o.timestamp > send.ts && o.timestamp - send.ts <= ATTRIBUTION_MS,
    );
    if (!attributed) continue;
    if (POSITIVE.has(o.outcome)) budget += STEP;
    else if (NEGATIVE.has(o.outcome)) budget -= STEP;
    budget = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, budget));
  }
  return { ...s, budgetPerWeek: budget, adjustedAt };
}

export function evaluateGovernor(state, now = Date.now()) {
  const s = normalizeState(state);
  const recentSends = s.sends.filter((x) => now - x.ts >= 0 && now - x.ts < WEEK_MS);
  const cap = Math.round(s.budgetPerWeek);
  if (recentSends.length < cap) {
    return { allowed: true, budgetPerWeek: s.budgetPerWeek, reason: "within_budget" };
  }
  return { allowed: false, budgetPerWeek: s.budgetPerWeek, reason: "budget_exhausted" };
}

export function recordProactiveSend(state, featureId, now = Date.now()) {
  const s = normalizeState(state);
  const sends = [...s.sends, { featureId: String(featureId || "unknown"), ts: now }]
    .filter((x) => now - x.ts < 2 * WEEK_MS);
  return { ...s, sends };
}

export function loadGovernorState(workspaceDir) {
  try {
    const path = join(workspaceDir, STATE_FILE);
    if (!existsSync(path)) return createGovernorState();
    return normalizeState(JSON.parse(readFileSync(path, "utf8")));
  } catch (_) {
    return createGovernorState();
  }
}

export function saveGovernorState(workspaceDir, state) {
  try {
    mkdirSync(workspaceDir, { recursive: true });
    const path = join(workspaceDir, STATE_FILE);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(normalizeState(state), null, 2), "utf8");
    renameSync(tmp, path);
    return true;
  } catch (_) {
    return false;
  }
}
```

- [ ] **Step 4: Run** — `node --test tests/proactive-governor.test.js` → PASS.

- [ ] **Step 5: DEPLOY_FILES** ergänzen, `npm test` → grün.

- [ ] **Step 6: Commit** — `git commit -am "feat: adaptive proactive governor (shared budget for life-sign features)"`

---

### Task 4: F1 Traum-Echos (`lib/dream-echo.js`)

**Files:**
- Create: `lib/dream-echo.js`
- Modify: `lib/dreaming/light-dream.js` (nach der Narrative-Generierung, ~Zeile 306–318; `lightDream` hat bereits `workspaceDir`, `llmCfg`, `callLlm`)
- Modify: `lib/dreaming/rem-dream.js` (analoge Stelle nach Narrative-Generierung, per Grep `generateDreamNarrative` finden; `runRemDream` hat `workspaceDir`, `llmCfg`, `callLlm`)
- Modify: `index.js` (Injektion nach dem open-threads-Block ~5674; `fullMemoriesContext`-Array ~5676)
- Modify: `scripts/lib/deploy-integrity.mjs` (+ `"lib/dream-echo.js"`)
- Test: `tests/dream-echo.test.js`

**Interfaces:**
- Consumes: Governor-API aus Task 3 (exakt wie dort definiert).
- Produces:
  - `distillDreamEcho({ narrative, insights }, { llmCfg = null, callLlm = null, now = Date.now() })` → `Promise<{ sentence, topics, createdAt } | null>` — LLM primär, deterministischer Fallback (erster Insight), null wenn nichts da.
  - `appendDreamEcho(workspaceDir, echo)` — appendet `.dream-echoes.jsonl`, behält max. 20 Zeilen.
  - `loadFreshDreamEcho(workspaceDir, { now, maxAgeDays = 2 })` → jüngstes frisches Echo oder null.
  - `formatDreamEchoContext(echo)` → deutscher Kontextblock ≤400 Zeichen oder null.

- [ ] **Step 1: Failing Tests** — `tests/dream-echo.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  distillDreamEcho, appendDreamEcho, loadFreshDreamEcho, formatDreamEchoContext,
} from "../lib/dream-echo.js";

const T0 = 1750000000000;
const D = 86400000;

describe("distillDreamEcho", () => {
  it("nutzt das LLM, wenn konfiguriert", async () => {
    const callLlm = async () => JSON.stringify({ sentence: "Mir ging nochmal das Serverthema durch den Kopf.", topics: ["server"] });
    const echo = await distillDreamEcho({ narrative: "…", insights: [] }, { llmCfg: { model: "x" }, callLlm, now: T0 });
    assert.strictEqual(echo.sentence, "Mir ging nochmal das Serverthema durch den Kopf.");
    assert.deepStrictEqual(echo.topics, ["server"]);
    assert.strictEqual(echo.createdAt, T0);
  });

  it("Fallback auf ersten Insight, wenn LLM fehlt oder wirft", async () => {
    const echo = await distillDreamEcho({ narrative: "irrelevant", insights: ["das Backup-Problem"] }, { now: T0 });
    assert.match(echo.sentence, /Backup-Problem/);
  });

  it("null ohne Narrative und Insights", async () => {
    assert.strictEqual(await distillDreamEcho({ narrative: null, insights: [] }, { now: T0 }), null);
  });

  it("kürzt Sätze auf 200 Zeichen", async () => {
    const callLlm = async () => JSON.stringify({ sentence: "x".repeat(500), topics: [] });
    const echo = await distillDreamEcho({ narrative: "…" }, { llmCfg: { model: "x" }, callLlm, now: T0 });
    assert.ok(echo.sentence.length <= 200);
  });
});

describe("dream-echo store + format", () => {
  it("append + load: liefert das jüngste frische Echo", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-"));
    appendDreamEcho(dir, { sentence: "alt", topics: [], createdAt: T0 - 5 * D });
    appendDreamEcho(dir, { sentence: "frisch", topics: ["a"], createdAt: T0 - 1000 });
    const echo = loadFreshDreamEcho(dir, { now: T0 });
    assert.strictEqual(echo.sentence, "frisch");
  });

  it("zu alte Echos werden ignoriert", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-"));
    appendDreamEcho(dir, { sentence: "alt", topics: [], createdAt: T0 - 3 * D });
    assert.strictEqual(loadFreshDreamEcho(dir, { now: T0, maxAgeDays: 2 }), null);
  });

  it("Store bleibt auf 20 Zeilen begrenzt", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-"));
    for (let i = 0; i < 30; i++) appendDreamEcho(dir, { sentence: `s${i}`, topics: [], createdAt: T0 + i });
    const lines = readFileSync(join(dir, ".dream-echoes.jsonl"), "utf8").split("\n").filter(Boolean);
    assert.strictEqual(lines.length, 20);
  });

  it("loadFreshDreamEcho fail-open bei kaputter Datei", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-"));
    writeFileSync(join(dir, ".dream-echoes.jsonl"), "{kaputt\n", "utf8");
    assert.strictEqual(loadFreshDreamEcho(dir, { now: T0 }), null);
  });

  it("formatDreamEchoContext: Block ≤400 Zeichen, enthält den Satz, null bei null", () => {
    const block = formatDreamEchoContext({ sentence: "Mir ging X durch den Kopf.", topics: [], createdAt: T0 });
    assert.ok(block.includes("Mir ging X durch den Kopf."));
    assert.ok(block.length <= 400);
    assert.match(block, /natürlich passt/);
    assert.strictEqual(formatDreamEchoContext(null), null);
  });
});
```

- [ ] **Step 2: Run** — FAIL erwartet.

- [ ] **Step 3: Implementierung** — `lib/dream-echo.js`:

```js
/**
 * lib/dream-echo.js — Traum-Echos: macht nächtliches Dreaming sichtbar.
 *
 * Der Dream-Job destilliert einen beiläufigen Ein-Satz-„Echo" aus dem
 * Traum-Narrative (.dream-echoes.jsonl). Beim ersten Kontakt des Tages
 * wird das Echo (Governor-gebremst) als Kontextblock injiziert — es
 * reitet auf der normalen Antwort mit, kein eigener Send.
 *
 * Fail-open: kein Echo/kein LLM → null, nie ein Fehler nach außen.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonl } from "./jsonl-utils.js";

const ECHO_FILE = ".dream-echoes.jsonl";
const MAX_ECHO_LINES = 20;
const MAX_SENTENCE_CHARS = 200;
const MAX_BLOCK_CHARS = 400;

export async function distillDreamEcho({ narrative = null, insights = [] } = {}, { llmCfg = null, callLlm = null, now = Date.now() } = {}) {
  try {
    const hasNarrative = typeof narrative === "string" && narrative.trim().length > 0;
    const firstInsight = Array.isArray(insights) ? insights.find((i) => typeof i === "string" && i.trim()) : null;
    if (!hasNarrative && !firstInsight) return null;

    if (hasNarrative && llmCfg && typeof callLlm === "function") {
      try {
        const raw = await callLlm([
          {
            role: "system",
            content:
              "Du destillierst aus einem Traumfragment eines KI-Agenten EINEN beiläufigen deutschen Satz aus der Ich-Perspektive, wie man morgens erwähnt, dass einem etwas durch den Kopf ging (z. B. \"Mir ist über Nacht nochmal … durch den Kopf gegangen.\"). Max. 200 Zeichen. Antworte NUR mit JSON: {\"sentence\": \"…\", \"topics\": [\"stichwort\"]}",
          },
          { role: "user", content: narrative.slice(0, 2000) },
        ], llmCfg);
        const parsed = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, ""));
        if (typeof parsed?.sentence === "string" && parsed.sentence.trim()) {
          return {
            sentence: parsed.sentence.trim().slice(0, MAX_SENTENCE_CHARS),
            topics: Array.isArray(parsed.topics) ? parsed.topics.filter((t) => typeof t === "string").slice(0, 3) : [],
            createdAt: now,
          };
        }
      } catch (_) { /* fällt auf Insight-Fallback zurück */ }
    }

    if (firstInsight) {
      const trimmed = firstInsight.trim().replace(/[.\s]+$/, "");
      return {
        sentence: `Mir ist über Nacht nochmal ${trimmed} durch den Kopf gegangen.`.slice(0, MAX_SENTENCE_CHARS),
        topics: [],
        createdAt: now,
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

export function appendDreamEcho(workspaceDir, echo) {
  try {
    if (!workspaceDir || !echo || typeof echo.sentence !== "string") return false;
    mkdirSync(workspaceDir, { recursive: true });
    const path = join(workspaceDir, ECHO_FILE);
    const existing = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
    const bounded = existing.concat(JSON.stringify(echo)).slice(-MAX_ECHO_LINES);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${bounded.join("\n")}\n`, "utf8");
    renameSync(tmp, path);
    return true;
  } catch (_) {
    return false;
  }
}

export function loadFreshDreamEcho(workspaceDir, { now = Date.now(), maxAgeDays = 2 } = {}) {
  try {
    const entries = readJsonl(join(workspaceDir, ECHO_FILE));
    const fresh = entries
      .filter((e) => typeof e?.sentence === "string" && Number.isFinite(e?.createdAt))
      .filter((e) => now - e.createdAt <= maxAgeDays * 86400000 && e.createdAt <= now);
    if (fresh.length === 0) return null;
    return fresh.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
  } catch (_) {
    return null;
  }
}

export function formatDreamEchoContext(echo) {
  try {
    if (!echo || typeof echo.sentence !== "string" || !echo.sentence.trim()) return null;
    const block = `Dir ist über Nacht etwas durch den Kopf gegangen: „${echo.sentence.trim()}" Falls es gerade natürlich passt, erwähne es beiläufig mit eigenen Worten — höchstens einmal. Wenn es nicht passt, lass es einfach weg.`;
    return block.length > MAX_BLOCK_CHARS ? block.slice(0, MAX_BLOCK_CHARS - 1).trimEnd() + "…" : block;
  } catch (_) {
    return null;
  }
}
```

- [ ] **Step 4: Dream-Job-Hooks** — in `lib/dreaming/light-dream.js` direkt nach dem Narrative-Block (nach ~Zeile 318, innerhalb der Funktion, `narrative` und `insights` sind im Scope):

```js
  // Traum-Echo destillieren (Humanization F1) — fail-open
  if (workspaceDir) {
    try {
      const { distillDreamEcho, appendDreamEcho } = await import("../dream-echo.js");
      const echo = await distillDreamEcho({ narrative, insights }, { llmCfg, callLlm });
      if (echo) appendDreamEcho(workspaceDir, echo);
    } catch (_) { /* fail-open */ }
  }
```

  Analog in `lib/dreaming/rem-dream.js` nach dessen Narrative-Generierung (Anker per `grep -n "generateDreamNarrative" lib/dreaming/rem-dream.js`; dort verfügbare Insight-Variable verwenden oder `insights: []`).

- [ ] **Step 5: index.js-Injektion** — nach dem open-threads-Block (nach Zeile ~5674) einfügen:

```js
          // Dream-Echo injection (Humanization F1): 1x/Tag, Governor-gebremst.
          let dreamEchoContext = null;
          if (ctx?.workspaceDir && (cfg.dreamEcho?.enabled ?? true) !== false) {
            try {
              const echoCooldownPath = join(resolve(ctx.workspaceDir), ".dream-echo-shown.json");
              let echoCooldownOk = true;
              try {
                const cd = JSON.parse(readFileSync(echoCooldownPath, "utf8"));
                if (cd?.date === new Date(nowMs).toISOString().slice(0, 10)) echoCooldownOk = false;
              } catch { /* fresh */ }
              if (echoCooldownOk) {
                const { loadFreshDreamEcho, formatDreamEchoContext } = await import("./lib/dream-echo.js");
                const { loadGovernorState, saveGovernorState, applyOutcomeAdjustments, evaluateGovernor, recordProactiveSend } = await import("./lib/proactive-governor.js");
                const echo = loadFreshDreamEcho(ctx.workspaceDir, { now: nowMs });
                if (echo) {
                  let gov = loadGovernorState(ctx.workspaceDir);
                  gov = applyOutcomeAdjustments(gov, readReplyOutcomeLog(ctx.workspaceDir, 100), { now: nowMs });
                  if (evaluateGovernor(gov, nowMs).allowed) {
                    dreamEchoContext = formatDreamEchoContext(echo);
                    if (dreamEchoContext) gov = recordProactiveSend(gov, "dream-echo", nowMs);
                  }
                  saveGovernorState(ctx.workspaceDir, gov);
                  try { writeFileSync(echoCooldownPath, JSON.stringify({ date: new Date(nowMs).toISOString().slice(0, 10) }), "utf8"); } catch { }
                }
              }
            } catch (_) { /* fail-open */ }
          }
```

  `readReplyOutcomeLog` ggf. zum bestehenden Import aus `./lib/reply-outcome-tracking.js` hinzufügen (Grep nach `recordPendingReplyOutcome`-Import). Dann `fullMemoriesContext` erweitern:

```js
          const fullMemoriesContext = [moodStyleDirective, dreamEchoContext, openThreadsContext, contradictionDisclosureContext, memoriesContext, reactivationContext].filter(Boolean).join("\n\n");
```

  **Cooldown-Semantik:** Die Cooldown-Datei wird nur gestempelt, wenn ein Echo existierte (unabhängig vom Governor-Ergebnis) — sonst darf am selben Tag später noch injiziert werden, wenn der nächtliche Job nachliefert.

- [ ] **Step 6: DEPLOY_FILES + volle Suite** — `npm test` → grün.

- [ ] **Step 7: Commit** — `git commit -am "feat: dream echoes (nightly dreaming surfaces in first daily contact)"`

---

### Task 5: F5 Persona-Voice Kern (`lib/persona-voice.js` + Command)

**Files:**
- Create: `lib/persona-voice.js`
- Modify: `index.js` (Injektion am Kontextbau-Anker; Command `/plur1bus persona`: actionKey-Handler bei ~2925 neben `temperament`, Command-Registrierung bei ~3307)
- Modify: `lib/dreaming/light-dream.js` (Auto-Seed-Versuch, neuer optionaler Param)
- Modify: `scripts/lib/deploy-integrity.mjs` (+ `"lib/persona-voice.js"`)
- Test: `tests/persona-voice.test.js`

**Interfaces:**
- Produces (Task 6 verlässt sich exakt hierauf):
  - Datei `persona-voice.md` im Workspace mit Managed-Block zwischen `<!-- persona:begin -->` und `<!-- persona:end -->`; Inhalt außerhalb der Marker gehört dem User und wird NIE angefasst.
  - `hasPersonaVoice(workspaceDir)` → boolean
  - `generatePersonaSeed({ agentId, lang = "de", identityText = "", llmCfg, callLlm })` → `Promise<string|null>` (5–8 Bullet-Marker als Markdown-Zeilen `- …`)
  - `writePersonaVoice(workspaceDir, seedMarkdown)` → boolean; legt Datei NUR an, wenn sie fehlt
  - `loadPersonaDirective(workspaceDir, { maxChars = 400 })` → string|null — kompakte Direktive aus dem Managed-Block, mtime-gecacht
  - `readPersonaFile(workspaceDir)` → `{ content, managedBlock }` | null
  - `appendMarkerToManagedBlock(workspaceDir, markerLine)` → boolean (für Task 6 accept)

- [ ] **Step 1: Failing Tests** — `tests/persona-voice.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasPersonaVoice, generatePersonaSeed, writePersonaVoice,
  loadPersonaDirective, readPersonaFile, appendMarkerToManagedBlock,
} from "../lib/persona-voice.js";

const SEED = "- Kurze, direkte Sätze.\n- Lieblingswendung: „passt schon".\n- Emojis sparsam: 🙂 gelegentlich.";

describe("persona-voice", () => {
  it("generatePersonaSeed: nutzt LLM und liefert Bullet-Zeilen", async () => {
    const callLlm = async () => SEED;
    const seed = await generatePersonaSeed({ agentId: "anna", llmCfg: { model: "x" }, callLlm });
    assert.ok(seed.split("\n").every((l) => l.startsWith("- ")));
  });

  it("generatePersonaSeed: null ohne LLM oder bei Fehler", async () => {
    assert.strictEqual(await generatePersonaSeed({ agentId: "anna" }), null);
    const callLlm = async () => { throw new Error("boom"); };
    assert.strictEqual(await generatePersonaSeed({ agentId: "anna", llmCfg: { model: "x" }, callLlm }), null);
  });

  it("writePersonaVoice legt Datei mit Managed-Block an, aber nie doppelt", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    assert.strictEqual(hasPersonaVoice(dir), false);
    assert.strictEqual(writePersonaVoice(dir, SEED), true);
    assert.strictEqual(hasPersonaVoice(dir), true);
    const content = readFileSync(join(dir, "persona-voice.md"), "utf8");
    assert.ok(content.includes("<!-- persona:begin -->"));
    assert.ok(content.includes("passt schon"));
    assert.strictEqual(writePersonaVoice(dir, "- anders"), false); // existiert schon → no-op
  });

  it("loadPersonaDirective: kompakt, ≤400 Zeichen, nur Managed-Block", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writePersonaVoice(dir, SEED);
    // User-Text außerhalb der Marker darf nicht in die Direktive
    const path = join(dir, "persona-voice.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\n\nPrivate User-Notiz GEHEIM", "utf8");
    const directive = loadPersonaDirective(dir);
    assert.ok(directive.includes("passt schon"));
    assert.ok(!directive.includes("GEHEIM"));
    assert.ok(directive.length <= 400);
    assert.match(directive, /Grundstimme/);
  });

  it("loadPersonaDirective: null ohne Datei, fail-open bei kaputtem Inhalt", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    assert.strictEqual(loadPersonaDirective(dir), null);
    writeFileSync(join(dir, "persona-voice.md"), "kein marker", "utf8");
    assert.strictEqual(loadPersonaDirective(dir), null);
  });

  it("appendMarkerToManagedBlock hängt im Block an, User-Text bleibt", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writePersonaVoice(dir, SEED);
    const path = join(dir, "persona-voice.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\nUser-Notiz", "utf8");
    assert.strictEqual(appendMarkerToManagedBlock(dir, "- Neue Marotte."), true);
    const { managedBlock, content } = readPersonaFile(dir);
    assert.ok(managedBlock.includes("Neue Marotte"));
    assert.ok(content.includes("User-Notiz"));
  });
});
```

- [ ] **Step 2: Run** — FAIL erwartet.

- [ ] **Step 3: Implementierung** — `lib/persona-voice.js`:

```js
/**
 * lib/persona-voice.js — Idiolekt pro Agent: Seed + Datei + Direktive.
 *
 * persona-voice.md im Workspace: Managed-Block zwischen Markern gehört dem
 * Plugin (Seed, akzeptierte Evolutions-Marker); alles außerhalb gehört dem
 * User und wird nie angefasst. Die Direktive wird NUR aus dem Managed-Block
 * gebaut (User-Notizen landen nicht im Prompt).
 *
 * Fail-open: keine Datei / kein LLM → null, Feature inert.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PERSONA_FILE = "persona-voice.md";
export const MARKER_BEGIN = "<!-- persona:begin -->";
export const MARKER_END = "<!-- persona:end -->";
const MAX_DIRECTIVE_CHARS = 400;

const directiveCache = new Map(); // path → { mtimeMs, directive }

function personaPath(workspaceDir) {
  return join(workspaceDir, PERSONA_FILE);
}

export function hasPersonaVoice(workspaceDir) {
  try { return existsSync(personaPath(workspaceDir)); } catch (_) { return false; }
}

export async function generatePersonaSeed({ agentId = "agent", lang = "de", identityText = "", llmCfg = null, callLlm = null } = {}) {
  try {
    if (!llmCfg || typeof callLlm !== "function") return null;
    const raw = await callLlm([
      {
        role: "system",
        content:
          `Du entwirfst die Grundstimme eines Chat-Agenten namens "${agentId}" (Sprache: ${lang}). ` +
          "Antworte NUR mit 5-8 Markdown-Bullet-Zeilen (jede beginnt mit \"- \"): Satzlängen-Neigung, 2-3 Lieblingswendungen, Emoji-Palette und -Frequenz, Anrede-Stil, genau eine harmlose Marotte. " +
          "Keine Rollenprosa, keine Überschriften, kein Text außerhalb der Bullets.",
      },
      { role: "user", content: identityText ? `Identitäts-Hinweise:\n${identityText.slice(0, 2000)}` : "Keine weiteren Hinweise — entwirf eine natürliche, unaufdringliche Stimme." },
    ], llmCfg);
    const lines = String(raw).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
    if (lines.length < 3) return null;
    return lines.slice(0, 8).join("\n");
  } catch (_) {
    return null;
  }
}

export function writePersonaVoice(workspaceDir, seedMarkdown) {
  try {
    if (!workspaceDir || typeof seedMarkdown !== "string" || !seedMarkdown.trim()) return false;
    const path = personaPath(workspaceDir);
    if (existsSync(path)) return false;
    mkdirSync(workspaceDir, { recursive: true });
    const content = [
      "# Persona-Voice",
      "",
      "Dieses Profil färbt die Grundstimme des Agenten. Der Block zwischen den",
      "Markern wird vom Plugin verwaltet; alles außerhalb gehört dir.",
      "",
      MARKER_BEGIN,
      seedMarkdown.trim(),
      MARKER_END,
      "",
    ].join("\n");
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
    return true;
  } catch (_) {
    return false;
  }
}

export function readPersonaFile(workspaceDir) {
  try {
    const path = personaPath(workspaceDir);
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf8");
    const begin = content.indexOf(MARKER_BEGIN);
    const end = content.indexOf(MARKER_END);
    if (begin === -1 || end === -1 || end <= begin) return { content, managedBlock: null };
    const managedBlock = content.slice(begin + MARKER_BEGIN.length, end).trim();
    return { content, managedBlock };
  } catch (_) {
    return null;
  }
}

export function loadPersonaDirective(workspaceDir, { maxChars = MAX_DIRECTIVE_CHARS } = {}) {
  try {
    const path = personaPath(workspaceDir);
    if (!existsSync(path)) return null;
    const mtimeMs = statSync(path).mtimeMs;
    const cached = directiveCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) return cached.directive;

    const parsed = readPersonaFile(workspaceDir);
    if (!parsed?.managedBlock) {
      directiveCache.set(path, { mtimeMs, directive: null });
      return null;
    }
    const markers = parsed.managedBlock
      .split("\n").map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim().replace(/[.;\s]+$/, ""));
    if (markers.length === 0) {
      directiveCache.set(path, { mtimeMs, directive: null });
      return null;
    }
    let directive = `Deine Grundstimme (befolge sie, ohne sie zu benennen): ${markers.join("; ")}.`;
    if (directive.length > maxChars) directive = directive.slice(0, maxChars - 1).trimEnd() + "…";
    directiveCache.set(path, { mtimeMs, directive });
    return directive;
  } catch (_) {
    return null;
  }
}

export function appendMarkerToManagedBlock(workspaceDir, markerLine) {
  try {
    if (typeof markerLine !== "string" || !markerLine.trim().startsWith("- ")) return false;
    const path = personaPath(workspaceDir);
    const parsed = readPersonaFile(workspaceDir);
    if (!parsed || parsed.managedBlock == null) return false;
    const endIdx = parsed.content.indexOf(MARKER_END);
    const updated = `${parsed.content.slice(0, endIdx).trimEnd()}\n${markerLine.trim()}\n${parsed.content.slice(endIdx)}`;
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, updated, "utf8");
    renameSync(tmp, path);
    return true;
  } catch (_) {
    return false;
  }
}
```

- [ ] **Step 4: index.js-Injektion** — am Kontextbau-Anker (direkt vor `const moodStyleDirective`, ~5646):

```js
          let personaDirective = null;
          if (ctx?.workspaceDir && (cfg.personaVoice?.enabled ?? true) !== false) {
            try {
              const { loadPersonaDirective } = await import("./lib/persona-voice.js");
              personaDirective = loadPersonaDirective(ctx.workspaceDir);
            } catch (_) { /* fail-open */ }
          }
```

  `fullMemoriesContext`: `personaDirective` als ERSTES Element vor `moodStyleDirective` einfügen (Persona = Grundstimme, Mood = Tagesform obendrauf).

- [ ] **Step 5: Auto-Seed im Light-Dream** — `lightDream({ … })` bekommt neuen optionalen Param `personaSeedCfg = null` (`{ agentId, lang }`). Am Funktionsende (vor dem return, `workspaceDir/llmCfg/callLlm` im Scope):

```js
  // Persona-Voice Auto-Seed (Humanization F5) — nur wenn Datei fehlt, fail-open
  if (workspaceDir && personaSeedCfg) {
    try {
      const { hasPersonaVoice, generatePersonaSeed, writePersonaVoice } = await import("../persona-voice.js");
      if (!hasPersonaVoice(workspaceDir)) {
        const seed = await generatePersonaSeed({ ...personaSeedCfg, llmCfg, callLlm });
        if (seed) writePersonaVoice(workspaceDir, seed);
      }
    } catch (_) { /* fail-open */ }
  }
```

  Am Call-Site `index.js:4220` `personaSeedCfg` mitgeben: `personaSeedCfg: (cfg.personaVoice?.enabled ?? true) !== false ? { agentId, lang: cfg.language || "de" } : null` (verfügbare agentId-Variable am Call-Site per Umgebung prüfen; Identity-Text optional: erste existierende Datei aus `SOUL.md`/`IDENTITY.md`/`AGENT.md` im Workspace lesen und als `identityText` mitgeben — max 2000 Zeichen, fail-open).

- [ ] **Step 6: `/plur1bus persona` Command** — im actionKey-Dispatch (~2925, neben `temperament`):
  - `persona` ohne Args: Datei-Status + Managed-Block anzeigen (oder Hinweis „noch kein Profil — `/plur1bus persona regenerate`").
  - `persona regenerate`: Seed via `generatePersonaSeed` (llmCfg wie skill-miner/merging-Konfig am Command-Anker verfügbar) und `writePersonaVoice`; wenn Datei existiert → Hinweis, dass sie zuerst manuell gelöscht werden muss (bewusst konservativ, kein Überschreiben).
  - Command-Registrierung bei ~3307 ergänzen: `{ name: "plur1bus_persona", description: "Show or (re)generate the agent's persona voice profile.", acceptsArgs: true, prefixTokens: ["persona"] }`.

- [ ] **Step 7: DEPLOY_FILES + volle Suite** — `npm test` → grün.

- [ ] **Step 8: Commit** — `git commit -am "feat: persona voice (seeded idiolect per agent, managed block, /plur1bus persona)"`

---

### Task 6: F5b Persona-Evolution (interner Job `persona-evolve` + accept)

**Files:**
- Modify: `lib/persona-voice.js` (Evolution + accept)
- Modify: `index.js` (interner Job `persona-evolve` im internal-Dispatch ~2665–2900 neben `skill-miner`; `persona accept`-Zweig im Command; `valid`-Liste bei ~2900 ergänzen)
- Test: `tests/persona-voice.test.js` (erweitern)

**Interfaces:**
- Consumes: `readPersonaFile`, `appendMarkerToManagedBlock`, Marker-Konstanten aus Task 5; `readReplyOutcomeLog` aus `lib/reply-outcome-tracking.js`.
- Produces:
  - `proposePersonaEvolution({ workspaceDir, outcomes, llmCfg, callLlm, now })` → `Promise<{ proposed: boolean, reason?: string, marker?: string }>` — schreibt Vorschlag als Sektion `## Vorschlag (nicht aktiv)` UNTER dem Managed-Block (ersetzt eine bestehende Vorschlag-Sektion).
  - `acceptPersonaProposal(workspaceDir)` → `{ accepted: boolean, marker?: string }` — verschiebt die Vorschlag-Zeile in den Managed-Block, entfernt die Sektion.

- [ ] **Step 1: Failing Tests** — an `tests/persona-voice.test.js` anhängen:

```js
import { proposePersonaEvolution, acceptPersonaProposal } from "../lib/persona-voice.js";

const T1 = 1750000000000;
function outcome(ts, kind) { return { timestamp: ts, outcome: kind }; }

describe("persona evolution", () => {
  function seededDir() {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writePersonaVoice(dir, SEED);
    return dir;
  }

  it("schlägt bei positivem Trend genau EINEN Marker vor", async () => {
    const dir = seededDir();
    const outcomes = Array.from({ length: 12 }, (_, i) => outcome(T1 - i * 1000, "confirmed_or_continued"));
    const callLlm = async () => "- Neue Wendung: „alles klar soweit\".";
    const res = await proposePersonaEvolution({ workspaceDir: dir, outcomes, llmCfg: { model: "x" }, callLlm, now: T1 });
    assert.strictEqual(res.proposed, true);
    const content = readFileSync(join(dir, "persona-voice.md"), "utf8");
    assert.ok(content.includes("## Vorschlag (nicht aktiv)"));
    assert.ok(content.includes("alles klar soweit"));
  });

  it("kein Vorschlag bei zu wenigen oder negativen Outcomes", async () => {
    const dir = seededDir();
    const few = [outcome(T1, "confirmed_or_continued")];
    assert.strictEqual((await proposePersonaEvolution({ workspaceDir: dir, outcomes: few, llmCfg: { model: "x" }, callLlm: async () => "- x", now: T1 })).proposed, false);
    const negative = Array.from({ length: 12 }, (_, i) => outcome(T1 - i * 1000, "ignored_or_topic_shifted"));
    assert.strictEqual((await proposePersonaEvolution({ workspaceDir: dir, outcomes: negative, llmCfg: { model: "x" }, callLlm: async () => "- x", now: T1 })).proposed, false);
  });

  it("Vorschlag landet NICHT in der Direktive, accept übernimmt ihn", async () => {
    const dir = seededDir();
    const outcomes = Array.from({ length: 12 }, (_, i) => outcome(T1 - i * 1000, "confirmed_or_continued"));
    await proposePersonaEvolution({ workspaceDir: dir, outcomes, llmCfg: { model: "x" }, callLlm: async () => "- Marotte: zählt gern auf.", now: T1 });
    assert.ok(!loadPersonaDirective(dir).includes("zählt gern auf"));
    const res = acceptPersonaProposal(dir);
    assert.strictEqual(res.accepted, true);
    assert.ok(loadPersonaDirective(dir).includes("zählt gern auf"));
    assert.ok(!readFileSync(join(dir, "persona-voice.md"), "utf8").includes("## Vorschlag (nicht aktiv)"));
  });

  it("accept ohne Vorschlag → accepted false", () => {
    const dir = seededDir();
    assert.strictEqual(acceptPersonaProposal(dir).accepted, false);
  });
});
```

- [ ] **Step 2: Run** — FAIL erwartet.

- [ ] **Step 3: Implementierung** — an `lib/persona-voice.js` anhängen:

```js
export const PROPOSAL_HEADER = "## Vorschlag (nicht aktiv)";
const EVOLUTION_MIN_OUTCOMES = 10;
const EVOLUTION_WINDOW_MS = 7 * 86400000;
const EVOLUTION_MIN_POSITIVE_RATE = 0.5;
const EVO_POSITIVE = new Set(["confirmed_or_continued", "continued_topic", "acknowledged"]);
const EVO_NEGATIVE = new Set(["ignored_or_topic_shifted", "rejected", "corrected"]);

function replaceProposalSection(content, sectionText) {
  const idx = content.indexOf(PROPOSAL_HEADER);
  const base = idx === -1 ? content.trimEnd() : content.slice(0, idx).trimEnd();
  return sectionText ? `${base}\n\n${sectionText}\n` : `${base}\n`;
}

export async function proposePersonaEvolution({ workspaceDir, outcomes = [], llmCfg = null, callLlm = null, now = Date.now() } = {}) {
  try {
    const parsed = readPersonaFile(workspaceDir);
    if (!parsed || parsed.managedBlock == null) return { proposed: false, reason: "no_persona_file" };
    if (!llmCfg || typeof callLlm !== "function") return { proposed: false, reason: "no_llm" };

    const recent = (Array.isArray(outcomes) ? outcomes : []).filter(
      (o) => Number.isFinite(o?.timestamp) && now - o.timestamp <= EVOLUTION_WINDOW_MS,
    );
    if (recent.length < EVOLUTION_MIN_OUTCOMES) return { proposed: false, reason: "too_few_outcomes" };
    const positive = recent.filter((o) => EVO_POSITIVE.has(o.outcome)).length;
    const negative = recent.filter((o) => EVO_NEGATIVE.has(o.outcome)).length;
    if (positive + negative === 0 || positive / (positive + negative) <= EVOLUTION_MIN_POSITIVE_RATE) {
      return { proposed: false, reason: "no_positive_trend" };
    }

    const raw = await callLlm([
      {
        role: "system",
        content:
          "Hier ist das aktuelle Stimm-Profil eines Chat-Agenten. Schlage GENAU EINE kleine Änderung vor: einen neuen Marker, der die Stimme leicht schärft (Wendung, Marotte, Emoji-Nuance). Antworte NUR mit einer einzigen Markdown-Bullet-Zeile, beginnend mit \"- \".",
      },
      { role: "user", content: parsed.managedBlock.slice(0, 2000) },
    ], llmCfg);
    const marker = String(raw).split("\n").map((l) => l.trim()).find((l) => l.startsWith("- "));
    if (!marker) return { proposed: false, reason: "llm_no_marker" };

    const path = join(workspaceDir, PERSONA_FILE);
    const section = `${PROPOSAL_HEADER}\n\nÜbernehmen mit /plur1bus persona accept — oder diese Sektion einfach löschen.\n\n${marker}`;
    const updated = replaceProposalSection(parsed.content, section);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, updated, "utf8");
    renameSync(tmp, path);
    return { proposed: true, marker };
  } catch (_) {
    return { proposed: false, reason: "error" };
  }
}

export function acceptPersonaProposal(workspaceDir) {
  try {
    const parsed = readPersonaFile(workspaceDir);
    if (!parsed || parsed.managedBlock == null) return { accepted: false };
    const idx = parsed.content.indexOf(PROPOSAL_HEADER);
    if (idx === -1) return { accepted: false };
    const section = parsed.content.slice(idx);
    const marker = section.split("\n").map((l) => l.trim()).find((l) => l.startsWith("- "));
    if (!marker) return { accepted: false };
    if (!appendMarkerToManagedBlock(workspaceDir, marker)) return { accepted: false };
    const after = readPersonaFile(workspaceDir);
    const path = join(workspaceDir, PERSONA_FILE);
    const cleaned = replaceProposalSection(after.content, null);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, cleaned, "utf8");
    renameSync(tmp, path);
    return { accepted: true, marker };
  } catch (_) {
    return { accepted: false };
  }
}
```

  **Hinweis:** `loadPersonaDirective` liest nur den Managed-Block — die Vorschlag-Sektion liegt UNTER `MARKER_END` und landet damit automatisch nicht im Prompt (Test sichert das ab).

- [ ] **Step 4: index.js** — (a) interner Job im internal-Dispatch (neben `skill-miner`):

```js
              if (subKey === "persona-evolve") {
                if ((cfg.personaVoice?.enabled ?? true) === false || !skillMinerLlmCfg) {
                  return formatJsonCommandResult({ job: "persona-evolve", skipped: true, reason: "not_configured" });
                }
                const { proposePersonaEvolution } = await import("./lib/persona-voice.js");
                const outcomes = readReplyOutcomeLog(commandCtx.workspaceDir, 200);
                const result = await proposePersonaEvolution({
                  workspaceDir: commandCtx.workspaceDir,
                  outcomes,
                  llmCfg: skillMinerLlmCfg,
                  callLlm,
                });
                api.logger?.info?.(`plur1bus internal persona-evolve[${internalAgent}]: ${JSON.stringify(result)}`);
                return formatJsonCommandResult({ job: "persona-evolve", ...result });
              }
```

  (b) `persona accept`-Zweig im persona-Command aus Task 5 ergänzen (`acceptPersonaProposal` aufrufen, Ergebnis melden). (c) `"persona-evolve"` in die `valid`-Liste der internal-Jobs (~2900) aufnehmen.

- [ ] **Step 5: Volle Suite + Commit** — `npm test` → grün; `git commit -am "feat: persona voice evolution (weekly proposal, explicit accept)"`

---

### Task 7: F2 Nachgedanken (`lib/afterthought.js` + interner Job)

**Files:**
- Create: `lib/afterthought.js`
- Modify: `index.js` (interner Job `afterthought` im internal-Dispatch; `valid`-Liste; open-threads-Cooldown-Write ~5669 um `topics` erweitern)
- Modify: `scripts/lib/deploy-integrity.mjs` (+ `"lib/afterthought.js"`)
- Test: `tests/afterthought.test.js`

**Interfaces:**
- Consumes: Governor-API (Task 3), `readReplyOutcomeLog` (newest-first), open-threads-Cooldown-Datei `.open-threads-shown.json` (nach diesem Task: `{ date, topics: [] }`).
- Produces:
  - `findAfterthoughtCandidate(outcomes, { now, minAgeMin = 30, maxAgeMin = 120 })` → `{ topic, timestamp, userPrompt } | null` — pure; jüngster Outcome-Eintrag, Alter im Fenster, `outcome` ∈ {asked_details, ignored_or_topic_shifted}.
  - `composeAfterthought(candidate, { llmCfg, callLlm })` → `Promise<string|null>` — 2–3 Sätze, beginnt gedanklich mit „Mir ist zu … noch eingefallen".
  - `runAfterthoughtJob({ workspaceDir, agentId, llmCfg, callLlm, now, hour, quietHours, logger })` → `Promise<{ text: string, topic: string } | { skipped: true, reason: string }>` — Orchestrierung inkl. Ruhezeiten (default 22–8, wrap-aware, `hour` injizierbar für TZ-stabile Tests), Governor, Tages-Cap (`.afterthought-state.json`), Doppel-Ansprache-Sperre.

- [ ] **Step 1: Failing Tests** — `tests/afterthought.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAfterthoughtCandidate, composeAfterthought, runAfterthoughtJob } from "../lib/afterthought.js";

const M = 60000;
const T0 = 1750000000000;
function o(agoMin, outcome, userPrompt = "wie richte ich das Backup ein?") {
  return { timestamp: T0 - agoMin * M, outcome, userPrompt };
}

describe("findAfterthoughtCandidate", () => {
  it("findet offenen jüngsten Eintrag im 30–120min-Fenster", () => {
    const c = findAfterthoughtCandidate([o(45, "asked_details")], { now: T0 });
    assert.ok(c);
    assert.match(c.topic, /Backup/);
  });

  it("null wenn zu frisch, zu alt oder Outcome geschlossen", () => {
    assert.strictEqual(findAfterthoughtCandidate([o(10, "asked_details")], { now: T0 }), null);
    assert.strictEqual(findAfterthoughtCandidate([o(300, "asked_details")], { now: T0 }), null);
    assert.strictEqual(findAfterthoughtCandidate([o(45, "confirmed_or_continued")], { now: T0 }), null);
  });

  it("nur der JÜNGSTE Eintrag zählt (Gespräch ging danach weiter → kein Nachgedanke)", () => {
    const entries = [o(20, "confirmed_or_continued"), o(45, "asked_details")]; // newest-first wie readReplyOutcomeLog
    assert.strictEqual(findAfterthoughtCandidate(entries, { now: T0 }), null);
  });

  it("fail-open bei leerem/kaputtem Input", () => {
    assert.strictEqual(findAfterthoughtCandidate([], { now: T0 }), null);
    assert.strictEqual(findAfterthoughtCandidate(null, { now: T0 }), null);
  });
});

describe("composeAfterthought", () => {
  it("liefert LLM-Text, null ohne LLM", async () => {
    const text = await composeAfterthought({ topic: "Backup", userPrompt: "…" }, { llmCfg: { model: "x" }, callLlm: async () => "Mir ist zum Backup noch eingefallen: rsync reicht." });
    assert.match(text, /Backup/);
    assert.strictEqual(await composeAfterthought({ topic: "x" }, {}), null);
  });
});

describe("runAfterthoughtJob", () => {
  function seedDir(entries) {
    const dir = mkdtempSync(join(tmpdir(), "at-"));
    mkdirSync(join(dir, ".adaptive-learning"), { recursive: true });
    if (entries.length) {
      writeFileSync(join(dir, ".adaptive-learning", "reply-outcomes.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    }
    return dir;
  }
  const llm = { llmCfg: { model: "x" }, callLlm: async () => "Mir ist zum Backup noch was eingefallen: probier rsync." };

  it("sendet bei offenem Kandidaten und stempelt Tages-Cap", async () => {
    const dir = seedDir([o(45, "asked_details")]);
    const first = await runAfterthoughtJob({ workspaceDir: dir, agentId: "a", ...llm, now: T0, hour: 12 });
    assert.ok(first.text);
    const second = await runAfterthoughtJob({ workspaceDir: dir, agentId: "a", ...llm, now: T0 + M, hour: 12 });
    assert.strictEqual(second.skipped, true);
    assert.strictEqual(second.reason, "daily_cap");
  });

  it("Ruhezeiten blocken (22:00–08:00), wrap-aware", async () => {
    const night = await runAfterthoughtJob({ workspaceDir: seedDir([o(45, "asked_details")]), agentId: "a", ...llm, now: T0, hour: 23 });
    assert.strictEqual(night.reason, "quiet_hours");
    const earlyMorning = await runAfterthoughtJob({ workspaceDir: seedDir([o(45, "asked_details")]), agentId: "a", ...llm, now: T0, hour: 7 });
    assert.strictEqual(earlyMorning.reason, "quiet_hours");
  });

  it("überspringt Thema, das heute schon als offener Faden lief", async () => {
    const dir = seedDir([o(45, "asked_details")]);
    writeFileSync(join(dir, ".open-threads-shown.json"), JSON.stringify({ date: new Date(T0).toISOString().slice(0, 10), topics: ["wie richte ich das Backup ein?"] }), "utf8");
    const res = await runAfterthoughtJob({ workspaceDir: dir, agentId: "a", ...llm, now: T0, hour: 12 });
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, "open_thread_overlap");
  });

  it("skipped ohne Kandidaten", async () => {
    const dir = seedDir([]);
    const res = await runAfterthoughtJob({ workspaceDir: dir, agentId: "a", ...llm, now: T0, hour: 12 });
    assert.strictEqual(res.skipped, true);
  });
});
```

  (`mkdirSync` zum fs-Import der Testdatei hinzufügen.)

- [ ] **Step 2: Run** — FAIL erwartet.

- [ ] **Step 3: Implementierung** — `lib/afterthought.js`:

```js
/**
 * lib/afterthought.js — Nachgedanken: seltene, verzögerte Follow-ups.
 *
 * Trigger: das letzte Gespräch endete vor 30–120 Minuten mit einem offenen
 * Outcome. Harte Grenzen zusätzlich zum Governor: max. 1/Tag, nie zu einem
 * Thema, das heute schon als offener Faden injiziert wurde.
 *
 * Der interne Job liefert nur JSON ({text} oder {skipped}); die Zustellung
 * übernimmt ein Cron-Agent (siehe README-Abschnitt aus Step 5).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readReplyOutcomeLog } from "./reply-outcome-tracking.js";
import {
  loadGovernorState, saveGovernorState, applyOutcomeAdjustments, evaluateGovernor, recordProactiveSend,
} from "./proactive-governor.js";

const OPEN_OUTCOMES = new Set(["asked_details", "ignored_or_topic_shifted"]);
const STATE_FILE = ".afterthought-state.json";
const OPEN_THREADS_SHOWN_FILE = ".open-threads-shown.json";
const MAX_TEXT_CHARS = 600;

function normalizeTopic(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
}

export function findAfterthoughtCandidate(outcomes, { now = Date.now(), minAgeMin = 30, maxAgeMin = 120 } = {}) {
  try {
    if (!Array.isArray(outcomes) || outcomes.length === 0) return null;
    const valid = outcomes.filter((o) => Number.isFinite(o?.timestamp));
    if (valid.length === 0) return null;
    const newest = valid.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b));
    const ageMin = (now - newest.timestamp) / 60000;
    if (ageMin < minAgeMin || ageMin > maxAgeMin) return null;
    if (!OPEN_OUTCOMES.has(newest.outcome)) return null;
    const userPrompt = typeof newest.userPrompt === "string" ? newest.userPrompt : "";
    if (!userPrompt.trim()) return null;
    return {
      topic: userPrompt.replace(/[\r\n]+/g, " ").trim().slice(0, 120),
      userPrompt,
      timestamp: newest.timestamp,
    };
  } catch (_) {
    return null;
  }
}

export async function composeAfterthought(candidate, { llmCfg = null, callLlm = null } = {}) {
  try {
    if (!candidate?.topic || !llmCfg || typeof callLlm !== "function") return null;
    const raw = await callLlm([
      {
        role: "system",
        content:
          "Du bist ein Chat-Agent, dem nach einem Gespräch noch etwas eingefallen ist. Schreibe eine kurze deutsche Follow-up-Nachricht (2-3 Sätze), die beiläufig an das Thema anknüpft — sinngemäß \"Mir ist zu … noch eingefallen: …\". Kein Gruß, keine Signatur, keine Emojis-Pflicht. Antworte NUR mit der Nachricht.",
      },
      { role: "user", content: `Letzte Nutzer-Nachricht des Gesprächs:\n${candidate.userPrompt.slice(0, 1000)}` },
    ], llmCfg);
    const text = String(raw || "").trim();
    if (!text) return null;
    return text.slice(0, MAX_TEXT_CHARS);
  } catch (_) {
    return null;
  }
}

function readJsonSafe(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (_) { return fallback; }
}

function writeJsonAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), "utf8");
  renameSync(tmp, path);
}

export async function runAfterthoughtJob({ workspaceDir, agentId = "default", llmCfg = null, callLlm = null, now = Date.now(), hour = new Date(now).getHours(), quietHours = { start: 22, end: 8 }, logger = { info: () => {}, warn: () => {} } } = {}) {
  try {
    if (!workspaceDir) return { skipped: true, reason: "missing_workspace" };

    // Ruhezeiten, wrap-aware (22–8 überspannt Mitternacht; 8–22 nicht).
    if (quietHours && Number.isInteger(quietHours.start) && Number.isInteger(quietHours.end)) {
      const inQuiet = quietHours.start > quietHours.end
        ? (hour >= quietHours.start || hour < quietHours.end)
        : (hour >= quietHours.start && hour < quietHours.end);
      if (inQuiet) return { skipped: true, reason: "quiet_hours" };
    }

    const today = new Date(now).toISOString().slice(0, 10);

    const statePath = join(workspaceDir, STATE_FILE);
    const state = readJsonSafe(statePath, {});
    if (state.lastSentDate === today) return { skipped: true, reason: "daily_cap" };

    const outcomes = readReplyOutcomeLog(workspaceDir, 50);
    const candidate = findAfterthoughtCandidate(outcomes, { now });
    if (!candidate) return { skipped: true, reason: "no_candidate" };

    const shown = readJsonSafe(join(workspaceDir, OPEN_THREADS_SHOWN_FILE), {});
    if (shown.date === today && Array.isArray(shown.topics)
      && shown.topics.some((t) => normalizeTopic(t) === normalizeTopic(candidate.topic))) {
      return { skipped: true, reason: "open_thread_overlap" };
    }

    let gov = loadGovernorState(workspaceDir);
    gov = applyOutcomeAdjustments(gov, outcomes, { now });
    if (!evaluateGovernor(gov, now).allowed) {
      saveGovernorState(workspaceDir, gov);
      return { skipped: true, reason: "governor_budget" };
    }

    const text = await composeAfterthought(candidate, { llmCfg, callLlm });
    if (!text) {
      saveGovernorState(workspaceDir, gov);
      return { skipped: true, reason: "no_llm_text" };
    }

    gov = recordProactiveSend(gov, "afterthought", now);
    saveGovernorState(workspaceDir, gov);
    mkdirSync(workspaceDir, { recursive: true });
    writeJsonAtomic(statePath, { lastSentDate: today, lastTopic: candidate.topic });
    logger.info?.(`afterthought[${agentId}]: composed follow-up for "${candidate.topic.slice(0, 40)}"`);
    return { text, topic: candidate.topic };
  } catch (err) {
    logger.warn?.(`afterthought[${agentId}]: ${String(err)}`);
    return { skipped: true, reason: "error" };
  }
}
```

- [ ] **Step 4: index.js** — (a) open-threads-Cooldown-Write (~5669) erweitern, damit die Doppel-Ansprache-Sperre Themen kennt:

```js
                try { writeFileSync(cooldownPath, JSON.stringify({ date: todayUtc, topics: (threads || []).map((t) => t.topic).filter(Boolean) }), "utf8"); } catch { /* non-blocking */ }
```

  **Achtung Reihenfolge:** Dazu muss `collectOpenThreads` VOR dem `writeFileSync` laufen (aktuell steht das Write vor `collectOpenThreads` — die beiden Zeilen tauschen; das unbedingte Stempeln pro Tag bleibt erhalten).
  (b) interner Job im internal-Dispatch (neben `skill-miner`):

```js
              if (subKey === "afterthought") {
                if ((cfg.afterthought?.enabled ?? true) === false) {
                  return formatJsonCommandResult({ job: "afterthought", skipped: true, reason: "disabled" });
                }
                const { runAfterthoughtJob } = await import("./lib/afterthought.js");
                const result = await runAfterthoughtJob({
                  workspaceDir: commandCtx.workspaceDir,
                  agentId: internalAgent,
                  llmCfg: skillMinerLlmCfg || mergingLlmCfg || null,
                  callLlm,
                  logger: api.logger,
                });
                api.logger?.info?.(`plur1bus internal afterthought[${internalAgent}]: ${JSON.stringify({ ...result, text: result.text ? `${result.text.slice(0, 60)}…` : undefined })}`);
                return formatJsonCommandResult({ job: "afterthought", ...result });
              }
```

  (c) `"afterthought"` in die `valid`-Liste (~2900). (d) Verfügbare llmCfg-Variablennamen am Anker prüfen (Grep `skillMinerLlmCfg`, `mergingLlmCfg`) und die tatsächlich vorhandenen verwenden.

- [ ] **Step 5: README-Doku** — im README (Abschnitt Cron/Jobs, per Grep `internal rem-dream` o. ä. finden) einen kurzen Absatz ergänzen: Cron-Empfehlung alle 30 Min `/plur1bus internal afterthought` mit Delivery + Prompt-Vorlage: „Wenn das JSON ein `text`-Feld enthält, sende genau diesen Text als Nachricht. Wenn `skipped` true ist, gib NICHTS aus."

- [ ] **Step 6: DEPLOY_FILES + volle Suite** — `npm test` → grün (inkl. bestehender open-threads-Tests).

- [ ] **Step 7: Commit** — `git commit -am "feat: afterthoughts (delayed follow-up job with governor + daily cap)"`

---

### Task 8: F6 Reaktions-Neigung (`lib/reaction-directive.js`)

**Files:**
- Create: `lib/reaction-directive.js`
- Modify: `index.js` (Capability-Erkennung einmalig, Direktive in `fullMemoriesContext`)
- Modify: `scripts/lib/deploy-integrity.mjs` (+ `"lib/reaction-directive.js"`)
- Test: `tests/reaction-directive.test.js`

**Interfaces:**
- Produces:
  - `detectReactionsCapability(runtimeConfig)` → boolean — rekursive Suche (max. Tiefe 8) nach einem Array-Wert, der `"reactions"` oder `"react"` enthält, unter Keys namens `actions`, `actionGroups`, `allowedActions` oder `groups`; fail-open `false`.
  - `buildReactionDirective({ palette = null } = {})` → string — deutsche Direktive ≤400 Zeichen.

- [ ] **Step 1: Failing Tests** — `tests/reaction-directive.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert";
import { detectReactionsCapability, buildReactionDirective } from "../lib/reaction-directive.js";

describe("detectReactionsCapability", () => {
  it("erkennt reactions in channel actions", () => {
    assert.strictEqual(detectReactionsCapability({ channels: { telegram: { actions: ["send", "reactions"] } } }), true);
    assert.strictEqual(detectReactionsCapability({ agents: { a: { actionGroups: ["react"] } } }), true);
  });

  it("false ohne reactions, bei null und bei zu tiefer Verschachtelung", () => {
    assert.strictEqual(detectReactionsCapability({ channels: { telegram: { actions: ["send"] } } }), false);
    assert.strictEqual(detectReactionsCapability(null), false);
    let deep = { actions: ["reactions"] };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    assert.strictEqual(detectReactionsCapability(deep), false);
  });

  it("verkraftet zyklische Objekte", () => {
    const a = { channels: {} };
    a.channels.self = a;
    assert.strictEqual(detectReactionsCapability(a), false);
  });
});

describe("buildReactionDirective", () => {
  it("liefert Direktive ≤400 mit Default-Palette", () => {
    const d = buildReactionDirective();
    assert.match(d, /Emoji-Reaktion/);
    assert.match(d, /👍/);
    assert.ok(d.length <= 400);
  });

  it("nutzt übergebene Palette", () => {
    const d = buildReactionDirective({ palette: "🐢 🌊" });
    assert.match(d, /🐢/);
    assert.doesNotMatch(d, /👍/);
  });
});
```

- [ ] **Step 2: Run** — FAIL erwartet.

- [ ] **Step 3: Implementierung** — `lib/reaction-directive.js`:

```js
/**
 * lib/reaction-directive.js — Reaktions-Neigung (Humanization F6).
 *
 * OpenClaw besitzt ein natives react-Channel-Action (Action-Group
 * "reactions"). Das Plugin versendet nichts selbst — es erzeugt nur die
 * Neigung per Direktive, und nur wenn die Fähigkeit im Gateway-Config
 * erkennbar aktiviert ist (sonst stillschweigend aus).
 */

const CAPABILITY_KEYS = new Set(["actions", "actionGroups", "allowedActions", "groups"]);
const CAPABILITY_VALUES = new Set(["reactions", "react"]);
const MAX_DEPTH = 8;
const DEFAULT_PALETTE = "👍 ❤️ 😂 🎉 🤔";

export function detectReactionsCapability(runtimeConfig) {
  try {
    const seen = new Set();
    const walk = (node, depth) => {
      if (!node || typeof node !== "object" || depth > MAX_DEPTH || seen.has(node)) return false;
      seen.add(node);
      for (const [key, value] of Object.entries(node)) {
        if (CAPABILITY_KEYS.has(key)) {
          if (Array.isArray(value) && value.some((v) => CAPABILITY_VALUES.has(v))) return true;
          if (value && typeof value === "object" && !Array.isArray(value)
            && Object.entries(value).some(([k, v]) => CAPABILITY_VALUES.has(k) && v !== false)) return true;
        }
        if (value && typeof value === "object" && walk(value, depth + 1)) return true;
      }
      return false;
    };
    return walk(runtimeConfig, 0);
  } catch (_) {
    return false;
  }
}

export function buildReactionDirective({ palette = null } = {}) {
  const emojis = typeof palette === "string" && palette.trim() ? palette.trim() : DEFAULT_PALETTE;
  const directive = `Auf kurze, rein bestätigende oder emotionale Nachrichten darfst du statt mit Text auch NUR mit einer Emoji-Reaktion antworten (react-Action auf die Nachricht). Passende Palette: ${emojis}. Setze Reaktionen sparsam ein — höchstens etwa einmal pro Gesprächsabschnitt.`;
  return directive.length > 400 ? directive.slice(0, 399).trimEnd() + "…" : directive;
}
```

- [ ] **Step 4: index.js-Integration** — am Kontextbau-Anker (bei personaDirective/moodStyleDirective), pro Handler-Aufruf billig dank einmaliger Lazy-Erkennung:

```js
          let reactionDirective = null;
          try {
            const rnCfg = cfg.reactionNudge || {};
            const mode = rnCfg.enabled ?? "auto";
            if (mode === true || (mode === "auto" && detectReactionsCapabilityCached())) {
              const { buildReactionDirective } = await import("./lib/reaction-directive.js");
              reactionDirective = buildReactionDirective({ palette: rnCfg.palette || null });
            }
          } catch (_) { /* fail-open */ }
```

  `detectReactionsCapabilityCached` als kleine Closure auf Modul-/Setup-Ebene von index.js (einmal berechnen, Ergebnis merken):

```js
let _reactionsCapability = null;
function makeReactionsCapabilityChecker(api) {
  return async function detectReactionsCapabilityCached() {
    if (_reactionsCapability !== null) return _reactionsCapability;
    try {
      const { detectReactionsCapability } = await import("./lib/reaction-directive.js");
      const runtimeConfig = typeof api.runtime?.config?.current === "function"
        ? api.runtime.config.current()
        : (api.runtime?.config && typeof api.runtime.config === "object" ? api.runtime.config : null);
      _reactionsCapability = detectReactionsCapability(runtimeConfig);
    } catch (_) { _reactionsCapability = false; }
    return _reactionsCapability;
  };
}
```

  (Implementierungsdetail: Platzierung so wählen, dass `api` im Scope ist — z. B. Checker im Plugin-Setup erzeugen und in der Handler-Closure verwenden; der Aufruf oben wird dann `await …()`.) `reactionDirective` als letztes Direktiven-Element vor `memoriesContext` in `fullMemoriesContext` aufnehmen. Finale Reihenfolge:

```js
          const fullMemoriesContext = [personaDirective, moodStyleDirective, reactionDirective, dreamEchoContext, openThreadsContext, contradictionDisclosureContext, memoriesContext, reactivationContext].filter(Boolean).join("\n\n");
```

- [ ] **Step 5: DEPLOY_FILES + volle Suite** — `npm test` → grün.

- [ ] **Step 6: Commit** — `git commit -am "feat: reaction nudge directive (gateway react capability, auto-detected)"`

---

## Nach den Tasks

- Finaler Whole-Branch-Review (SDD), danach superpowers:finishing-a-development-branch.
- Manuell (Controller, nicht Teil dieses Plans): Deploy via `npm run repair`/verify-plugin-deploy, Gateway-Neustart, Cron für `persona-evolve` (wöchentlich) und `afterthought` (alle 30 Min, mit Delivery-Prompt aus Task 7 Step 5) in Installationen einrichten, die es nutzen wollen.

## Bewusste Abweichungen von der Spec

- **feature-profiles.js-Einbindung verschoben:** Alle Gates haben sinnvolle Defaults (`?? true` bzw. `reactionNudge: "auto"`), proaktive Sends sind Governor-gebremst — eine Profil-Verdrahtung (Full/Minimal) ist Folgearbeit, wenn die Feature-Namen stabil sind.
- **F5-Evolution ohne skill-miner proposal-writer:** Vorschlag lebt als Sektion in `persona-voice.md` selbst + explizites `/plur1bus persona accept` — erfüllt die Spec-Anforderung (nie stillschweigend, User-Kontrolle) mit weniger Kopplung.
