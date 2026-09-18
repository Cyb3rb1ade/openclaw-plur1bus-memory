# Importance aus Kodierung und Gebrauch — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Importance einer Erinnerung stammt künftig aus einem LLM-Urteil beim Kodieren und aus dem Gebrauch, nicht mehr aus Schlüsselwortlisten; `memoryStrength` wird der eine Präsenzwert.

**Architecture:** Vier Kräfte schieben `memoryStrength`: Kodierung (LLM im stündlichen Tier-3-Cron), Blitzlicht (bisher toter Pfad, wird angeschlossen), Gebrauch (vorhanden) sowie Zeit und Interferenz (vorhanden). `importance` bleibt als Kodierungsurteil mit drei Abnehmern und verlässt das Recall-Ranking. Automatismen werden auf 0,94 gedeckelt, das Band 0,95 bis 1,00 gehört dem Agenten und bekommt erstmals Wirkung.

**Tech Stack:** Node 24, ESM, `node:test`, LanceDB 0.26.2 (`@lancedb/lancedb`), Tier-3-LLM über `llmRouter` (`anthropic/claude-haiku-4-5`).

**Spec:** `docs/superpowers/specs/2026-09-19-importance-kodierung-gebrauch-design.md`

## Global Constraints

- Arbeitsverzeichnis ist der Deploy-Worktree `/root/.openclaw/plur1bus-release` auf Branch `release/7.12.12`. Fixes basieren auf dem Release-Tag, nie auf dem verwaisten lokalen `main`.
- Automatische Schreibvorgänge erzeugen höchstens `importance = 0.94`. Der Bereich 0,95 bis 1,00 ist dem Agenten vorbehalten.
- `applyFlashbulbEncoding()` fasst `importance` nicht an. Es setzt ausschließlich `memoryStrength` und `halfLifeDays`.
- Der Backfill senkt niemals eine bestehende `memoryStrength`. Halbwertszeiten wirken nur nach vorn.
- Tests laufen zweigeteilt, weil `tests/auto-capture-batch.test.js` unter Last unbegrenzt hängt:
  `node --test --test-concurrency=1 $(ls tests/*.test.js | grep -v 'auto-capture-batch') test/*.test.js`, danach `node --test tests/auto-capture-batch.test.js`.
- Sechs Tests in `tests/local-inference-*.test.js` schlagen unabhängig von diesen Änderungen fehl (adm-zip, sharp). Das ist der Stand von `v7.12.61` und kein Regress.
- **Keine Claude-Attribution in Commit-Nachrichten.** Kein `Co-Authored-By: Claude…`, keine `Claude-Session:`-Zeile. Stehende Regel des Betreibers für dieses Repo.
- Halbwertszeiten der Kodierungsbänder, freigegeben: unter 0,4 → 30 Tage; 0,4 bis 0,7 → 180; 0,7 bis 0,94 → 600; Blitzlicht → 3.650; ab 0,95 → 36.500.

---

### Task 1: Deckel 0,94 für automatische Importance

**Files:**
- Modify: `lib/memory-fact-quality.js:380-409` (`computeMemoryImportance`)
- Test: `tests/importance-automatic-cap.test.js` (neu)

**Interfaces:**
- Consumes: nichts aus früheren Tasks.
- Produces: `export const AUTOMATIC_IMPORTANCE_MAX = 0.94;` aus `lib/memory-fact-quality.js`. Task 9 und Task 11 importieren diese Konstante.

- [ ] **Step 1: Write the failing test**

```js
// tests/importance-automatic-cap.test.js
import { describe, it } from "node:test";
import assert from "node:assert";
import { computeMemoryImportance, AUTOMATIC_IMPORTANCE_MAX } from "../lib/memory-fact-quality.js";

describe("automatic importance cap", () => {
  it("never exceeds 0.94 without an explicit value", () => {
    assert.strictEqual(AUTOMATIC_IMPORTANCE_MAX, 0.94);
    const texts = [
      "Merke dir: Evas Geburtstag ist am 3. Maerz.",
      "Ab jetzt bitte immer kuerzer antworten.",
      "Korrektur: der Port ist nicht 8080, sondern 18789.",
    ];
    for (const text of texts) {
      const result = computeMemoryImportance({ text, category: "fact", origin: "dm" });
      assert.ok(result.importance <= AUTOMATIC_IMPORTANCE_MAX, `${text} -> ${result.importance}`);
    }
  });

  it("lets the agent through into the reserved band", () => {
    const result = computeMemoryImportance({
      text: "Eriks Blutzucker-Zielbereich ist 80 bis 100.",
      category: "fact",
      origin: "dm",
      explicitImportance: 0.97,
    });
    assert.strictEqual(result.importance, 0.97);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/importance-automatic-cap.test.js`
Expected: FAIL — `AUTOMATIC_IMPORTANCE_MAX` ist `undefined`, die erste Zusicherung schlägt fehl.

- [ ] **Step 3: Write minimal implementation**

In `lib/memory-fact-quality.js`, oberhalb von `computeMemoryImportance`:

```js
/**
 * Obergrenze fuer Werte, die ohne ausdrueckliche Angabe des Agenten entstehen.
 * Der Bereich darueber (0.95 bis 1.00) ist der Entscheidung des Agenten
 * vorbehalten und traegt ab 0.95 den Kern-Schutz (siehe lib/memory-dynamics.js).
 */
export const AUTOMATIC_IMPORTANCE_MAX = 0.94;
```

In `computeMemoryImportance`, die Rückgabe ändern:

```js
  const capped = isExplicit ? normalized : Math.min(normalized, AUTOMATIC_IMPORTANCE_MAX);

  return {
    importance: capped,
    importanceReason: reasons.join("; ") || "default importance",
    factQuality,
    categoryReason,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/importance-automatic-cap.test.js`
Expected: PASS, 2 Tests.

- [ ] **Step 5: Run the affected suites**

Run: `node --test --test-concurrency=1 tests/memory-fact-quality.test.js tests/memory-promotion-quality.test.js tests/recall-golden-set-fact-quality.test.js`
Expected: PASS. Schlägt ein Test fehl, weil er einen Wert über 0,94 aus einem automatischen Pfad erwartet, ist der Test anzupassen, nicht der Deckel.

- [ ] **Step 6: Commit**

```bash
git add lib/memory-fact-quality.js tests/importance-automatic-cap.test.js
git commit -m "feat(importance): Automatismen auf 0.94 deckeln"
```

---

### Task 2: Statusspalte `importanceStatus`

**Files:**
- Create: `lib/importance-status.js`
- Modify: `index.js:1432-1470` (`normalizeEntryForTable`), `index.js:1599-1601` (Migrationsliste), `index.js:1678-1754` (Seed-Zeile von `createTable`)
- Test: `tests/importance-status.test.js` (neu)

**Interfaces:**
- Consumes: nichts.
- Produces: `IMPORTANCE_STATUS` (`{ PENDING: "pending", PENDING_BACKFILL: "pending_backfill", FINAL: "final" }`) und `normalizeImportanceStatus(value)` aus `lib/importance-status.js`. Tasks 6, 7, 9, 11 importieren beides.

- [ ] **Step 1: Write the failing test**

```js
// tests/importance-status.test.js
import { describe, it } from "node:test";
import assert from "node:assert";
import { IMPORTANCE_STATUS, normalizeImportanceStatus } from "../lib/importance-status.js";

describe("importance status", () => {
  it("knows three states", () => {
    assert.deepStrictEqual(
      Object.values(IMPORTANCE_STATUS).sort(),
      ["final", "pending", "pending_backfill"],
    );
  });

  it("treats absent or unknown values as final", () => {
    for (const value of [undefined, null, "", "quatsch", 7]) {
      assert.strictEqual(normalizeImportanceStatus(value), IMPORTANCE_STATUS.FINAL);
    }
  });

  it("keeps the two waiting states apart", () => {
    assert.strictEqual(normalizeImportanceStatus("pending"), IMPORTANCE_STATUS.PENDING);
    assert.strictEqual(normalizeImportanceStatus("pending_backfill"), IMPORTANCE_STATUS.PENDING_BACKFILL);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/importance-status.test.js`
Expected: FAIL — `Cannot find module '../lib/importance-status.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/importance-status.js
/**
 * Wartezustaende der Importance-Klaerung.
 *
 * Zwei getrennte Wartezustaende, weil sie von verschiedenen Laeufern bedient
 * werden: `pending` nimmt der stuendliche emotion-refine-Cron (frische Zeilen,
 * rund 131 am Tag), `pending_backfill` ausschliesslich das Backfill-Skript in
 * Stapeln. Ohne die Trennung wuerde der Cron den gesamten Bestand Zeile fuer
 * Zeile abarbeiten und dabei je Zeile eine LanceDB-Version erzeugen — genau die
 * Fragmentierung, die am 13.09.2026 zu Gateway-Blockaden gefuehrt hat.
 */
export const IMPORTANCE_STATUS = Object.freeze({
  PENDING: "pending",
  PENDING_BACKFILL: "pending_backfill",
  FINAL: "final",
});

const KNOWN = new Set(Object.values(IMPORTANCE_STATUS));

/** Unbekanntes und Fehlendes gilt als geklaert — Bestandszeilen sind nicht "offen". */
export function normalizeImportanceStatus(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return KNOWN.has(text) ? text : IMPORTANCE_STATUS.FINAL;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/importance-status.test.js`
Expected: PASS, 3 Tests.

- [ ] **Step 5: Spalte in index.js verdrahten**

Import oben in `index.js` ergänzen:

```js
import { IMPORTANCE_STATUS, normalizeImportanceStatus } from "./lib/importance-status.js";
```

In der Seed-Zeile von `createTable` (neben `emotionStatus: "final"`):

```js
            importanceStatus: "final",
```

In der Migrationsliste, direkt nach der `emotionStatus`-Zeile:

```js
            // Bestand gilt als geklaert; Phase 1 der Migration setzt ihn
            // ausdruecklich auf pending_backfill.
            { name: 'importanceStatus', valueSql: "'final'" },
```

In `normalizeEntryForTable`, bei den Defaults:

```js
    normalized.importanceStatus = normalizeImportanceStatus(normalized.importanceStatus);
```

- [ ] **Step 6: Syntaxpruefung und Suite**

Run: `node --check index.js && node --test --test-concurrency=1 tests/schema-migration.test.js tests/importance-status.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/importance-status.js index.js tests/importance-status.test.js
git commit -m "feat(importance): Statusspalte importanceStatus einfuehren"
```

---

### Task 3: Halbwertszeit aus der Kodierung

**Files:**
- Modify: `lib/memory-dynamics.js` (neue Funktion neben `resolveHalfLifeDays`)
- Test: `tests/halflife-from-encoding.test.js` (neu)

**Interfaces:**
- Consumes: nichts.
- Produces: `resolveHalfLifeFromEncoding(importance, { flashbulb = false } = {})` aus `lib/memory-dynamics.js`, Rückgabe in Tagen. Tasks 4, 6 und 11 rufen sie auf.

- [ ] **Step 1: Write the failing test**

```js
// tests/halflife-from-encoding.test.js
import { describe, it } from "node:test";
import assert from "node:assert";
import { resolveHalfLifeFromEncoding, CORE_MEMORY_HALF_LIFE_DAYS } from "../lib/memory-dynamics.js";

describe("half-life from encoding", () => {
  it("maps the four automatic bands", () => {
    assert.strictEqual(resolveHalfLifeFromEncoding(0.2), 30);
    assert.strictEqual(resolveHalfLifeFromEncoding(0.5), 180);
    assert.strictEqual(resolveHalfLifeFromEncoding(0.8), 600);
    assert.strictEqual(resolveHalfLifeFromEncoding(0.94), 600);
  });

  it("gives the agent band the core half-life", () => {
    assert.strictEqual(resolveHalfLifeFromEncoding(0.95), CORE_MEMORY_HALF_LIFE_DAYS);
    assert.strictEqual(resolveHalfLifeFromEncoding(1.0), CORE_MEMORY_HALF_LIFE_DAYS);
  });

  it("gives flashbulb ten years without touching the agent band", () => {
    assert.strictEqual(resolveHalfLifeFromEncoding(0.6, { flashbulb: true }), 3650);
    assert.strictEqual(resolveHalfLifeFromEncoding(0.2, { flashbulb: true }), 3650);
  });

  it("treats a missing value as the middle band", () => {
    assert.strictEqual(resolveHalfLifeFromEncoding(undefined), 180);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/halflife-from-encoding.test.js`
Expected: FAIL — `resolveHalfLifeFromEncoding is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
/** Halbwertszeit in Tagen fuer eine Blitzlicht-Kodierung — zehn Jahre. */
export const FLASHBULB_HALF_LIFE_DAYS = 3650;

/**
 * Halbwertszeit aus dem Kodierungsurteil statt aus der Kategorie.
 *
 * Baender (freigegeben 19.09.2026): < 0.4 beilaeufig, 0.4–0.7 normal,
 * 0.7–0.94 bedeutsam, ab 0.95 Agentenband. Blitzlicht sticht die Baender,
 * bleibt aber unter dem Agentenband — "eingebrannt" und "behalten wollen"
 * sind zwei verschiedene Vorgaenge.
 */
export function resolveHalfLifeFromEncoding(importance, { flashbulb = false } = {}) {
  const value = Number.isFinite(Number(importance)) ? Number(importance) : 0.5;
  if (value >= MANUAL_CORE_IMPORTANCE) return CORE_MEMORY_HALF_LIFE_DAYS;
  if (flashbulb) return FLASHBULB_HALF_LIFE_DAYS;
  if (value < 0.4) return 30;
  if (value < 0.7) return 180;
  return 600;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/halflife-from-encoding.test.js`
Expected: PASS, 4 Tests.

- [ ] **Step 5: Commit**

```bash
git add lib/memory-dynamics.js tests/halflife-from-encoding.test.js
git commit -m "feat(dynamics): Halbwertszeit aus der Kodierung ableiten"
```

---

### Task 4: Blitzlicht-Kodierung anschliessen

**Files:**
- Modify: `lib/memory-dynamics.js` (`applyFlashbulbEncoding`)
- Test: `tests/flashbulb-wiring.test.js` (neu)

**Interfaces:**
- Consumes: `FLASHBULB_HALF_LIFE_DAYS`, `resolveHalfLifeFromEncoding` aus Task 3.
- Produces: `applyFlashbulbEncoding(row, now, threshold, baseHalfLifeDays)` liefert unverändert `null` oder ein Patch-Objekt, jetzt aber mit zehn Jahren statt 90 Tagen. Task 6 ruft sie auf.

Hintergrund: Die Funktion ist seit Langem implementiert und getestet, wird aber im gesamten Paket nirgends aufgerufen — nur in ihrer eigenen Datei und in zwei Testdateien. Dieser Task korrigiert die Halbwertszeit, Task 6 verdrahtet den Aufruf.

- [ ] **Step 1: Write the failing test**

```js
// tests/flashbulb-wiring.test.js
import { describe, it } from "node:test";
import assert from "node:assert";
import { applyFlashbulbEncoding, FLASHBULB_HALF_LIFE_DAYS } from "../lib/memory-dynamics.js";

describe("flashbulb encoding", () => {
  const now = Date.UTC(2026, 8, 19);

  it("burns in a single intense event for ten years", () => {
    const patch = applyFlashbulbEncoding({ emotionalIntensity: 0.9, importance: 0.8 }, now, 0.7, 180);
    assert.ok(patch, "expected a patch above the threshold");
    assert.strictEqual(patch.halfLifeDays, FLASHBULB_HALF_LIFE_DAYS);
    assert.strictEqual(patch.memoryStrength, 0.95);
  });

  it("never touches importance", () => {
    const patch = applyFlashbulbEncoding({ emotionalIntensity: 1.0, importance: 0.8 }, now, 0.7, 180);
    assert.strictEqual(Object.hasOwn(patch, "importance"), false);
  });

  it("stays silent below the threshold", () => {
    assert.strictEqual(applyFlashbulbEncoding({ emotionalIntensity: 0.2, importance: 0.5 }, now, 0.7, 180), null);
  });

  it("never shortens an existing longer half-life", () => {
    const patch = applyFlashbulbEncoding({ emotionalIntensity: 0.9, importance: 0.8 }, now, 0.7, 36500);
    assert.strictEqual(patch.halfLifeDays, 36500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/flashbulb-wiring.test.js`
Expected: FAIL — `halfLifeDays` ist 180 statt 3650, weil die Funktion heute `Math.max(base, 90)` rechnet.

- [ ] **Step 3: Write minimal implementation**

In `applyFlashbulbEncoding` die Zeile mit der Halbwertszeit ersetzen:

```js
    // Flashbulb darf die Halbwertszeit nur verlaengern, nie verkuerzen.
    halfLifeDays: Math.max(Number(baseHalfLifeDays) || 0, FLASHBULB_HALF_LIFE_DAYS),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 tests/flashbulb-wiring.test.js tests/memory-dynamics-halflife.test.js tests/manual-core-marker.test.js`
Expected: PASS. `memory-dynamics-halflife.test.js` prüft die alten 90 Tage und ist auf 3.650 anzupassen.

- [ ] **Step 5: Commit**

```bash
git add lib/memory-dynamics.js tests/flashbulb-wiring.test.js tests/memory-dynamics-halflife.test.js
git commit -m "feat(dynamics): Blitzlicht-Kodierung auf zehn Jahre"
```

---

### Task 5: LLM-Einstiegspunkt fuer Emotion und Bedeutung

**Files:**
- Create: `lib/encoding-llm.js`
- Test: `tests/encoding-llm.test.js` (neu)

**Interfaces:**
- Consumes: `AUTOMATIC_IMPORTANCE_MAX` (Task 1).
- Produces: `classifyEncoding(text, { agentId, runtimeLlm, signal })` → `Promise<{ emotion, importance, reason, ok }>` aus `lib/encoding-llm.js`. Tasks 6 und 11 rufen sie auf.

Wichtig: `inferEmotionalValenceAsync()` bleibt unveraendert. Sie hat weitere Aufrufer, deren Rueckgabe sich nicht aendern darf.

- [ ] **Step 1: Write the failing test**

```js
// tests/encoding-llm.test.js
import { describe, it } from "node:test";
import assert from "node:assert";
import { parseEncodingResponse, buildEncodingPrompt } from "../lib/encoding-llm.js";

describe("encoding llm", () => {
  it("asks for both judgements in one prompt", () => {
    const prompt = buildEncodingPrompt("Mein Hund ist heute eingeschlaefert worden.");
    assert.match(prompt, /importance/i);
    assert.match(prompt, /intensity/i);
    assert.match(prompt, /Mein Hund/);
  });

  it("parses a well formed answer", () => {
    const parsed = parseEncodingResponse(JSON.stringify({
      importance: 0.88, intensity: 0.9, dominant: "sadness", reason: "Verlust eines Haustiers",
    }));
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.importance, 0.88);
    assert.strictEqual(parsed.emotion.emotionalDominant, "sadness");
    assert.strictEqual(parsed.reason, "Verlust eines Haustiers");
  });

  it("caps the model at the automatic ceiling", () => {
    const parsed = parseEncodingResponse(JSON.stringify({ importance: 0.99, intensity: 0.4, dominant: "joy" }));
    assert.strictEqual(parsed.importance, 0.94);
  });

  it("refuses garbage instead of inventing a value", () => {
    for (const raw of ["", "kein json", JSON.stringify({ intensity: 0.5 })]) {
      assert.strictEqual(parseEncodingResponse(raw).ok, false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/encoding-llm.test.js`
Expected: FAIL — `Cannot find module '../lib/encoding-llm.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/encoding-llm.js
import { AUTOMATIC_IMPORTANCE_MAX } from "./memory-fact-quality.js";

const EMOTION_DIMENSIONS = ["joy", "sadness", "anger", "fear", "surprise", "trust", "anticipation"];

export function buildEncodingPrompt(text) {
  return [
    "Du bewertest eine einzelne Erinnerung eines persoenlichen Assistenten.",
    "Antworte ausschliesslich mit JSON, ohne Rahmen und ohne Erklaerung davor oder danach.",
    "",
    "Felder:",
    '  importance: 0.0 bis 0.94 — wie bedeutsam diese Erinnerung fuer den Nutzer langfristig ist.',
    "    0.1 beilaeufiges Gespraech, 0.5 nuetzlich, 0.8 wichtige Tatsache ueber Person oder Vorhaben.",
    "  intensity: 0.0 bis 1.0 — wie stark die Erinnerung emotional aufgeladen ist.",
    `  dominant: eine von ${EMOTION_DIMENSIONS.join(", ")} oder neutral.`,
    "  reason: ein kurzer Satz, warum.",
    "",
    "Erinnerung:",
    String(text || "").slice(0, 2000),
  ].join("\n");
}

/** Parst die Modellantwort. Unbrauchbares liefert ok:false — nie einen geratenen Wert. */
export function parseEncodingResponse(raw) {
  const text = String(raw || "").trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false };
  let data;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return { ok: false };
  }
  const importanceRaw = Number(data?.importance);
  if (!Number.isFinite(importanceRaw)) return { ok: false };
  const intensity = Number.isFinite(Number(data?.intensity)) ? Math.min(Math.max(Number(data.intensity), 0), 1) : 0;
  const dominantRaw = String(data?.dominant || "neutral").toLowerCase();
  const dominant = EMOTION_DIMENSIONS.includes(dominantRaw) ? dominantRaw : "neutral";
  return {
    ok: true,
    importance: Math.min(Math.max(importanceRaw, 0), AUTOMATIC_IMPORTANCE_MAX),
    emotion: { emotionalDominant: dominant, emotionalIntensity: intensity, [dominant]: intensity },
    reason: typeof data?.reason === "string" ? data.reason.slice(0, 200) : "",
  };
}

/**
 * Ein LLM-Call fuer beide Urteile. Das Modell liest den Text ohnehin; die
 * Bedeutung mitzufragen kostet ein paar Ausgabetoken, keinen zweiten Call.
 */
export async function classifyEncoding(text, { agentId, runtimeLlm, signal } = {}) {
  if (typeof runtimeLlm?.complete !== "function") return { ok: false };
  try {
    const answer = await runtimeLlm.complete({
      prompt: buildEncodingPrompt(text),
      agentId,
      signal,
      maxTokens: 200,
    });
    return parseEncodingResponse(answer);
  } catch {
    return { ok: false };
  }
}
```

**Hinweis fuer den Umsetzenden:** Die genaue Signatur von `runtimeLlm` steht in `lib/tier3-llm.js`; falls dort kein `complete()` existiert, ist der Aufruf an die dort verwendete Methode anzupassen und der Test um einen Stub zu ergaenzen, der diese Methode nachbildet. Die reinen Funktionen `buildEncodingPrompt` und `parseEncodingResponse` bleiben davon unberuehrt.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/encoding-llm.test.js`
Expected: PASS, 4 Tests.

- [ ] **Step 5: Commit**

```bash
git add lib/encoding-llm.js tests/encoding-llm.test.js
git commit -m "feat(importance): LLM-Einstiegspunkt fuer Kodierungsurteil"
```

---

### Task 6: Cron klaert Emotion und Bedeutung

**Files:**
- Modify: `index.js:7988-8053` (Zweig `emotion-refine`)
- Test: `tests/emotion-refine-importance.test.js` (neu)

**Interfaces:**
- Consumes: `classifyEncoding` (Task 5), `IMPORTANCE_STATUS` (Task 2), `resolveHalfLifeFromEncoding` und `applyFlashbulbEncoding` (Tasks 3 und 4).
- Produces: `buildRefinePatch(row, encoding, now)` — als benannte Funktion aus `index.js` heraus in `lib/encoding-llm.js` gelegt, damit sie testbar ist. Rückgabe: Patch-Objekt für `db.update`.

- [ ] **Step 1: Write the failing test**

```js
// tests/emotion-refine-importance.test.js
import { describe, it } from "node:test";
import assert from "node:assert";
import { buildRefinePatch } from "../lib/encoding-llm.js";
import { IMPORTANCE_STATUS } from "../lib/importance-status.js";
import { FLASHBULB_HALF_LIFE_DAYS } from "../lib/memory-dynamics.js";

const now = Date.UTC(2026, 8, 19);

describe("refine patch", () => {
  it("writes importance, emotion, reason and both statuses", () => {
    const patch = buildRefinePatch({ id: "a", memoryStrength: 0.8, halfLifeDays: 180 },
      { ok: true, importance: 0.8, emotion: { emotionalDominant: "trust", emotionalIntensity: 0.3 }, reason: "Projektfakt" }, now);
    assert.strictEqual(patch.importance, 0.8);
    assert.strictEqual(patch.emotionalDominant, "trust");
    assert.strictEqual(patch.importanceStatus, IMPORTANCE_STATUS.FINAL);
    assert.strictEqual(patch.emotionStatus, "final");
    assert.match(patch.coreMemoryReason, /Projektfakt/);
    assert.strictEqual(patch.halfLifeDays, 600);
  });

  it("burns in an intense single event", () => {
    const patch = buildRefinePatch({ id: "b", memoryStrength: 0.9, halfLifeDays: 180 },
      { ok: true, importance: 0.8, emotion: { emotionalDominant: "fear", emotionalIntensity: 0.95 }, reason: "" }, now);
    assert.strictEqual(patch.halfLifeDays, FLASHBULB_HALF_LIFE_DAYS);
    assert.strictEqual(patch.memoryStrength, 0.95);
  });

  it("never lowers an existing strength", () => {
    const patch = buildRefinePatch({ id: "c", memoryStrength: 1.0, halfLifeDays: 180 },
      { ok: true, importance: 0.8, emotion: { emotionalDominant: "fear", emotionalIntensity: 0.95 }, reason: "" }, now);
    assert.strictEqual(patch.memoryStrength, 1.0);
  });

  it("returns null when the model failed", () => {
    assert.strictEqual(buildRefinePatch({ id: "d" }, { ok: false }, now), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/emotion-refine-importance.test.js`
Expected: FAIL — `buildRefinePatch is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/encoding-llm.js` ergänzen:

```js
import { IMPORTANCE_STATUS } from "./importance-status.js";
import { applyFlashbulbEncoding, resolveHalfLifeFromEncoding } from "./memory-dynamics.js";
import { serializeEmotionalValence } from "./emotion.js";

/**
 * Patch aus einem Kodierungsurteil. Zwei Regeln, die nie verletzt werden:
 * die Staerke wird nie gesenkt, und die Blitzlicht-Kodierung fasst die
 * Importance nicht an.
 */
export function buildRefinePatch(row = {}, encoding = {}, now = Date.now()) {
  if (!encoding?.ok) return null;
  const intensity = Number(encoding.emotion?.emotionalIntensity) || 0;
  const flash = applyFlashbulbEncoding(
    { emotionalIntensity: intensity, importance: encoding.importance },
    now,
    0.7,
    resolveHalfLifeFromEncoding(encoding.importance),
  );
  const patch = {
    importance: encoding.importance,
    importanceStatus: IMPORTANCE_STATUS.FINAL,
    emotionStatus: "final",
    emotionalValence: serializeEmotionalValence(encoding.emotion),
    emotionalIntensity: intensity,
    emotionalDominant: encoding.emotion?.emotionalDominant || "neutral",
    coreMemoryReason: String(encoding.reason || "").slice(0, 200),
    halfLifeDays: flash ? flash.halfLifeDays : resolveHalfLifeFromEncoding(encoding.importance),
    lastDynamicsAt: now,
  };
  if (flash) {
    patch.memoryStrength = Math.max(Number(row.memoryStrength) || 0, flash.memoryStrength);
    patch.lastStrengthenedAt = now;
  }
  return patch;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/emotion-refine-importance.test.js`
Expected: PASS, 4 Tests.

- [ ] **Step 5: Cron-Zweig umstellen**

In `index.js`, im Zweig `emotion-refine`: die `where`-Klausel erweitern und den Schreibvorgang ersetzen.

```js
                  const rows = await agentDb.table.query()
                    .where(`emotionStatus = 'pending_t3' OR importanceStatus = '${IMPORTANCE_STATUS.PENDING}'`)
                    .limit(EMOTION_REFINE_MAX_ROWS + 1)
                    .toArray();
```

```js
                    const encoding = await classifyEncoding(String(row.text || "").slice(0, 2000), {
                      agentId: internalAgent,
                      runtimeLlm,
                    });
                    const patch = buildRefinePatch(row, encoding, Date.now());
                    if (!patch) {
                      counts.failed++;
                      if (++consecutiveFailures >= EMOTION_REFINE_MAX_CONSECUTIVE_FAILURES) break;
                      continue;
                    }
                    consecutiveFailures = 0;
                    await agentDb.update(row.id, patch);
                    counts.refined++;
```

Die Schutzklausel `if (!agentDb.schemaFieldNames?.has("emotionStatus"))` um `importanceStatus` erweitern.

- [ ] **Step 6: Syntaxpruefung und Suite**

Run: `node --check index.js && node --test --test-concurrency=1 tests/emotion-refine-importance.test.js tests/emotion-tier-config.test.js tests/feature-toggle.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/encoding-llm.js index.js tests/emotion-refine-importance.test.js
git commit -m "feat(importance): Cron klaert Emotion und Bedeutung in einem Call"
```

---

### Task 7: Capture schreibt neutral statt geschaetzt

**Files:**
- Modify: `index.js:10560-10613` (Schreibphase des Capture-Hooks)
- Test: `tests/capture-neutral-importance.test.js` (neu)

**Interfaces:**
- Consumes: `IMPORTANCE_STATUS` (Task 2).
- Produces: nichts Neues.

- [ ] **Step 1: Write the failing test**

```js
// tests/capture-neutral-importance.test.js
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

// Der Capture-Hook laesst sich ohne Gateway nicht aufrufen; geprueft wird
// deshalb, dass der Pfad keinen geschaetzten Wert mehr bildet.
describe("capture writes a neutral importance", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const captureBlock = source.slice(source.indexOf("const categoryResult = categorizeMemoryWithReason(p.text)"), source.indexOf("await db.store(row)"));

  it("no longer derives importance from keywords at capture", () => {
    assert.strictEqual(captureBlock.includes("computeMemoryImportance"), false);
  });

  it("marks the row as pending for the hourly cron", () => {
    assert.match(captureBlock, /importanceStatus: IMPORTANCE_STATUS\.PENDING/);
  });

  it("uses the neutral value in the meantime", () => {
    assert.match(captureBlock, /importance: 0\.5/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/capture-neutral-importance.test.js`
Expected: FAIL — der Block enthaelt heute `computeMemoryImportance`.

- [ ] **Step 3: Write minimal implementation**

Im Capture-Hook den Importance-Block ersetzen:

```js
                const categoryResult = categorizeMemoryWithReason(p.text);
                const category = categoryResult.category;
                // Bis der stuendliche Cron geurteilt hat, zaehlt die neutrale
                // 0.5. Ein geschaetzter Zwischenwert waere wieder die
                // Heuristik, die hier abgeloest wird. In derselben Session
                // steht die Erinnerung in dieser Zeit ohnehin noch im
                // Kontextfenster.
                const importance = 0.5;
```

und in der Zeile `applyDynamicsDefaults({ … })`:

```js
                  importanceStatus: IMPORTANCE_STATUS.PENDING,
```

Die nicht mehr benutzte Variable `captureImportanceResult` und ihr Aufruf entfallen.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --check index.js && node --test tests/capture-neutral-importance.test.js`
Expected: PASS, 3 Tests.

- [ ] **Step 5: Commit**

```bash
git add index.js tests/capture-neutral-importance.test.js
git commit -m "feat(capture): neutrale Importance statt Schluesselwortschaetzung"
```

---

### Task 8: Importance verlaesst das Recall-Ranking

**Files:**
- Modify: `lib/recall-pipeline.js:1805-1815` (Boost-Block), `lib/recall-pipeline.js:1422` (Default)
- Test: `tests/recall-without-importance-boost.test.js` (neu)

**Interfaces:**
- Consumes: nichts.
- Produces: `runRecallPipeline` ignoriert `importanceBoost`. Die Export-Funktion `applyImportanceBoost` bleibt bestehen, wird aber nicht mehr aufgerufen.

- [ ] **Step 1: Write the failing test**

```js
// tests/recall-without-importance-boost.test.js
import { describe, it } from "node:test";
import assert from "node:assert";
import { runRecallPipeline } from "../lib/recall-pipeline.js";

const makeDbTable = (rows) => ({
  vectorSearch: () => ({ limit: () => ({ toArray: async () => rows.map((r) => ({ scope: "agent-private", agentId: "a", storedBy: "a", ...r })) }) }),
});
const embeddings = { dim: 3, embed: async () => [0.1, 0.2, 0.3], embedQuery: async () => [0.1, 0.2, 0.3] };
const logger = { info: () => {}, warn: () => {} };

describe("recall ignores importance", () => {
  it("ranks two equally similar rows the same regardless of importance", async () => {
    const rows = [
      { id: "low", text: "Kaffee kochen mit der neuen Maschine", _distance: 0.2, importance: 0.1, memoryStrength: 1 },
      { id: "high", text: "Kaffee kochen mit der alten Maschine", _distance: 0.2, importance: 0.94, memoryStrength: 1 },
    ];
    const { memories } = await runRecallPipeline({
      query: "Kaffee", dbTable: makeDbTable(rows), embeddings, agentId: "a",
      topN: 5, canonicalEnabled: false, dedupEnabled: false, importanceBoost: 0.3, logger,
    });
    const scores = Object.fromEntries(memories.map((m) => [m.entry.id, m.score]));
    assert.ok(Math.abs(scores.low - scores.high) < 1e-9, `importance still moves the score: ${JSON.stringify(scores)}`);
  });

  it("still lets strength decide", async () => {
    const rows = [
      { id: "faded", text: "Kaffee kochen mit der neuen Maschine", _distance: 0.2, importance: 0.5, memoryStrength: 0.2 },
      { id: "fresh", text: "Kaffee kochen mit der alten Maschine", _distance: 0.2, importance: 0.5, memoryStrength: 1.0 },
    ];
    const { memories } = await runRecallPipeline({
      query: "Kaffee", dbTable: makeDbTable(rows), embeddings, agentId: "a",
      topN: 5, canonicalEnabled: false, dedupEnabled: false, logger,
    });
    assert.strictEqual(memories[0].entry.id, "fresh");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/recall-without-importance-boost.test.js`
Expected: FAIL im ersten Test — die Werte unterscheiden sich um `(0.94 − 0.1) × 0.3`.

- [ ] **Step 3: Write minimal implementation**

In `runRecallPipeline` den Default auf 0 setzen und den Term entfernen:

```js
  // Seit 19.09.2026 ohne Wirkung: Bedeutung wirkt ueber die Staerke, die sie
  // bei der Kodierung gesetzt hat, nicht als zweiter Aufschlag im Ranking.
  importanceBoost = 0,
```

```js
    const applyImportance = false;
```

und den Block `if (applyImportance) { score += … }` loeschen.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/recall-without-importance-boost.test.js`
Expected: PASS, 2 Tests.

- [ ] **Step 5: Gesamte Recall-Suite**

Run: `node --test --test-concurrency=1 tests/recall-*.test.js`
Expected: PASS. Tests, die den Importance-Boost zusichern, sind auf die neue Erwartung umzuschreiben — der Boost ist absichtlich weg.

- [ ] **Step 6: Commit**

```bash
git add lib/recall-pipeline.js tests/recall-without-importance-boost.test.js tests/recall-p1.test.js
git commit -m "feat(recall): Importance-Term aus dem Ranking entfernen"
```

---

### Task 9: Phase 1 — Altlast im Agentenband raeumen

**Files:**
- Create: `scripts/importance-phase1-reset.mjs`
- Test: `tests/importance-phase1-reset.test.js` (neu)

**Interfaces:**
- Consumes: `AUTOMATIC_IMPORTANCE_MAX` (Task 1), `IMPORTANCE_STATUS` (Task 2).
- Produces: `selectLegacyBandRows(rows)` aus `scripts/importance-phase1-reset.mjs`.

- [ ] **Step 1: Write the failing test**

```js
// tests/importance-phase1-reset.test.js
import { describe, it } from "node:test";
import assert from "node:assert";
import { selectLegacyBandRows } from "../scripts/importance-phase1-reset.mjs";

describe("phase 1 selection", () => {
  const rows = [
    { id: "mig", importance: 0.95, origin: "memory-md-migration", status: "active" },
    { id: "cron", importance: 0.95, origin: "cron", status: "active" },
    { id: "agent", importance: 0.95, origin: "dm", status: "active" },
    { id: "normal", importance: 0.7, origin: "cron", status: "active" },
    { id: "deleted", importance: 0.95, origin: "cron", status: "deleted" },
  ];

  it("takes migration and cron rows in the reserved band", () => {
    assert.deepStrictEqual(selectLegacyBandRows(rows).map((r) => r.id), ["mig", "cron"]);
  });

  it("leaves the agent's own decisions alone", () => {
    assert.strictEqual(selectLegacyBandRows(rows).some((r) => r.id === "agent"), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/importance-phase1-reset.test.js`
Expected: FAIL — Modul fehlt.

- [ ] **Step 3: Write minimal implementation**

```js
#!/usr/bin/env node
/**
 * Phase 1 der Importance-Migration: raeumt das Agentenband.
 *
 * Rund 320 Zeilen mit origin=memory-md-migration und fuenf mit origin=cron
 * stehen auf 0.95, ohne je einzeln bewertet worden zu sein. Erst wenn sie
 * unten sind, darf MANUAL_CORE_IMPORTANCE auf 0.95 sinken (Task 10) — sonst
 * werden genau diese Altlasten unsterblich.
 *
 * Dry-Run ist Standard. `--apply` muss ausdruecklich gesetzt werden.
 */
import { AUTOMATIC_IMPORTANCE_MAX } from "../lib/memory-fact-quality.js";
import { IMPORTANCE_STATUS } from "../lib/importance-status.js";

const LEGACY_ORIGINS = new Set(["memory-md-migration", "cron"]);

/** Zeilen im Agentenband, die nicht vom Agenten stammen. */
export function selectLegacyBandRows(rows = []) {
  return rows.filter((row) => {
    if (!row) return false;
    const status = String(row.status ?? "active");
    if (status !== "active") return false;
    if (Number(row.importance) < 0.95) return false;
    return LEGACY_ORIGINS.has(String(row.origin ?? ""));
  });
}

export function buildResetPatch(row) {
  return {
    importance: AUTOMATIC_IMPORTANCE_MAX,
    updateSource: "importance-v2",
    updateEvidence: JSON.stringify({ previousImportance: Number(row.importance), phase: 1 }),
    importanceStatus: IMPORTANCE_STATUS.PENDING_BACKFILL,
  };
}
```

Hauptprogramm, im Aufbau wie `scripts/backfill-manual-core-markers.mjs`:

```js
const APPLY = process.argv.includes("--apply");
const agents = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const BASE = join(homedir(), ".openclaw", "memory", "lancedb-namespaced");

for (const agentId of agents) {
  const db = await lancedb.connect(join(BASE, safeAgentId(agentId)));
  const table = await db.openTable("memories");
  const rows = await table.query().limit(100000).toArray();
  const active = rows.filter((r) => String(r.status ?? "active") === "active");
  const legacy = selectLegacyBandRows(rows);

  console.log(`${agentId}: ${active.length} aktiv, ${legacy.length} Altlasten im Agentenband`);
  for (const row of legacy.slice(0, 10)) {
    console.log(`   ${Number(row.importance).toFixed(2)} ${row.origin} ${String(row.text || "").slice(0, 70)}`);
  }
  if (!APPLY) { console.log("   Dry-Run — mit --apply ausfuehren"); continue; }

  // Ein mergeInsert je Agent: eine Version statt einer je Zeile.
  const patched = [
    ...legacy.map((row) => ({ ...row, ...buildResetPatch(row) })),
    ...active.filter((row) => !legacy.includes(row))
      .map((row) => ({ ...row, importanceStatus: IMPORTANCE_STATUS.PENDING_BACKFILL })),
  ];
  await table.mergeInsert("id").whenMatchedUpdateAll().execute(patched);
  console.log(`   ${legacy.length} zurueckgesetzt, ${patched.length} auf pending_backfill`);
}
```

Der Lauf setzt **alle** aktiven Zeilen auf `pending_backfill`, nicht nur die betroffenen — das ist die Warteschlange fuer Phase 2.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/importance-phase1-reset.test.js`
Expected: PASS, 2 Tests.

- [ ] **Step 5: Dry-Run auf dem Pilot-Store**

Run: `node scripts/importance-phase1-reset.mjs developer`
Expected: Ausgabe der betroffenen Zeilen, keine Schreibvorgaenge, Hinweis auf `--apply`.

- [ ] **Step 6: Commit**

```bash
git add scripts/importance-phase1-reset.mjs tests/importance-phase1-reset.test.js
git commit -m "feat(migration): Phase 1 raeumt das Agentenband"
```

---

### Task 10: Das Agentenband bekommt Wirkung

**Files:**
- Modify: `lib/memory-dynamics.js:22` (`MANUAL_CORE_IMPORTANCE`)
- Test: `tests/manual-core-marker.test.js` (vorhanden, erweitern)

**Reihenfolge-Bedingung:** Dieser Task wird erst **nach** einem erfolgreichen `--apply` von Task 9 auf allen Stores ausgeliefert. Wird die Schwelle vorher gesenkt, werden die Altlasten aus der MEMORY.md-Migration unsterblich.

- [ ] **Step 1: Write the failing test**

In `tests/manual-core-marker.test.js` ergaenzen:

```js
  it("treats the whole agent band as a core marker", () => {
    assert.strictEqual(MANUAL_CORE_IMPORTANCE, 0.95);
    assert.strictEqual(isManualCoreMarker({ importance: 0.95 }), true);
    assert.strictEqual(isManualCoreMarker({ importance: 0.97 }), true);
    assert.strictEqual(isManualCoreMarker({ importance: 0.94 }), false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/manual-core-marker.test.js`
Expected: FAIL — `MANUAL_CORE_IMPORTANCE` ist 1.0.

- [ ] **Step 3: Write minimal implementation**

```js
/**
 * Ab diesem Wert gilt eine Erinnerung als vom Agenten bewusst markiert und
 * traegt den Kern-Schutz. Bis 19.09.2026 stand die Schwelle auf 1.0, womit das
 * Band 0.95 bis 1.00 eine Verabredung ohne Wirkung war.
 */
export const MANUAL_CORE_IMPORTANCE = 0.95;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 tests/manual-core-marker.test.js tests/halflife-from-encoding.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/memory-dynamics.js tests/manual-core-marker.test.js
git commit -m "feat(dynamics): Agentenband ab 0.95 traegt den Kern-Schutz"
```

---

### Task 11: Phase 2 — Backfill in Stapeln

**Files:**
- Create: `scripts/importance-backfill.mjs`
- Test: `tests/importance-backfill.test.js` (neu)

**Interfaces:**
- Consumes: `classifyEncoding`, `buildRefinePatch` (Tasks 5 und 6), `IMPORTANCE_STATUS` (Task 2).
- Produces: `chunk(rows, size)` und `mergeRows(table, rows)` aus `scripts/importance-backfill.mjs`.

Warum ein eigenes Skript und nicht der Cron: `MemoryDB.update` erzeugt je Zeile eine LanceDB-Version. 23.000 Einzelversionen sind genau die Fragmentierung, die am 13.09.2026 zu Gateway-Blockaden von bis zu 143 Sekunden gefuehrt hat. `mergeInsert` in Stapeln zu 500 macht daraus etwa 46 Versionen.

- [ ] **Step 1: Write the failing test**

```js
// tests/importance-backfill.test.js
import { describe, it } from "node:test";
import assert from "node:assert";
import { chunk, buildBackfillRow } from "../scripts/importance-backfill.mjs";

describe("backfill batching", () => {
  it("cuts rows into batches of the given size", () => {
    assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepStrictEqual(chunk([], 500), []);
  });

  it("never lowers an existing strength", () => {
    const row = { id: "x", memoryStrength: 0.9, halfLifeDays: 180, importance: 0.7 };
    const patched = buildBackfillRow(row, { ok: true, importance: 0.2, emotion: { emotionalDominant: "neutral", emotionalIntensity: 0 }, reason: "" }, Date.now());
    assert.ok(patched.memoryStrength >= 0.9);
  });

  it("keeps the previous value for rollback", () => {
    const row = { id: "x", memoryStrength: 0.9, halfLifeDays: 180, importance: 0.7 };
    const patched = buildBackfillRow(row, { ok: true, importance: 0.2, emotion: { emotionalDominant: "neutral", emotionalIntensity: 0 }, reason: "" }, Date.now());
    assert.strictEqual(JSON.parse(patched.updateEvidence).previousImportance, 0.7);
    assert.strictEqual(patched.updateSource, "importance-v2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/importance-backfill.test.js`
Expected: FAIL — Modul fehlt.

- [ ] **Step 3: Write minimal implementation**

```js
#!/usr/bin/env node
/**
 * Phase 2 der Importance-Migration: arbeitet den Bestand in Stapeln auf.
 *
 * Laeuft als eigener Prozess, nicht im Gateway. LLM-Calls parallel mit Breite 8,
 * Schreiben ueber mergeInsert in Stapeln zu 500. Danach ist
 * scripts/lancedb-compact-once.mjs aufzurufen.
 *
 * Dry-Run ist Standard. `--apply` muss ausdruecklich gesetzt werden.
 */
import { buildRefinePatch, classifyEncoding } from "../lib/encoding-llm.js";
import { IMPORTANCE_STATUS } from "../lib/importance-status.js";

export const BATCH_SIZE = 500;
export const CONCURRENCY = 8;

export function chunk(rows = [], size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Vollstaendige Zeile fuer mergeInsert: bestehende Felder plus Patch. */
export function buildBackfillRow(row, encoding, now) {
  const patch = buildRefinePatch(row, encoding, now);
  if (!patch) return null;
  return {
    ...row,
    ...patch,
    memoryStrength: Math.max(Number(row.memoryStrength) || 0, Number(patch.memoryStrength ?? 0)),
    updateSource: "importance-v2",
    updateEvidence: JSON.stringify({ previousImportance: Number(row.importance), phase: 2 }),
  };
}

/** Ein Stapel, eine Version. */
export async function mergeRows(table, rows) {
  if (!rows.length) return 0;
  await table.mergeInsert("id").whenMatchedUpdateAll().execute(rows);
  return rows.length;
}
```

Hauptprogramm:

```js
const APPLY = process.argv.includes("--apply");
for (const agentId of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
  const table = await (await lancedb.connect(join(BASE, safeAgentId(agentId)))).openTable("memories");
  const pending = (await table.query().limit(100000).toArray())
    .filter((r) => String(r.importanceStatus ?? "") === IMPORTANCE_STATUS.PENDING_BACKFILL
      && String(r.status ?? "active") === "active");
  console.log(`${agentId}: ${pending.length} Zeilen offen, ${chunk(pending).length} Stapel`);
  if (!APPLY) continue;

  let done = 0, failed = 0;
  for (const batch of chunk(pending)) {
    const encoded = await pMap(batch, CONCURRENCY, async (row) => {
      const encoding = await classifyEncoding(String(row.text || "").slice(0, 2000), { agentId });
      return buildBackfillRow(row, encoding, Date.now());
    });
    const writable = encoded.filter(Boolean);
    failed += encoded.length - writable.length;
    done += await mergeRows(table, writable);
    console.log(`   ${done}/${pending.length} geschrieben, ${failed} offen geblieben`);
  }
}
```

`pMap` ist die begrenzte Parallelisierung; eine identische Fassung steht in `/root/plur1bus-bench/lib/common.mjs` und ist zu uebernehmen. Zeilen mit `ok:false` bleiben auf `pending_backfill` und kommen beim naechsten Lauf erneut dran. Nach dem Lauf: `node scripts/lancedb-compact-once.mjs <agent>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/importance-backfill.test.js`
Expected: PASS, 3 Tests.

- [ ] **Step 5: Pilotlauf**

Run: `node scripts/importance-backfill.mjs developer` (Dry-Run), dann nach Sichtung `node scripts/importance-backfill.mjs developer --apply`
Expected: 188 Zeilen, ein Stapel, danach `node scripts/lancedb-compact-once.mjs developer`.

- [ ] **Step 6: Commit**

```bash
git add scripts/importance-backfill.mjs tests/importance-backfill.test.js
git commit -m "feat(migration): Backfill in Stapeln statt Einzelversionen"
```

---

### Task 12: Die drei Verhaltenstests

**Files:**
- Create: `tests/memory-behaviour-scenarios.test.js`

**Interfaces:**
- Consumes: alle vorherigen Tasks.
- Produces: nichts. Dies ist die Abnahme des Vorhabens.

- [ ] **Step 1: Write the failing test**

```js
// tests/memory-behaviour-scenarios.test.js
import { describe, it } from "node:test";
import assert from "node:assert";
import { computeDecayedStrength, resolveHalfLifeFromEncoding, applyFlashbulbEncoding, applyRetrievalReinforcement } from "../lib/memory-dynamics.js";

const DAY = 86400000;
const now = Date.UTC(2026, 8, 19);
const RECALL_FLOOR = 0.15;

// Eine Erinnerung ist auffindbar, solange der Staerke-Term den Basiswert
// nicht unter recallMinScore drueckt: 0.6 + (strength - 1) >= 0.15.
const findable = (strength) => 0.6 + (strength - 1) >= RECALL_FLOOR;

describe("memory behaves like memory", () => {
  it("forgets the breakfast of two days ago", () => {
    // Beilaeufig kodiert, zusaetzlich durch dreizehn aehnliche Notizen geschwaecht.
    let strength = 1.0;
    for (let i = 0; i < 13; i++) strength *= 0.9;               // retroaktive Interferenz
    const halfLife = resolveHalfLifeFromEncoding(0.2);           // 30 Tage
    const decayed = computeDecayedStrength({ memoryStrength: strength, halfLifeDays: halfLife, lastDynamicsAt: now - 14 * DAY }, now);
    assert.strictEqual(findable(decayed), false, `breakfast still findable at ${decayed}`);
  });

  it("keeps a single intense event for ten years without a single recall", () => {
    const flash = applyFlashbulbEncoding({ emotionalIntensity: 0.95, importance: 0.85 }, now, 0.7, resolveHalfLifeFromEncoding(0.85));
    assert.ok(flash, "expected flashbulb encoding");
    const decayed = computeDecayedStrength(
      { memoryStrength: flash.memoryStrength, halfLifeDays: flash.halfLifeDays, lastDynamicsAt: now },
      now + 3650 * DAY,
    );
    assert.strictEqual(findable(decayed), true, `gunshot lost after ten years at ${decayed}`);
  });

  it("keeps a dull fact alive through use", () => {
    let row = { memoryStrength: 0.5, halfLifeDays: resolveHalfLifeFromEncoding(0.3), retrievalCount: 0, lastDynamicsAt: now };
    for (let i = 0; i < 20; i++) row = { ...row, ...applyRetrievalReinforcement(row, now) };
    const decayed = computeDecayedStrength(row, now + 365 * DAY);
    assert.strictEqual(findable(decayed), true, `used fact lost after a year at ${decayed}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/memory-behaviour-scenarios.test.js`
Expected: Mindestens der zweite Test schlaegt fehl, solange Task 4 nicht ausgeliefert ist.

- [ ] **Step 3: Parameter nachziehen, nicht die Tests**

Schlaegt ein Fall fehl, sind die Parameter aus Task 3 und Task 4 zu justieren — Halbwertszeiten, Blitzlicht-Schwelle, Interferenz-Faktor. Die drei Faelle sind die Abnahme und werden nicht abgeschwaecht. Die genauen Signaturen von `computeDecayedStrength` und `applyRetrievalReinforcement` sind vor dem Schreiben in `lib/memory-dynamics.js` nachzulesen; weichen die Feldnamen ab, ist der Test daran anzupassen, nicht das Verhalten.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/memory-behaviour-scenarios.test.js`
Expected: PASS, 3 Tests.

- [ ] **Step 5: Gesamte Suite, zweigeteilt**

Run: `node --test --test-concurrency=1 $(ls tests/*.test.js | grep -v 'auto-capture-batch') test/*.test.js`
dann: `node --test tests/auto-capture-batch.test.js`
Expected: PASS bis auf die sechs bekannten `local-inference`-Fehlschlaege.

- [ ] **Step 6: Benchmark als Leitplanke**

Run: `cd /root/plur1bus-bench && node ingest-capture.mjs locomo && node run.mjs locomo --db db-capture --tag nach-umbau --concurrency 8`
Expected: Innerhalb von zwei Punkten des Laufs `locomo-g56-fix` (49,9 %). Eine Verbesserung wird nicht erwartet.

- [ ] **Step 7: Commit**

```bash
git add tests/memory-behaviour-scenarios.test.js
git commit -m "test(memory): Frühstueck, Blitzlicht und Gebrauch als Abnahme"
```

---

### Task 13: Kennzahlen und Auslieferungsreihenfolge

**Files:**
- Create: `scripts/importance-metrics.mjs`
- Test: `tests/importance-metrics.test.js` (neu)

**Interfaces:**
- Consumes: nichts aus den Code-Tasks.
- Produces: `summarizeImportance(rows)` → `{ total, topValue, topShare, flashbulbShare, agentBand }`.

Dieser Task schliesst Phase 3 des Spec ab: Erst wenn die Kennzahlen nach dem
Backfill stimmen, werden Blitzlicht und Interferenz im Regelbetrieb belassen.
`applyRetroactiveInterference` ist bereits verdrahtet (`index.js:6826`) — hier
ist also nichts anzuschliessen, sondern zu pruefen, ob die Werte nach dem
Umbau plausibel bleiben.

- [ ] **Step 1: Write the failing test**

```js
// tests/importance-metrics.test.js
import { describe, it } from "node:test";
import assert from "node:assert";
import { summarizeImportance } from "../scripts/importance-metrics.mjs";

describe("importance metrics", () => {
  it("reports the dominant value and its share", () => {
    const rows = [
      ...Array.from({ length: 7 }, () => ({ importance: 0.7, status: "active" })),
      ...Array.from({ length: 3 }, () => ({ importance: 0.5, status: "active" })),
    ];
    const summary = summarizeImportance(rows);
    assert.strictEqual(summary.total, 10);
    assert.strictEqual(summary.topValue, "0.70");
    assert.ok(Math.abs(summary.topShare - 0.7) < 1e-9);
  });

  it("counts flashbulb and agent band separately", () => {
    const rows = [
      { importance: 0.5, halfLifeDays: 3650, status: "active" },
      { importance: 0.97, halfLifeDays: 36500, status: "active" },
      { importance: 0.5, halfLifeDays: 180, status: "active" },
      { importance: 0.9, halfLifeDays: 600, status: "deleted" },
    ];
    const summary = summarizeImportance(rows);
    assert.strictEqual(summary.total, 3);
    assert.ok(Math.abs(summary.flashbulbShare - 1 / 3) < 1e-9);
    assert.strictEqual(summary.agentBand, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/importance-metrics.test.js`
Expected: FAIL — Modul fehlt.

- [ ] **Step 3: Write minimal implementation**

```js
#!/usr/bin/env node
/**
 * Kennzahlen der Importance-Verteilung, read-only.
 *
 * Erwartung nach dem Umbau: kein Einzelwert ueber 25 Prozent (heute 71 Prozent
 * auf 0.70), Blitzlicht-Anteil unter 2 Prozent der neuen Erinnerungen.
 */
export function summarizeImportance(rows = []) {
  const active = rows.filter((r) => String(r?.status ?? "active") === "active");
  const counts = new Map();
  for (const row of active) {
    const key = Number(row.importance).toFixed(2);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const [topValue, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ["-", 0];
  const flashbulb = active.filter((r) => Number(r.halfLifeDays) === 3650).length;
  return {
    total: active.length,
    topValue,
    topShare: active.length ? topCount / active.length : 0,
    flashbulbShare: active.length ? flashbulb / active.length : 0,
    agentBand: active.filter((r) => Number(r.importance) >= 0.95).length,
  };
}
```

Das Hauptprogramm liest je Agent die Tabelle und gibt eine Zeile je Store aus:

```js
for (const agentId of process.argv.slice(2)) {
  const table = await (await lancedb.connect(join(BASE, safeAgentId(agentId)))).openTable("memories");
  const s = summarizeImportance(await table.query().limit(100000).toArray());
  console.log(`${agentId.padEnd(14)} n=${String(s.total).padStart(6)} haeufigster ${s.topValue} (${(100 * s.topShare).toFixed(1)}%)`
    + ` Blitzlicht ${(100 * s.flashbulbShare).toFixed(1)}% Agentenband ${s.agentBand}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/importance-metrics.test.js`
Expected: PASS, 2 Tests.

- [ ] **Step 5: Ausgangswerte festhalten, vor jeder Auslieferung**

Run: `node scripts/importance-metrics.mjs main bernhardine heisenberg developer`
Expected: Dokumentiert den Ist-Zustand (heute: `main` 71,1 Prozent auf 0,70). Die Ausgabe gehoert in den Commit-Text von Task 9.

- [ ] **Step 6: Auslieferungsreihenfolge**

Diese Reihenfolge ist bindend, sie ergibt sich aus den Abhaengigkeiten:

1. Tasks 1 bis 8 ausliefern (Code, ohne Wirkung auf den Bestand).
2. `scripts/importance-phase1-reset.mjs` mit `--apply` auf allen Stores.
3. Erst danach Task 10 ausliefern (`MANUAL_CORE_IMPORTANCE` auf 0,95).
4. `scripts/importance-backfill.mjs --apply`, Pilot `developer` zuerst, danach
   `lancedb-compact-once.mjs`.
5. Kennzahlen erneut erheben und mit den Ausgangswerten vergleichen.

- [ ] **Step 7: Commit**

```bash
git add scripts/importance-metrics.mjs tests/importance-metrics.test.js
git commit -m "feat(migration): Kennzahlen der Importance-Verteilung"
```

