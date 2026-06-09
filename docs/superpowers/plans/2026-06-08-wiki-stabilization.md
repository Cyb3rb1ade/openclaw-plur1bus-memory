# /wiki Command Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the semantic and safety gaps in the existing `/wiki` command: tag wiki entries with `memoryKind: "wiki"`, implement wiki-first search with memory fallback, and restrict delete to wiki-only entries.

**Architecture:** Three targeted function rewrites in `lib/wiki-command.js` — `wikiAdd`, `wikiSearch`, `wikiDelete` — plus three new i18n keys and a new smoke test file. A private `searchByKind()` helper (DB-filter-first, overfetch-fallback) eliminates duplicate filtering logic. No changes to `index.js`, the LanceDB extension, or the database schema.

**Tech Stack:** Node.js 22 ESM, `node --test` (built-in runner), `@lancedb/lancedb ^0.26.2`, `lib/score.js` (`distanceToScore`)

---

## File Map

| File | Change |
|---|---|
| `lib/i18n-dictionary.js` | Add 3 keys: `wiki.result_wiki`, `wiki.result_fallback`, `wiki.delete_not_wiki` |
| `lib/wiki-command.js` | Replace `runRecallPipeline` import with `distanceToScore`; add `searchByKind()` + `synthesizeAnswer()` helpers; fix `wikiAdd()`; rewrite `wikiSearch()`; rewrite `wikiDelete()` |
| `tests/smoke-wiki-command.test.js` | Create — 6 unit tests with mocked DB |

---

### Task 1: Add i18n keys

**Files:**
- Modify: `lib/i18n-dictionary.js:526-529` (after `wiki.unauthorized`)

- [ ] **Step 1: Add the 3 new keys after `wiki.unauthorized`**

In `lib/i18n-dictionary.js`, find the `wiki.unauthorized` block (ends at line ~529) and insert immediately after:

```javascript
  "wiki.result_wiki": {
    de: { default: "📖 {{query}} (Wiki)\n\n{{answer}}" },
    en: { default: "📖 {{query}} (Wiki)\n\n{{answer}}" },
  },
  "wiki.result_fallback": {
    de: { default: "📖 {{query}}\n\n_Kein kuratierter Wiki-Eintrag gefunden. Synthese aus normalen Erinnerungen:_\n\n{{answer}}" },
    en: { default: "📖 {{query}}\n\n_No curated wiki entry found. Synthesizing from normal memories:_\n\n{{answer}}" },
  },
  "wiki.delete_not_wiki": {
    de: { default: "Kein löschbarer Wiki-Eintrag gefunden für: {{query}}\nNormale Erinnerungen werden von /wiki delete nicht gelöscht." },
    en: { default: "No deletable wiki entry found for: {{query}}\nNormal memories cannot be deleted via /wiki delete." },
  },
```

- [ ] **Step 2: Verify i18n smoke test still passes**

```bash
node --test tests/smoke-i18n.test.js
```

Expected: 0 failures.

- [ ] **Step 3: Commit**

```bash
git add lib/i18n-dictionary.js
git commit -m "feat(wiki): add result_wiki, result_fallback, delete_not_wiki i18n keys"
```

---

### Task 2: Write failing tests

**Files:**
- Create: `tests/smoke-wiki-command.test.js`

- [ ] **Step 1: Create the test file**

Create `tests/smoke-wiki-command.test.js` with this exact content:

```javascript
/**
 * tests/smoke-wiki-command.test.js
 *
 * Unit tests for /wiki command — wikiAdd, wikiSearch, wikiDelete.
 * All DB I/O is mocked; no real LanceDB instance.
 */
import { describe, it } from "node:test";
import assert from "node:assert";

import { runWikiCommand } from "../lib/wiki-command.js";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeTable({
  wikiRows = [],
  memoryRows = [],
  supportsWhere = true,
  deleteSpy = async () => {},
} = {}) {
  return {
    vectorSearch: () => {
      const builder = {
        limit: (n) => ({
          toArray: async () => [...wikiRows, ...memoryRows].slice(0, n),
        }),
      };
      if (supportsWhere) {
        builder.where = (clause) => ({
          limit: (n) => ({
            toArray: async () =>
              clause.includes("'wiki'") && !clause.includes("'memory'")
                ? wikiRows.slice(0, n)
                : memoryRows.slice(0, n),
          }),
        });
      }
      return builder;
    },
    delete: deleteSpy,
    query: () => ({
      where: () => ({ limit: () => ({ toArray: async () => [] }) }),
    }),
  };
}

function makeDb({
  wikiRows = [],
  memoryRows = [],
  supportsWhere = true,
  deleteSpy = async () => {},
  getByIdFn = async () => null,
  storeSpy = async () => {},
} = {}) {
  return {
    init: async () => {},
    table: makeTable({ wikiRows, memoryRows, supportsWhere, deleteSpy }),
    getById: getByIdFn,
    findSimilar: async () => [],
    store: storeSpy,
    search: async () => [],
  };
}

function makeCtx(args, extra = {}) {
  return {
    args,
    agentId: "test-agent",
    messages: [],
    workspaceDir: null,
    userId: "test-user-42",
    chatId: "test-chat-42",
    ...extra,
  };
}

function makeDeps(db, { callLlm } = {}) {
  return {
    pool: { getDb: () => db },
    embeddings: { embed: async () => new Float32Array(4).fill(0.1) },
    reranker: null,
    callLlm: callLlm ?? (async () => "synthesized answer"),
    cfg: { security: { allowedUserIds: ["test-user-42"] } },
    api: { logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } },
    llmCfg: { model: "test-model", maxTokens: 400 },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("wiki-command smoke", () => {
  it("wikiAdd stores entry with memoryKind: 'wiki'", async () => {
    const stored = [];
    const db = makeDb({ storeSpy: async (entry) => { stored.push(entry); } });
    const result = await runWikiCommand(makeCtx("add Kimi API: Der Key endet auf wKxqM"), makeDeps(db));
    assert.ok(!result.text.includes("Fehler") && !result.text.includes("error"), `unexpected error: ${result.text}`);
    assert.strictEqual(stored.length, 1, "store should have been called once");
    assert.strictEqual(stored[0].memoryKind, "wiki", "memoryKind must be 'wiki'");
  });

  it("wikiDelete removes a wiki entry by query", async () => {
    const deleted = [];
    const wikiRows = [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", memoryKind: "wiki", _distance: 0.3,
        status: "active", text: "Kimi wiki entry", summary: "[Wiki] Kimi" },
    ];
    const db = makeDb({
      wikiRows,
      deleteSpy: async (sql) => { deleted.push(sql); },
    });
    const result = await runWikiCommand(makeCtx("delete Kimi"), makeDeps(db));
    assert.ok(deleted.length > 0, `delete should have been called, result: ${result.text}`);
    assert.ok(deleted[0].includes("aaaaaaaa"), "should delete the wiki entry by its UUID");
  });

  it("wikiDelete rejects non-wiki entry by ID — does not call delete", async () => {
    const deleted = [];
    const db = makeDb({
      getByIdFn: async () => ({
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        memoryKind: "memory",
        text: "normal memory",
        summary: "normal memory",
      }),
      deleteSpy: async (sql) => { deleted.push(sql); },
    });
    const result = await runWikiCommand(
      makeCtx("delete id:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
      makeDeps(db),
    );
    assert.strictEqual(deleted.length, 0, "delete must NOT be called for a non-wiki entry");
    assert.ok(
      result.text.includes("Normal memories") || result.text.includes("Normale Erinnerungen"),
      `expected wiki.delete_not_wiki message, got: ${result.text}`,
    );
  });

  it("wikiSearch returns wiki-labelled result when wiki entries exist", async () => {
    const wikiRows = [
      { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", memoryKind: "wiki", _distance: 0.2,
        status: "active", text: "Kimi: LLM provider", summary: "[Wiki] Kimi" },
    ];
    const db = makeDb({ wikiRows });
    const result = await runWikiCommand(makeCtx("Kimi"), makeDeps(db));
    assert.ok(
      result.text.includes("(Wiki)"),
      `expected wiki.result_wiki label, got: ${result.text}`,
    );
  });

  it("wikiSearch falls back to memory result when no wiki entries exist", async () => {
    const memoryRows = [
      { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", memoryKind: "memory", _distance: 0.25,
        status: "active", text: "Kimi memory entry", summary: "Kimi memory" },
    ];
    const db = makeDb({ memoryRows });
    const result = await runWikiCommand(makeCtx("Kimi"), makeDeps(db));
    assert.ok(
      result.text.includes("No curated wiki entry") || result.text.includes("kuratierter"),
      `expected wiki.result_fallback label, got: ${result.text}`,
    );
  });

  it("wikiDelete filters out higher-ranking normal memory — only deletes wiki entry", async () => {
    const deleted = [];
    // Normal memory ranks higher (lower _distance = higher score)
    // Both appear in overfetch; only wiki entry should be deleted
    const allRows = [
      { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", memoryKind: "memory", _distance: 0.05,
        status: "active", text: "high-ranking normal memory", summary: "normal" },
      { id: "ffffffff-ffff-ffff-ffff-ffffffffffff", memoryKind: "wiki", _distance: 0.3,
        status: "active", text: "wiki entry about Kimi", summary: "[Wiki] Kimi" },
    ];
    // supportsWhere: false forces overfetch+post-filter path — tests JS-level filtering
    const db = makeDb({
      wikiRows: allRows, // all rows returned in overfetch
      supportsWhere: false,
      deleteSpy: async (sql) => { deleted.push(sql); },
    });
    const result = await runWikiCommand(makeCtx("delete Kimi"), makeDeps(db));
    assert.ok(deleted.length > 0, `should have deleted something, result: ${result.text}`);
    assert.ok(deleted.every(sql => sql.includes("ffff")), "must only delete the wiki entry (fff...)");
    assert.ok(!deleted.some(sql => sql.includes("eeee")), "must NOT delete the normal memory (eee...)");
  });
});
```

- [ ] **Step 2: Run tests — all 6 must fail**

```bash
node --test tests/smoke-wiki-command.test.js
```

Expected: `fail 6` — all tests fail. If any pass unexpectedly, something is already correct or the mock is wrong.

---

### Task 3: Add helpers + update import in `wiki-command.js`

**Files:**
- Modify: `lib/wiki-command.js:11` (imports section)

- [ ] **Step 1: Replace `runRecallPipeline` import with `distanceToScore`**

In `lib/wiki-command.js` line 11, replace:
```javascript
import { runRecallPipeline } from "./recall-pipeline.js";
```
with:
```javascript
import { distanceToScore } from "./score.js";
```

- [ ] **Step 2: Add `searchByKind()` function after the locale helpers (after line ~26)**

Insert this function between the `resolveLocaleFromCtx` block and the `checkWikiAuth` block:

```javascript
// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Vector-searches a LanceDB table filtered to a specific memoryKind.
 * Phase 1: tries DB-level WHERE filter (modern LanceDB ≥0.9).
 * Phase 2: overfetch (limit*5) + JS post-filter (old LanceDB, fallback).
 *
 * For kind="memory", also includes legacy rows with empty/null memoryKind
 * so pre-migration entries remain visible.
 */
async function searchByKind(table, vector, kind, limit, minScore) {
  const kindFilter = kind === "memory"
    ? "memoryKind = 'memory' OR memoryKind IS NULL OR memoryKind = ''"
    : `memoryKind = '${kind}'`;
  const whereClause = `(${kindFilter}) AND (status = 'active' OR status IS NULL)`;

  // Phase 1: DB-level filter
  try {
    const builder = table.vectorSearch(vector);
    if (typeof builder.where === "function") {
      const rows = await builder.where(whereClause).limit(limit).toArray();
      // Array.isArray(rows) means DB answered — return even if empty (avoids
      // false fallback when the wiki is genuinely empty).
      if (Array.isArray(rows)) {
        return rows
          .map((r) => ({ entry: r, score: distanceToScore(r._distance) }))
          .filter((r) => r.score >= minScore);
      }
    }
  } catch (_) {}

  // Phase 2: Overfetch + JS post-filter
  try {
    const rows = await table.vectorSearch(vector).limit(limit * 5).toArray();
    const isMatch =
      kind === "memory"
        ? (r) => !r.memoryKind || r.memoryKind === "memory" || r.memoryKind === ""
        : (r) => r.memoryKind === kind;
    return rows
      .map((r) => ({ entry: r, score: distanceToScore(r._distance) }))
      .filter((r) => r.score >= minScore && isMatch(r.entry));
  } catch (_) {
    return [];
  }
}

/**
 * Builds an LLM-synthesized answer from recall results.
 * Falls back to bullet-point excerpts if callLlm is unavailable.
 */
async function synthesizeAnswer(results, query, lang, callLlm, llmCfg) {
  const memoryLines = results
    .slice(0, 6)
    .map((r, i) => {
      const entry = r.entry || r;
      return `[${i + 1}] ${(entry.text || entry.summary || "").slice(0, 400)}`;
    })
    .join("\n\n");

  if (llmCfg && callLlm) {
    try {
      const prompt =
        lang === "de"
          ? `Du bist ein Wissens-Assistent. Der Nutzer fragt: "${query}"\n\nHier sind relevante gespeicherte Erinnerungen (intern, nicht extern verifiziert):\n\n${memoryLines}\n\nFasse zusammen, was bekannt ist. Kennzeichne Unsicherheit. Maximal 3–4 Sätze.`
          : `You are a knowledge assistant. The user asks: "${query}"\n\nHere are relevant stored memories (internal, not externally verified):\n\n${memoryLines}\n\nSummarize what is known. Flag uncertainty. Maximum 3–4 sentences.`;
      const raw = await callLlm([{ role: "user", content: prompt }], { ...llmCfg, maxTokens: 400 });
      if (raw) {
        return raw.replace(/^```(?:\w+)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
      }
    } catch (_) {}
  }

  return results
    .slice(0, 3)
    .map((r) => {
      const entry = r.entry || r;
      return `• ${(entry.summary || entry.text || "").slice(0, 200)}`;
    })
    .join("\n");
}
```

- [ ] **Step 3: Verify syntax is valid**

```bash
node --check lib/wiki-command.js
```

Expected: no output (syntax OK).

- [ ] **Step 4: Run tests — all 6 still fail (helpers don't change behavior yet)**

```bash
node --test tests/smoke-wiki-command.test.js
```

Expected: `fail 6`.

---

### Task 4: Fix `wikiAdd()` — set `memoryKind: "wiki"`

**Files:**
- Modify: `lib/wiki-command.js` — `wikiAdd` function body (~lines 96-153)

- [ ] **Step 1: Add `memoryKind: "wiki"` to the entry object in `wikiAdd()`**

Inside `wikiAdd()`, find the `applyDynamicsDefaults({...})` call. The current entry object starts with:
```javascript
  const entry = applyDynamicsDefaults({
    id: randomUUID(),
    text: fullText,
    summary: `[Wiki] ${term}`,
    origin: "note",
    vector,
    importance: 0.9,
    category: "knowledge",
    createdAt: Date.now(),
```

Add `memoryKind: "wiki"` after `category: "knowledge"`:
```javascript
  const entry = applyDynamicsDefaults({
    id: randomUUID(),
    text: fullText,
    summary: `[Wiki] ${term}`,
    origin: "note",
    vector,
    importance: 0.9,
    category: "knowledge",
    memoryKind: "wiki",
    createdAt: Date.now(),
```

`applyDynamicsDefaults` spreads the input object first (`const out = { ...entry }`) and does NOT overwrite `memoryKind` when it is already set — so `"wiki"` flows through to `db.store()`.

- [ ] **Step 2: Run Test 1 — should now pass**

```bash
node --test tests/smoke-wiki-command.test.js
```

Expected: `pass 1, fail 5` (the `wikiAdd stores entry with memoryKind: 'wiki'` test passes).

- [ ] **Step 3: Commit**

```bash
git add lib/wiki-command.js
git commit -m "fix(wiki): store wiki entries with memoryKind: 'wiki'"
```

---

### Task 5: Rewrite `wikiSearch()` — wiki-first, memory fallback

**Files:**
- Modify: `lib/wiki-command.js` — `wikiSearch` function (~lines 42-92)

- [ ] **Step 1: Replace the `wikiSearch` function body**

Replace the entire `wikiSearch` function (from `async function wikiSearch(` to its closing `}`) with:

```javascript
async function wikiSearch(query, { db, embeddings, callLlm, llmCfg, lang, tone }) {
  let vector;
  try {
    vector = await embeddings.embed(query);
  } catch (err) {
    return { text: t("wiki.search_error", { lang, tone, vars: { error: err.message } }) };
  }

  // Phase 1: curated wiki entries
  const wikiResults = await searchByKind(db.table, vector, "wiki", 8, 0.2);
  if (wikiResults.length > 0) {
    const answer = await synthesizeAnswer(wikiResults, query, lang, callLlm, llmCfg);
    return { text: t("wiki.result_wiki", { lang, tone, vars: { query, answer } }) };
  }

  // Phase 2: normal memory fallback (memoryKind="memory" + legacy empty/null)
  const memoryResults = await searchByKind(db.table, vector, "memory", 8, 0.2);
  if (memoryResults.length > 0) {
    const answer = await synthesizeAnswer(memoryResults, query, lang, callLlm, llmCfg);
    return { text: t("wiki.result_fallback", { lang, tone, vars: { query, answer } }) };
  }

  return { text: t("wiki.not_found", { lang, tone, vars: { query } }) };
}
```

- [ ] **Step 2: Run Tests 4+5 — should now pass**

```bash
node --test tests/smoke-wiki-command.test.js
```

Expected: `pass 3, fail 3` — tests 1, 4, 5 pass. Tests 2, 3, 6 still fail (delete not fixed yet).

- [ ] **Step 3: Commit**

```bash
git add lib/wiki-command.js
git commit -m "fix(wiki): wiki-first search with memory fallback, clear source labels"
```

---

### Task 6: Rewrite `wikiDelete()` — wiki-only guard

**Files:**
- Modify: `lib/wiki-command.js` — `wikiDelete` function (~lines 157-220)

- [ ] **Step 1: Replace the entire `wikiDelete` function**

Replace the entire `wikiDelete` function (from `async function wikiDelete(` to its closing `}`) with:

```javascript
async function wikiDelete(rawArgs, { db, embeddings, agentId, lang, tone }) {
  // By ID: /wiki delete id:<UUID>
  if (rawArgs.startsWith("id:")) {
    const rawId = rawArgs.slice(3).trim();
    const safeId = safeUuid(rawId);
    if (!safeId) return { text: t("wiki.delete_not_found", { lang, tone, vars: { query: rawId } }) };

    let card = null;
    try {
      card = await db.getById(safeId);
    } catch (_) {}
    if (!card) {
      try {
        const rows = await db.table.query().where(`id = "${safeId}"`).limit(1).toArray();
        if (rows.length > 0) card = rows[0];
      } catch (_) {}
    }
    if (!card) return { text: t("wiki.delete_not_found", { lang, tone, vars: { query: safeId } }) };

    // Wiki-only guard: refuse to delete non-wiki entries
    if ((card.memoryKind || "memory") !== "wiki") {
      return { text: t("wiki.delete_not_wiki", { lang, tone, vars: { query: safeId } }) };
    }

    try {
      archiveCard(card, agentId || "default");
    } catch (err) {
      return { text: t("wiki.search_error", { lang, tone, vars: { error: `Archive failed: ${err.message}` } }) };
    }
    await db.table.delete(`id = "${safeId}"`);
    return { text: t("wiki.deleted", { lang, tone }) };
  }

  // By query
  const query = rawArgs.trim();
  if (!query) return { text: t("wiki.usage", { lang, tone }) };

  let vector;
  try {
    vector = await embeddings.embed(query);
  } catch (err) {
    return { text: t("wiki.search_error", { lang, tone, vars: { error: err.message } }) };
  }

  // Only search wiki entries — normal memories are never deleted via /wiki delete
  const results = await searchByKind(db.table, vector, "wiki", 5, 0.25);
  if (!results || results.length === 0) {
    return { text: t("wiki.delete_not_wiki", { lang, tone, vars: { query } }) };
  }

  if (results.length === 1) {
    const card = results[0].entry;
    try {
      archiveCard(card, agentId || "default");
    } catch (err) {
      return { text: t("wiki.search_error", { lang, tone, vars: { error: `Archive failed: ${err.message}` } }) };
    }
    const safeId = safeUuid(card.id);
    if (safeId) await db.table.delete(`id = "${safeId}"`);
    return { text: t("wiki.deleted", { lang, tone }) };
  }

  // Multiple wiki entries matched — ask user to pick by ID
  const list = results
    .map((r, i) => {
      const entry = r.entry;
      const preview = (entry.summary || entry.text || "").slice(0, 80);
      return `[${i + 1}] id:${entry.id}\n    ${preview}`;
    })
    .join("\n");
  return { text: t("wiki.delete_ambiguous", { lang, tone, vars: { query, list } }) };
}
```

- [ ] **Step 2: Run all 6 tests — all must pass**

```bash
node --test tests/smoke-wiki-command.test.js
```

Expected:
```
✔ wikiAdd stores entry with memoryKind: 'wiki'
✔ wikiDelete removes a wiki entry by query
✔ wikiDelete rejects non-wiki entry by ID — does not call delete
✔ wikiSearch returns wiki-labelled result when wiki entries exist
✔ wikiSearch falls back to memory result when no wiki entries exist
✔ wikiDelete filters out higher-ranking normal memory — only deletes wiki entry
pass 6, fail 0
```

- [ ] **Step 3: Commit**

```bash
git add lib/wiki-command.js
git commit -m "fix(wiki): restrict delete to memoryKind:'wiki' entries only"
```

---

### Task 7: Full regression check

**Files:** none

- [ ] **Step 1: Run the three sprint target files together**

```bash
node --test tests/smoke-wiki-command.test.js tests/smoke-feature-profiles.test.js tests/smoke-lancedb.test.js tests/smoke-migration.test.js tests/smoke-recommended-mode.test.js
```

Expected: all pass, 0 failures.

- [ ] **Step 2: Run the full test suite**

```bash
npm test
```

Expected: same pass/fail ratio as before this sprint (514/515 — the `perf-smoke.test.js` timing test is a pre-existing flaky failure unrelated to this work). If any NEW failures appear, stop and investigate before proceeding.

- [ ] **Step 3: Commit i18n + test file together (if not yet committed)**

If `lib/i18n-dictionary.js` and `tests/smoke-wiki-command.test.js` are not yet in git history from earlier steps:
```bash
git add lib/i18n-dictionary.js tests/smoke-wiki-command.test.js
git commit -m "test(wiki): smoke tests for memoryKind tagging, delete guard, wiki-first search"
```
