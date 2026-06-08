# /wiki Command Stabilization — Design Spec

**Goal:** Fix the semantic and safety gaps in the existing `/wiki` command: tag wiki entries correctly (`memoryKind: "wiki"`), restrict delete to wiki-only, and implement wiki-first search with explicit memory fallback.

**Scope:** Sprint 2 — Stabilization. Not a rewrite. Three function changes in one file, three new i18n keys, one new test file.

---

## Background

`lib/wiki-command.js` and its command registration in `index.js` are fully implemented. All i18n keys exist. The command works. What's broken is semantics and safety:

| Problem | Effect |
|---|---|
| `wikiAdd()` stores with `memoryKind: "memory"` (default) | Wiki entries are indistinguishable from conversation memories → Dreaming, merging, graph-building treat them as regular memories |
| `wikiDelete()` matches any memory | User can accidentally delete non-wiki memories via `/wiki delete` |
| `wikiSearch()` searches all memories uniformly | No preference for curated wiki entries; search is equivalent to regular recall |

The fix uses `memoryKind` — already in the LanceDB schema (line 455 in extension, default `"memory"`) — setting it to `"wiki"` for explicitly stored entries.

---

## Architecture

### Files changed

| File | Change |
|---|---|
| `lib/wiki-command.js` | Modify `wikiAdd()`, `wikiSearch()`, `wikiDelete()`; add `distanceToScore` import; add private `searchByKind()` helper |
| `lib/i18n-dictionary.js` | Add 3 keys: `wiki.result_wiki`, `wiki.result_fallback`, `wiki.delete_not_wiki` |

### Files created

| File | Purpose |
|---|---|
| `tests/smoke-wiki-command.test.js` | 5 unit tests with mocked DB |

---

## Detailed Design

### Private helper: `searchByKind(table, vector, kind, limit, minScore)`

To avoid repeating the DB-filter-with-overfetch-fallback pattern three times (in search and delete), a module-private function:

```javascript
async function searchByKind(table, vector, kind, limit, minScore) {
  const kindFilter = kind === "memory"
    ? "memoryKind = 'memory' OR memoryKind IS NULL OR memoryKind = ''"
    : `memoryKind = '${kind}'`;
  const whereClause = `(${kindFilter}) AND (status = 'active' OR status IS NULL)`;

  // Phase 1: DB-level filter (modern LanceDB)
  try {
    const builder = table.vectorSearch(vector);
    if (typeof builder.where === "function") {
      const rows = await builder.where(whereClause).limit(limit).toArray();
      const results = rows
        .map(r => ({ entry: r, score: distanceToScore(r._distance) }))
        .filter(r => r.score >= minScore);
      if (results.length > 0 || rows.length >= 0) return results; // DB answered
    }
  } catch (_) {}

  // Phase 2: Overfetch + post-filter
  try {
    const rows = await table.vectorSearch(vector).limit(limit * 5).toArray();
    const isMatch = kind === "memory"
      ? (r) => !r.memoryKind || r.memoryKind === "memory" || r.memoryKind === ""
      : (r) => r.memoryKind === kind;
    return rows
      .map(r => ({ entry: r, score: distanceToScore(r._distance) }))
      .filter(r => r.score >= minScore && isMatch(r.entry));
  } catch (_) {
    return [];
  }
}
```

**Why the `rows.length >= 0` return condition:** Once the `.where()` call succeeds without throwing, we trust the DB answered — even if 0 results. This avoids a false fallback when the wiki is simply empty (which is the normal state for new installs).

---

### `wikiAdd()` — Set `memoryKind: "wiki"`

**Change:** Add `memoryKind: "wiki"` to the entry object passed to `applyDynamicsDefaults()`.

`applyDynamicsDefaults()` does `if (normalized.memoryKind == null) normalized.memoryKind = "memory"` — an explicitly passed value is preserved.

```javascript
const entry = applyDynamicsDefaults({
  id: randomUUID(),
  text: fullText,
  summary: `[Wiki] ${term}`,
  origin: "note",
  vector,
  importance: 0.9,
  category: "knowledge",
  memoryKind: "wiki",          // ← new
  createdAt: Date.now(),
  // ... (all other fields unchanged)
}, Date.now(), {});
```

---

### `wikiSearch()` — Wiki-first, Memory fallback

**Replace** the `runRecallPipeline` call with a two-phase approach. Add `distanceToScore` import at top of file.

```
Phase 1: searchByKind(db.table, vector, "wiki", 8, 0.2)
  → if results.length > 0:
      LLM synthesis from wiki results
      return t("wiki.result_wiki", { query, answer })
  → else: continue to Phase 2

Phase 2: searchByKind(db.table, vector, "memory", 8, 0.2)
  → if results.length > 0:
      LLM synthesis from memory results
      return t("wiki.result_fallback", { query, answer })
  → else:
      return t("wiki.not_found", { query })
```

The LLM synthesis block (prompt construction, `callLlm`, markdown-strip) is extracted to a shared helper `synthesizeAnswer(results, query, lang, callLlm, llmCfg)` used by both phases. This avoids duplication.

The embedding call (`embeddings.embed(query)`) moves to before both phases (single embed per search).

---

### `wikiDelete()` — Wiki-only guard

#### By ID (`id:<UUID>`)

```
getById(safeId)
→ if not found: wiki.delete_not_found
→ if found but memoryKind !== "wiki": wiki.delete_not_wiki
→ else: archiveCard + table.delete
```

#### By query

```
embed(query)
searchByKind(db.table, vector, "wiki", 5, 0.25)
→ if 0 results: wiki.delete_not_wiki
→ if 1 result: archiveCard + table.delete → wiki.deleted
→ if 2+ results: format ID list → wiki.delete_ambiguous
```

**No change to the ambiguous-list format** — only wiki entries appear in the list, so the user never sees a mix.

---

## i18n Keys (add to `lib/i18n-dictionary.js`)

```javascript
"wiki.result_wiki": {
  de: { default: "📖 {{query}} (Wiki)\n\n{{answer}}" },
  en: { default: "📖 {{query}} (Wiki)\n\n{{answer}}" },
},
"wiki.result_fallback": {
  de: { default: "📖 {{query}}\n\n_(Kein kuratierter Wiki-Eintrag — Synthese aus Erinnerungen)_\n\n{{answer}}" },
  en: { default: "📖 {{query}}\n\n_(No curated wiki entry — synthesized from memories)_\n\n{{answer}}" },
},
"wiki.delete_not_wiki": {
  de: { default: "Kein löschbarer Wiki-Eintrag gefunden für: {{query}}\nNormale Erinnerungen werden von /wiki delete nicht gelöscht." },
  en: { default: "No deletable wiki entry found for: {{query}}\nNormal memories cannot be deleted via /wiki delete." },
},
```

The existing `wiki.result` key stays (no callers after this change, but removing it would require a separate i18n audit — out of scope).

---

## Tests: `tests/smoke-wiki-command.test.js`

Unit tests with mocked DB — no real LanceDB instance needed. Tests exercise the logic in `wiki-command.js` directly.

**Mock pattern:**
```javascript
function makeDb(wikiRows = [], memoryRows = []) {
  return {
    table: {
      vectorSearch: (vector) => ({
        where: (clause) => ({
          limit: (n) => ({
            toArray: async () => clause.includes("'wiki'") ? wikiRows : memoryRows,
          }),
        }),
        limit: (n) => ({ toArray: async () => [...wikiRows, ...memoryRows].slice(0, n) }),
      }),
      delete: async () => {},
      query: () => ({ where: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
    },
    init: async () => {},
    getById: async (id) => null,
    findSimilar: async () => [],
    store: async () => {},
    search: async () => [],
  };
}
```

**5 tests:**

1. **`wikiAdd stores memoryKind: "wiki"`**
   - Call `wikiAdd("Begriff: Text", { db, embeddings: mockEmbed, agentId: "x", lang: "de", tone: "default" })`
   - Assert `db.store` was called with entry where `entry.memoryKind === "wiki"`

2. **`wikiDelete removes wiki entry by query`**
   - DB returns 1 wiki row (`memoryKind: "wiki"`, `id: "uuid-1"`)
   - Assert `db.table.delete` called with `id = "uuid-1"`

3. **`wikiDelete rejects non-wiki entry`**
   - `db.getById` returns row with `memoryKind: "memory"`
   - Call `wikiDelete("id:uuid-1", ...)`
   - Assert result text contains `t("wiki.delete_not_wiki")`; assert `db.table.delete` NOT called

4. **`wikiSearch returns wiki result when wiki entries exist`**
   - DB wiki search returns 1 row (score 0.8, `memoryKind: "wiki"`)
   - Assert result text matches `wiki.result_wiki` pattern (contains "(Wiki)")

5. **`wikiSearch falls back to memory when no wiki entries`**
   - DB wiki search returns 0 rows; memory search returns 1 row
   - Assert result text matches `wiki.result_fallback` pattern (contains "Erinnerungen" or "memories")

---

## Success Criteria

- `node --test tests/smoke-wiki-command.test.js` → 0 failures
- `npm test` → no regressions
- `/wiki add` entries stored with `memoryKind: "wiki"` (verified via test)
- `/wiki delete` with non-wiki match returns `wiki.delete_not_wiki`, does not delete
- `/wiki <term>` with wiki hit uses `wiki.result_wiki`; without wiki hit uses `wiki.result_fallback`
- No changes to `index.js`, LanceDB extension, or schema

---

## Out of Scope

- Filtering Dreaming/Consolidation pipelines by `memoryKind` (they already filter on `memoryKind = 'memory'` via `getRecentForGraph`)
- `/wiki list` command
- Wiki entry editing
- Schema migration (column already exists, no migration needed)
