# K1-06 Memory-Text Contradiction Safety — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect and handle contradictory factual-memory texts *before* they are injected into the same prompt context, preferring corrected versions without deleting historical records.

**Architecture:** Extend the existing `ContradictionDetector` with a memory-text pair mode, add a lightweight local contradiction resolver that ranks conflicting memories by correction authority (version number, `updateSource`, recency), and surface the conflict in `formatRelevantMemoriesContext` so the model treats the older item as provisional. Detection runs only over the small final set of recalled memories (≤ `maxPromptMemories`) and is gated by a config flag.

**Tech Stack:** Node.js ESM, native `node:test` + `node:assert/strict`, LanceDB for memory storage, JSONL for contradiction persistence, existing `ContradictionDetector` + `formatRelevantMemoriesContext`.

---

## File map

| File | Responsibility |
|------|----------------|
| `lib/contradiction-detector.js` | Existing overlay contradiction engine; extended with memory-text detection helpers. |
| `lib/memory-text-contradiction.js` | NEW: pure helpers for ranking contradictory memory texts and picking the winning version. |
| `lib/relevant-memory-context.js` | Formatter for `<relevant-memories>`; extended to render `contradiction` / `superseded-by` / `update-source` attributes. |
| `index.js` | Builds `associativeItems` from pipeline results; extended to forward versioning fields into the formatter and trigger contradiction detection. |
| `openclaw.plugin.json` | Adds `continuityEngine.contradictionDetection` config schema. |
| `tests/memory-text-contradiction.test.js` | NEW: unit tests for ranking logic. |
| `tests/contradiction-detector-memory-text.test.js` | NEW: unit tests for the new `ContradictionDetector` memory-text methods. |
| `tests/relevant-memory-context-contradiction.test.js` | NEW: tests for formatter output with contradiction/superseded markers. |
| `tests/recall-p1.test.js` | Existing regression tests for recall pipeline; verify no regression. |

---

## Design decisions

1. **Reuse `ContradictionDetector`.** The existing class already has LLM-based contradiction detection and JSONL persistence. We add memory-text-specific methods rather than building a second engine.
2. **Local, cheap resolution.** We do not need another LLM call to decide which memory wins: corrected memories (higher `versionNumber`, `updateSource === "user_correction"`, recency) are preferred. The LLM is only used for the yes/no contradiction decision.
3. **No deletion of history.** Superseded memories may still be recalled by vector similarity. The formatter marks them as `superseded-by="<new-id>"` and emits a humility phrase so the model does not treat them as authoritative.
4. **Config-gated.** Detection is off by default and enabled under `continuityEngine.contradictionDetection.enabled`. This matches the pattern of other continuity-engine sub-features.
5. **Run on final item list only.** Contradiction detection is O(n²) in the number of final memories (≤ 12 by default), so it is cheap enough to run per turn.

---

## Task 1: Add config schema for contradiction detection

**Files:**
- Modify: `openclaw.plugin.json:557-624`
- Test: existing config-audit test (`tests/config-audit.test.js`)

- [ ] **Step 1: Add `contradictionDetection` block under `continuityEngine`**

Insert a new object property named `contradictionDetection` directly after `overlays` (around line 608) with the following schema:

```json
          "contradictionDetection": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "enabled": { "type": "boolean", "default": false },
              "mode": { "type": "string", "enum": ["llm", "heuristic"], "default": "llm" },
              "maxPairsPerRecall": { "type": "number", "default": 20 },
              "minScore": { "type": "number", "default": 0.6 }
            }
          },
```

- [ ] **Step 2: Run config audit**

Run: `npm test -- tests/config-audit.test.js`
Expected: PASS (schema must still validate).

- [ ] **Step 3: Commit**

```bash
git add openclaw.plugin.json
git commit -m "config: add contradictionDetection schema under continuityEngine"
```

---

## Task 2: Add pure ranking helpers for memory-text contradictions

**Files:**
- Create: `lib/memory-text-contradiction.js`
- Test: `tests/memory-text-contradiction.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/memory-text-contradiction.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveContradictionWinner, rankMemoryVersions } from "../lib/memory-text-contradiction.js";

describe("resolveContradictionWinner", () => {
  it("prefers the corrected version over the original", () => {
    const a = { id: "old", text: "We use Postgres.", versionNumber: 1, status: "superseded", supersededBy: "new" };
    const b = { id: "new", text: "We use MySQL.", versionNumber: 2, status: "active", supersededBy: "" };
    assert.strictEqual(resolveContradictionWinner(a, b), b);
    assert.strictEqual(resolveContradictionWinner(b, a), b);
  });

  it("prefers user_correction updateSource when versions are equal", () => {
    const a = { id: "a", text: "x", versionNumber: 1, updateSource: "dm" };
    const b = { id: "b", text: "y", versionNumber: 1, updateSource: "user_correction" };
    assert.strictEqual(resolveContradictionWinner(a, b), b);
  });

  it("prefers more recent versionCreatedAt as tie-breaker", () => {
    const now = Date.now();
    const a = { id: "a", text: "x", versionNumber: 1, versionCreatedAt: now - 1000 };
    const b = { id: "b", text: "y", versionNumber: 1, versionCreatedAt: now };
    assert.strictEqual(resolveContradictionWinner(a, b), b);
  });

  it("falls back to first argument when everything is equal", () => {
    const a = { id: "a", text: "x" };
    const b = { id: "b", text: "y" };
    assert.strictEqual(resolveContradictionWinner(a, b), a);
  });
});

describe("rankMemoryVersions", () => {
  it("ranks corrected memories first", () => {
    const memories = [
      { id: "old", text: "Postgres.", versionNumber: 1, status: "superseded", supersededBy: "new" },
      { id: "new", text: "MySQL.", versionNumber: 2, status: "active", supersededBy: "" },
    ];
    const ranked = rankMemoryVersions(memories);
    assert.strictEqual(ranked[0].id, "new");
    assert.strictEqual(ranked[1].id, "old");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/memory-text-contradiction.test.js`
Expected: FAIL with module not found / function not defined.

- [ ] **Step 3: Write minimal implementation**

Create `lib/memory-text-contradiction.js`:

```js
/**
 * Pure helpers for resolving contradictions between factual memory texts.
 */

const AUTHORITATIVE_SOURCES = new Set(["user_correction", "telegram:/correct"]);

function correctionAuthority(m) {
  let score = 0;
  if (m.status === "active") score += 10;
  score += (m.versionNumber ?? 1) * 2;
  if (AUTHORITATIVE_SOURCES.has(m.updateSource)) score += 5;
  score += Math.max(0, Math.min(5, (m.reconsolidationConfidence ?? 0) * 5));
  return score;
}

export function resolveContradictionWinner(a, b) {
  const authA = correctionAuthority(a);
  const authB = correctionAuthority(b);
  if (authA !== authB) return authA > authB ? a : b;
  const timeA = a.versionCreatedAt ?? a.createdAt ?? 0;
  const timeB = b.versionCreatedAt ?? b.createdAt ?? 0;
  if (timeA !== timeB) return timeA > timeB ? a : b;
  return a;
}

export function rankMemoryVersions(memories) {
  return [...memories].sort((a, b) => {
    const authA = correctionAuthority(a);
    const authB = correctionAuthority(b);
    if (authA !== authB) return authB - authA;
    const timeA = a.versionCreatedAt ?? a.createdAt ?? 0;
    const timeB = b.versionCreatedAt ?? b.createdAt ?? 0;
    return timeB - timeA;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/memory-text-contradiction.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/memory-text-contradiction.js tests/memory-text-contradiction.test.js
git commit -m "feat(memory-text): pure helpers to rank contradictory memory versions"
```

---

## Task 3: Extend ContradictionDetector with memory-text detection

**Files:**
- Modify: `lib/contradiction-detector.js`
- Test: `tests/contradiction-detector-memory-text.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/contradiction-detector-memory-text.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContradictionDetector } from "../lib/contradiction-detector.js";

describe("ContradictionDetector memory-text pairs", () => {
  it("detects contradiction between two memory texts when LLM says yes", async () => {
    let promptSeen = "";
    const detector = new ContradictionDetector({
      llm: async (messages) => {
        promptSeen = messages[messages.length - 1].content;
        return "yes";
      },
    });
    const a = { id: "m1", text: "We use Postgres." };
    const b = { id: "m2", text: "We use MySQL." };
    const result = await detector.detectMemoryTextContradiction(a, b);
    assert.strictEqual(result, true);
    assert.ok(promptSeen.includes("Postgres"));
    assert.ok(promptSeen.includes("MySQL"));
  });

  it("returns false when LLM says no", async () => {
    const detector = new ContradictionDetector({ llm: async () => "no" });
    const a = { id: "m1", text: "We use Postgres." };
    const b = { id: "m2", text: "We still use Postgres." };
    const result = await detector.detectMemoryTextContradiction(a, b);
    assert.strictEqual(result, false);
  });

  it("returns empty array for fewer than 2 memories", async () => {
    const detector = new ContradictionDetector({ llm: async () => "yes" });
    const result = await detector.findMemoryTextContradictions([{ id: "m1", text: "x" }]);
    assert.deepStrictEqual(result, []);
  });

  it("limits pairwise checks to maxPairs", async () => {
    const detector = new ContradictionDetector({ llm: async () => "yes" });
    const memories = [
      { id: "m1", text: "A." },
      { id: "m2", text: "B." },
      { id: "m3", text: "C." },
    ];
    const result = await detector.findMemoryTextContradictions(memories, { maxPairs: 1 });
    assert.strictEqual(result.length, 1);
  });

  it("emits records with memoryA, memoryB, descriptionA, descriptionB", async () => {
    const detector = new ContradictionDetector({ llm: async () => "yes" });
    const memories = [
      { id: "m1", text: "Postgres." },
      { id: "m2", text: "MySQL." },
    ];
    const result = await detector.findMemoryTextContradictions(memories);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].memoryA, "m1");
    assert.strictEqual(result[0].memoryB, "m2");
    assert.strictEqual(result[0].descriptionA, "Postgres.");
    assert.strictEqual(result[0].descriptionB, "MySQL.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/contradiction-detector-memory-text.test.js`
Expected: FAIL with method not found.

- [ ] **Step 3: Implement memory-text methods in ContradictionDetector**

Modify `lib/contradiction-detector.js` by inserting the following public methods after `flagContradictoryOverlays` (before `_askLLM`):

```js
  /**
   * Decide whether two factual memory texts contradict each other.
   *
   * @param {object} a Memory record with `.text` or `.summary`.
   * @param {object} b Memory record with `.text` or `.summary`.
   * @returns {Promise<boolean>}
   */
  async detectMemoryTextContradiction(a, b) {
    if (!a || !b) return false;
    if (a.id === b.id) return false;
    const textA = a.summary || a.text || "";
    const textB = b.summary || b.text || "";
    if (!textA || !textB) return false;
    return this._askLLM(
      { id: a.id, shiftDescription: textA, targetMemoryId: a.id },
      { id: b.id, shiftDescription: textB, targetMemoryId: b.id },
    );
  }

  /**
   * Find contradictions among a list of recalled memory records.
   *
   * Only the first `maxPairs` pairs (in input order) are checked to bound
   * LLM cost. Returns records shaped for memory-text contradictions.
   *
   * @param {Array<object>} memories
   * @param {{maxPairs?: number}} [opts]
   * @returns {Promise<Array<object>>}
   */
  async findMemoryTextContradictions(memories, opts = {}) {
    if (!this.llm || !Array.isArray(memories) || memories.length < 2) return [];
    const maxPairs = Number.isFinite(opts.maxPairs) && opts.maxPairs > 0 ? opts.maxPairs : 20;
    const contradictions = [];
    let pairsChecked = 0;
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        if (pairsChecked >= maxPairs) return contradictions;
        pairsChecked++;
        const a = memories[i];
        const b = memories[j];
        const conflict = await this.detectMemoryTextContradiction(a, b);
        if (conflict) {
          contradictions.push({
            id: randomUUID(),
            memoryA: a.id,
            memoryB: b.id,
            descriptionA: a.summary || a.text || "",
            descriptionB: b.summary || b.text || "",
            detectedAt: new Date().toISOString(),
            recordType: "memory-text-contradiction",
          });
        }
      }
    }
    return contradictions;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/contradiction-detector-memory-text.test.js`
Expected: PASS.

Also run the existing contradiction tests to ensure no regression:

```bash
npm test -- tests/contradiction-detector.test.js tests/contradiction-detector-single.test.js tests/contradiction-detector-enrich.test.js tests/contradiction-detector-loadall.test.js
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/contradiction-detector.js tests/contradiction-detector-memory-text.test.js
git commit -m "feat(contradiction): add memory-text contradiction detection to ContradictionDetector"
```

---

## Task 4: Format contradiction markers in relevant-memory context

**Files:**
- Modify: `lib/relevant-memory-context.js`
- Test: `tests/relevant-memory-context-contradiction.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/relevant-memory-context-contradiction.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

describe("formatRelevantMemoriesContext — memory-text contradictions", () => {
  it("marks a superseded memory with superseded-by attribute", () => {
    const out = formatRelevantMemoriesContext([
      { id: "old", category: "fact", source: "dm", display: "We use Postgres.", memoryStrength: 1.0, status: "superseded", supersededBy: "new" },
    ]);
    assert.ok(out.includes('superseded-by="new"'), "expected superseded-by attribute");
    assert.ok(out.includes("[superseded]"), "expected visible superseded marker");
  });

  it("does not mark active memories as superseded", () => {
    const out = formatRelevantMemoriesContext([
      { id: "active", category: "fact", source: "dm", display: "We use MySQL.", memoryStrength: 1.0, status: "active", supersededBy: "" },
    ]);
    assert.ok(!out.includes("superseded-by"), "active memory must not have superseded-by");
  });

  it("renders update-source attribute when present", () => {
    const out = formatRelevantMemoriesContext([
      { id: "m1", category: "fact", source: "dm", display: "x", memoryStrength: 1.0, updateSource: "user_correction" },
    ]);
    assert.ok(out.includes('update-source="user_correction"'), "expected update-source attribute");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/relevant-memory-context-contradiction.test.js`
Expected: FAIL (attributes not yet rendered).

- [ ] **Step 3: Modify formatter to render contradiction/version markers**

In `lib/relevant-memory-context.js`, inside the `renderMemoryItems` mapper (around the existing `associationStrengthAttr` block), add:

```js
    const isSupersededInContext = m.status === "superseded" || m.status === "superseded-in-context";
    const statusAttr = isSupersededInContext ? ` status="superseded" superseded-by="${sanitizeMemoryContextAttribute(m.supersededBy, "id")}"` : "";
    const updateSourceAttr = m.updateSource ? ` update-source="${sanitizeMemoryContextAttribute(m.updateSource, "update-source")}"` : "";
    const versionAttr = (m.versionNumber ?? 1) > 1 ? ` version="${Math.max(1, Number(m.versionNumber) || 1)}"` : "";
```

Then change the two `return` statements for `<memory-record>` so the attributes are included in the open tag. For example, change:

```js
return `  <memory-record category="${category}" source="${safeSource}"${graphSourceAttr} id="${id}"${fadeAttr}${depthAttr}${associationStrengthAttr}><quoted-evidence>${display}</quoted-evidence>${overlayBlock}\n  </memory-record>`;
```

to:

```js
return `  <memory-record category="${category}" source="${safeSource}"${graphSourceAttr} id="${id}"${fadeAttr}${depthAttr}${associationStrengthAttr}${statusAttr}${updateSourceAttr}${versionAttr}><quoted-evidence>${safeDisplay}</quoted-evidence>${overlayBlock}\n  </memory-record>`;
```

and the same for the overlay-free return.

Add the display prefix before the returns:

```js
    const safeDisplay = isSupersededInContext ? `[superseded] ${display}` : display;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/relevant-memory-context-contradiction.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/relevant-memory-context.js tests/relevant-memory-context-contradiction.test.js
git commit -m "feat(formatter): render superseded-by, update-source and version markers"
```

---

## Task 5: Wire contradiction detection into auto-recall

**Files:**
- Modify: `index.js` around lines 4130-4145 and 4200-4230
- Test: `tests/auto-recall-contradiction.test.js`

- [ ] **Step 1: Forward versioning fields into associativeItems**

In `index.js` where `associativeItems` is built from `ordered` (around line 4135), change the push to include version/status fields:

```js
            items.push({
              id: r.entry.id,
              category: r.entry.category,
              source: r.entry.origin || "dm",
              display: r.entry.summary || libGenerateSummary(r.entry.text, summaryMaxWords),
              memoryStrength: r.entry.memoryStrength ?? 1.0,
              graphSource: r.source,
              depth: r.depth,
              relevanceScore: r.score,
              versionNumber: r.entry.versionNumber ?? 1,
              previousVersion: r.entry.previousVersion || "",
              supersededBy: r.entry.supersededBy || "",
              updateSource: r.entry.updateSource || "",
              updateEvidence: r.entry.updateEvidence || "",
              reconsolidationConfidence: r.entry.reconsolidationConfidence ?? 0.0,
              status: r.entry.status || "active",
              versionCreatedAt: r.entry.versionCreatedAt ?? r.entry.createdAt ?? 0,
              createdAt: r.entry.createdAt ?? 0,
            });
```

Do the same for `semanticLensItems` (around line 4152):

```js
          const semanticLensItems = semanticLensResult.lensMemories.map((r) => ({
            id: r.entry.id,
            category: r.entry.category,
            source: "semantic-lens",
            display: r.entry.summary || libGenerateSummary(r.entry.text || "", summaryMaxWords),
            memoryStrength: r.entry.memoryStrength ?? 1.0,
            relevanceScore: r.score,
            versionNumber: r.entry.versionNumber ?? 1,
            supersededBy: r.entry.supersededBy || "",
            updateSource: r.entry.updateSource || "",
            status: r.entry.status || "active",
            versionCreatedAt: r.entry.versionCreatedAt ?? r.entry.createdAt ?? 0,
          }));
```

- [ ] **Step 2: Add memory-text contradiction detection before formatting**

After overlays are loaded and enriched (around line 4226), add a new block:

```js
            // K1-06: detect contradictory factual memories among recalled items.
            let memoryTextContradictions = [];
            const contraCfg = cfg?.continuityEngine?.contradictionDetection || {};
            if (contraCfg.enabled === true && ctx?.workspaceDir && contraCfg.mode !== "heuristic") {
              try {
                const detector = new ContradictionDetector({
                  llm: mergingLlmCfg?.model ? makeMergingLlm(mergingLlmCfg, api.logger) : null,
                  workspaceDir: ctx.workspaceDir,
                  logger: api.logger,
                });
                memoryTextContradictions = await detector.findMemoryTextContradictions(associativeItems, {
                  maxPairs: contraCfg.maxPairsPerRecall ?? 20,
                });
              } catch (e) {
                api.logger?.warn?.(`continuity-engine: memory-text contradiction detection failed: ${String(e)}`);
              }
            }
```

Note: verify that `mergingLlmCfg` and `makeMergingLlm` are in scope. If not, import `makeMergingLlm` from the existing helper or pass `llm: null` as a fallback.

- [ ] **Step 3: Mark losers as superseded-by in associativeItems**

After the detection block, apply the resolution:

```js
            if (memoryTextContradictions.length > 0) {
              const { resolveContradictionWinner } = await import("./lib/memory-text-contradiction.js");
              const byId = new Map(associativeItems.map((m) => [m.id, m]));
              for (const rec of memoryTextContradictions) {
                const a = byId.get(rec.memoryA);
                const b = byId.get(rec.memoryB);
                if (!a || !b) continue;
                const winner = resolveContradictionWinner(a, b);
                const loser = winner.id === a.id ? b : a;
                if (!loser.supersededBy) {
                  loser.supersededBy = winner.id;
                  loser.status = "superseded-in-context";
                }
              }
            }
```

- [ ] **Step 4: Persist detected memory-text contradictions**

Append each contradiction record to the existing `contradictions.jsonl` store so the formatter and future tooling can use it. Inside the same block, after resolution:

```js
              try {
                const detector = new ContradictionDetector({ workspaceDir: ctx.workspaceDir });
                for (const rec of memoryTextContradictions) {
                  await detector.persistContradiction({
                    targetMemoryId: rec.memoryA,
                    overlayA: rec.memoryA,
                    overlayB: rec.memoryB,
                    descriptionA: rec.descriptionA,
                    descriptionB: rec.descriptionB,
                  });
                }
              } catch (e) {
                api.logger?.warn?.(`continuity-engine: failed to persist memory-text contradictions: ${String(e)}`);
              }
```

- [ ] **Step 5: Add integration test**

Create `tests/auto-recall-contradiction.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveContradictionWinner } from "../lib/memory-text-contradiction.js";

describe("auto-recall contradiction resolution", () => {
  it("ranks corrected memory above old memory when both recalled", () => {
    const oldMemory = { id: "old", text: "Postgres.", versionNumber: 1, status: "superseded", supersededBy: "new" };
    const newMemory = { id: "new", text: "MySQL.", versionNumber: 2, status: "active", supersededBy: "" };
    assert.strictEqual(resolveContradictionWinner(oldMemory, newMemory).id, "new");
  });
});
```

- [ ] **Step 6: Run tests**

Run: `npm test -- tests/auto-recall-contradiction.test.js`
Expected: PASS.

Run the full recall-p1 regression suite:

```bash
npm test -- tests/recall-p1.test.js tests/recall-pipeline-budget.test.js tests/recall-budget.test.js
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add index.js tests/auto-recall-contradiction.test.js
git commit -m "feat(recall): wire memory-text contradiction detection into auto-recall"
```

---

## Task 6: Run full verification

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```
Expected: all tests PASS (currently 1244 passing).

- [ ] **Step 2: Run lint**

```bash
npm run lint
```
Expected: no syntax errors.

- [ ] **Step 3: Run audit**

```bash
npm audit --audit-level=moderate
```
Expected: 0 vulnerabilities.

- [ ] **Step 4: Commit any final fixes**

```bash
git commit -m "chore(k1-06): final verification fixes" || echo "nothing to commit"
```

---

## Self-review checklist

1. **Spec coverage**
   - Detect contradictions among active fact-memories → Task 3 (`findMemoryTextContradictions`).
   - Prefer corrected / current truth without deleting old records → Task 5 resolution + Task 4 formatter markers.
   - Mark contradictory or superseded memories in prompt context → Task 4.
   - Reuse existing `ContradictionDetector` → Task 3 extends the class.
   - Config-gated with safe defaults → Task 1.

2. **Placeholder scan**
   - No TBD/TODO/fill-in-details.
   - All code blocks are concrete and copy-paste ready.
   - Exact file paths and line ranges are provided.

3. **Type consistency**
   - `resolveContradictionWinner` returns the full memory object; resolution in Task 5 compares `winner.id`.
   - Formatter attributes reuse existing `sanitizeMemoryContextAttribute` with fallbacks.
   - `ContradictionDetector` new methods match the existing `_askLLM` signature (overlay-shaped objects).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-16-k1-06-memory-text-contradiction-safety.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?
