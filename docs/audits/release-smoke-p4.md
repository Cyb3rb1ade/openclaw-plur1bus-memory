# Release Smoke Test — P4

**Date:** 2026-06-07T02:27Z  
**Environment:** macOS, Node.js (builtin), npm  
**Test Scope:** Fresh clone / install scenario, zero code changes.

---

## 1. npm install

| Check | Result |
|-------|--------|
| package.json valid | ✅ YES |
| Install completes | ✅ YES (80 packages, ~11 s) |
| Vulnerabilities | ✅ 0 found |
| Deprecation warnings | ⚠️ 1 (`boolean@3.2.0` deprecated) — non-blocking |

---

## 2. Test Suite — `node --test tests/*.test.js`

| Metric | Value |
|--------|-------|
| Tests | 382 |
| Suites | 84 |
| Pass | 382 |
| Fail | 0 |
| Cancelled | 0 |
| Skipped | 0 |
| Duration | ~60 s |

**Result:** ✅ ALL GREEN

Key areas covered by the suite:
- Schema default types (recall, runtime/cache, misc)
- `halfLifeDaysMap` groups completeness
- Code fallback ↔ schema default alignment
- `embedding-cache`, `graph-index`, `metrics-debounce`, `recall-budget`
- E2E recall, filter parser, security & safety, LanceDB smoke, migration smoke
- Feature profiles, obsidian apply, conflict resolver, reminders

---

## 3. `openclaw.plugin.json` Validation

| Check | Result |
|-------|--------|
| Valid JSON | ✅ YES |
| `configSchema.properties.recall` section present | ✅ YES |
| All new recall fields present | ✅ YES |

**Fields found under `configSchema.properties.recall.properties`:**
- `importanceBoost` — number, default `0.3`
- `dedup` — boolean, default `true`
- `dedupJaccard` — number, default `0.78`
- `canonicalFirst` — boolean, default `true`
- `canonicalMinScore` — number, default `0.3`
- `canonicalMaxItems` — number, default `5`
- `maxPromptMemories` — number, default `12`
- `candidateTopK` — number, default `40`
- `halfLifeDaysMap` — object with defaults:
  - `transient` → `60`
  - `episodic` → `180`
  - `longContext` → `365`
  - `project` → `365`

**Default type correctness:** ✅ All defaults are valid numbers or booleans (verified by test suite `Schema-Default-Typen (Recall)`).

> Note: There is **no top-level `recall` key** in the manifest; recall configuration lives under `configSchema.properties.recall`, which is the intended OpenClaw plugin schema location.

---

## 4. `docs/audits/` Presence in Repo

```
docs/audits/atomic-json-hot-path.md
docs/audits/dead-code-p3.md
docs/audits/performance-p2.md
```

Result: ✅ All audit docs tracked by git.

---

## 5. New Lib File Importability

| File | Import Result |
|------|---------------|
| `lib/embedding-cache.js` | ✅ OK |
| `lib/graph-index.js` | ✅ OK |
| `lib/recall-budget.js` | ✅ OK |
| `lib/metrics-debounce.js` | ✅ OK |

All four modules load without syntax or runtime errors in a fresh Node.js ESM import.

---

## Summary

| Gate | Status |
|------|--------|
| Clean install | ✅ PASS |
| Full test suite | ✅ PASS (382/382) |
| Manifest JSON & schema | ✅ PASS |
| Audit docs in repo | ✅ PASS |
| New lib modules importable | ✅ PASS |

**Verdict:** P4 Release Candidate passes install smoke test. No code changes were made.
