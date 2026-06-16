# P3 Categorization / Importance / Fact-Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden memory categorization, fact-quality detection, and importance scoring so trivial/temporary/noisy facts are not over-promoted, while durable user preferences, project facts, corrections, and safety-relevant facts are categorized and weighted correctly.

**Architecture:** Add a deterministic, testable `lib/memory-fact-quality.js` classifier. Wire it into the existing categorization (`lib/categorize.js`) and store paths (`index.js` `storeMemoryFromToolParams` / `memory_store` tool / auto-capture) to clamp/downrank low-quality memories and preserve high-signal durable facts. Keep all changes behind the existing recall-decision-trace non-enumerable metadata so prompt output is unchanged by default.

**Tech Stack:** Node.js 20+, native `node:test`, LanceDB via `lib/db-adapter.js`, existing `lib/memory-merge-safety.js` text helpers.

---

## Non-goals

- No vector DB dimension change.
- No embedding model change.
- No LanceDB schema change.
- No DB migrations.
- No re-embedding of existing memories.
- No rewriting of historical memories.
- No deploy/protect/update script changes.
- No lint/test infrastructure changes.
- No removal of #49/#50/#51/#52/#53 safeguards.
- No new prompt trace output visible by default.

---

## Current behavior snapshot

### Categorization (`lib/categorize.js`)

- `MEMORY_CATEGORIES` enum: `preference, fact, decision, entity, reference, debug, config, conversation, knowledge, curated, other`.
- `categorizeMemory(text)` is a deterministic regex heuristic.
- Order: preference → decision → debug → config → reference → entity → fact → conversation.
- Weak `fact` trigger: matches almost every English sentence (`is /are /was /were /has /have /`) plus any 4-digit number.
- No structured reason returned; no tests exist for `categorizeMemory`.

### Importance

- All importance values are caller-provided or hardcoded defaults.
- `memory_store` tool / `storeMemoryFromToolParams`: default `0.5`.
- Auto-capture: hardcoded `0.7`.
- No content-derived scoring; no clamping at store time.
- `minimportance` filter maps to `memoryStrength`, not `importance`.

### Promotion

- KNOWLEDGE.md promotion queues `decision`/`fact` memories with `importance >= 0.7`.
- `computePromotionCandidate` blocks `fact`/`general` from class promotion.
- No explicit fact-quality guard blocks or downranks trivial/temporary inputs.

### Trace

- `lib/recall-decision-trace.js` supports `storeDecisions` and non-enumerable trace metadata.
- Trace rendering is gated by `decisionTrace.includeInPrompt === true` (default false).

---

## Known risks

1. Over-tuning German/English examples and losing generality.
2. Diverging the two parallel store paths (`storeMemoryFromToolParams` and `memory_store` tool execute).
3. Breaking auto-capture behavior if too aggressive.
4. Changing recall ranking by altering importance defaults.
5. Prompt-output change if trace attributes are added incorrectly.
6. Half-life map categories (`general`, `person`, `work`, `project`) are outside `MEMORY_CATEGORIES` enum.

---

## Proposed fact-quality model

New file: `lib/memory-fact-quality.js`.

Exports:

- `classifyFactDurability(text, context = {})`
- `detectTrivialMemory(text, context = {})`
- `detectTemporaryMemory(text, context = {})`
- `detectDurablePreference(text, context = {})`
- `detectProjectFact(text, context = {})`
- `detectCorrectionSignal(text, context = {})`
- `normalizeImportanceScore(score, reasons = [], opts = {})`
- `explainFactQuality(text, context = {})`

Each returns structured reasons. `explainFactQuality` returns:

```js
{
  durability: "durable" | "temporary" | "ephemeral" | "unknown",
  categoryHints: ["preference", "project", "correction", "security"],
  importanceBand: "low" | "medium" | "high" | "critical",
  shouldPromote: true,
  shouldDownrank: false,
  reasons: [
    "explicit durable preference",
    "project-specific named entity",
    "contains temporary marker: today"
  ]
}
```

Signals:

- **Durable:** explicit "from now on", "remember", "always", "never", user preference verbs, project architecture decisions, concrete security/deploy/auth facts, corrections.
- **Temporary / low value:** "today", "tomorrow", "right now", "currently downloading", "test run finished", transient status logs, one-off command output, vague emotion without durable preference, chat filler.
- **Trivial:** "ok", "yes", "go on", "weiter", "mach", "danke", generic facts without subject, accidental single-word fragments.
- **Correction:** "not X anymore", "instead of X", "no longer", "jetzt ... statt ...", "statt ... nun ...", explicit correction syntax.
- **Security/deploy:** concrete mentions of auth bypass, vulnerability fix, deploy target, node version, infrastructure component with a factual claim.

No LLM. Deterministic regex/token rules. Testable.

---

## Proposed category/importance guards

### `lib/categorize.js`

1. Add `categorizeMemoryWithReason(text)` returning `{ category, reason }`.
2. Keep `categorizeMemory(text)` as backwards-compatible wrapper returning `category`.
3. Strengthen rules:
   - Explicit preference markers and first-person preference verbs → `preference`.
   - Project/tech architecture decisions → `decision`.
   - Concrete security/auth/deploy facts → `decision` or `config` depending on content.
   - Festival/event/project names like "Dreamdale ist ein Festival" → `entity` or `fact` (not fictional location).
   - Correction/update signals → `decision` (because it is a change decision).
   - Transient status with "today/tomorrow/right now" → `conversation`.
   - Single generic words / acknowledgements → `conversation`.
4. Add rule reasons to each returned category.

### `index.js` store paths

1. After computing `category`, call `explainFactQuality(text, { category, origin, explicitImportance: params.importance })`.
2. Clamp importance:
   - Trivial/ephemeral → clamp to `[0, 0.25]`.
   - Temporary/status without explicit remember → clamp to `[0, 0.45]`.
   - Durable preference → boost floor to `0.55` if caller importance is missing or lower.
   - Project architecture / concrete security → boost floor to `0.65` if missing/lower.
   - Explicit "remember this" / correction → boost floor to `0.7` if missing/lower.
3. Never exceed `1.0`; never go below `0`.
4. Preserve caller-provided explicit high importance.
5. Record `factQuality`, `importanceReason`, `categoryReason` in trace `storeDecisions` (invisible by default).
6. Apply same logic to:
   - `storeMemoryFromToolParams` (internal/Obsidian bridge)
   - `memory_store` tool `execute`
   - Auto-capture loop

### Promotion guard

1. In store paths, if `factQuality.shouldPromote === false` and no explicit `params.importance` is provided, store but clamp importance low.
2. If `factQuality.durability === "ephemeral"` and no explicit importance, do not queue for KNOWLEDGE.md promotion.
3. Keep stableContentHash dedup logic unchanged.

---

## Integration points

| File | Change |
|------|--------|
| `lib/memory-fact-quality.js` | New deterministic classifier. |
| `lib/categorize.js` | Add reason-returning variant; tighten rules. |
| `index.js:1845-1847` | Use `categorizeMemoryWithReason`, call fact-quality, clamp importance. |
| `index.js:3698-3700` | Same for `memory_store` tool. |
| `index.js:3255, 3269` | Apply fact-quality + clamping to auto-capture. |
| `lib/recall-decision-trace.js` | Optionally enrich `addTraceStoreDecision` reason with `factQuality` (no schema change required). |

---

## Test plan

New tests:

- `tests/memory-fact-quality.test.js`
- `tests/memory-categorization-safety.test.js`
- `tests/memory-importance-safety.test.js`
- `tests/memory-promotion-quality.test.js`

Minimum coverage:

- Fact quality: trivial, temporary, durable preference, project fact, correction, explicit remember.
- Categorization: durable preference, project architecture, correction, Dreamdale festival, generic technical keyword.
- Importance: trivial low, temporary low, durable preference medium/high, project architecture medium/high, security/deploy high, emotion-only not high, explicit remember high, correction high enough.
- Promotion: filler not strong, temporary not strong, durable instruction promotes, correction promotes with explanation.

Regression:

- Existing #49/#50/#51/#52/#53 tests remain green.
- No vector DB dimension change.
- No embedding model change.
- No LanceDB schema change.
- No DB migration.
- No deploy/lint/test infra changes.

---

## Vector/DB invariance statement

This plan makes no changes to:

- Vector dimensions
- Embedding model selection
- LanceDB table schema
- Existing DB migrations
- Stored memory vectors
- Historical memory rows

Only new in-memory metadata and in-line importance clamping are introduced.

---

## Rollout risk

Low. Changes are additive and conservative:

- Default importance values are only adjusted downward for low-quality inputs.
- Caller-provided explicit importance is preserved.
- No DB schema changes.
- Trace metadata is non-enumerable and invisible in prompts by default.

Risk if too aggressive: auto-capture may drop transient but useful operational context. Mitigation: only clamp when no explicit importance is given and leave `conversation` category available.
