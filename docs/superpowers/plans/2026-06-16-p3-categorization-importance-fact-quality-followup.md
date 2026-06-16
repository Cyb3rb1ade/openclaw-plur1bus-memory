# P3 Categorization / Importance / Fact-Quality — Followup

## Summary

Hardened memory categorization, fact-quality detection, and importance scoring.

The primary goal was to prevent trivial, temporary, or noisy statements from becoming strong memories while preserving durable user preferences, project facts, corrections, and concrete security/deploy facts.

## Files changed

- `lib/memory-fact-quality.js` (new)
- `lib/categorize.js`
- `index.js`
- `tests/memory-fact-quality.test.js` (new)
- `tests/memory-categorization-safety.test.js` (new)
- `tests/memory-importance-safety.test.js` (new)
- `tests/memory-promotion-quality.test.js` (new)
- `docs/superpowers/plans/2026-06-16-p3-categorization-importance-fact-quality.md` (new)
- `docs/superpowers/plans/2026-06-16-p3-categorization-importance-fact-quality-followup.md` (this file)

## Fact-quality model

Deterministic classifier in `lib/memory-fact-quality.js`.

Signals:

- **Trivial / ephemeral:** single-word acknowledgements (`ok`, `yes`, `go on`, `weiter`, `mach`, `danke`), punctuation-only, no content tokens.
- **Temporary / status:** `today`, `tomorrow`, `right now`, `currently`, `finished`, `passed`, `failed`, one-off command output.
- **Durable preference:** preference verbs (`prefer`, `like`, `want`, `bevorzuge`, `mag`) plus durable markers (`from now on`, `always`, `never`, `remember this`).
- **Project fact:** technical terms, version numbers with technical context, architecture language, named entities with descriptive content, concrete security/deploy facts.
- **Correction:** `no longer`, `instead of`, `rather than`, `statt`, `sondern`, `nicht mehr`, direct contradiction patterns.
- **Explicit instruction:** `remember`, `always`, `never`, `from now on`, `merke dir`.

No LLM is used. All rules are deterministic and testable.

## Category rules

Updated `lib/categorize.js`:

- Added `categorizeMemoryWithReason(text)` returning `{ category, reason }`.
- `categorizeMemory(text)` remains backwards-compatible.
- Preference verbs and durable markers → `preference`.
- Architecture decisions, migrations, corrections, concrete security/deploy facts → `decision`.
- URLs/links → `reference`.
- Errors/stacks → `debug`.
- Settings/defaults → `config`.
- Named-entity facts with substance → `fact` or `entity`.
- Transient status / filler → `conversation`.
- Generic tech keyword salad without subject → `conversation`.
- Weakened broad `is/are/was/were` fact trigger to require named entity or substantive noun.

## Importance rules

Implemented in `lib/memory-fact-quality.js` and wired into all store paths:

- Trivial/ephemeral → clamped to `≤ 0.2`.
- Temporary/status without explicit remember → clamped to `≤ 0.45`.
- Durable preference → floor `0.55`.
- Project architecture fact → floor `0.65`.
- Correction / superseding update → floor `0.7`.
- Concrete security/deploy/auth fact → floor `0.7`.
- Explicit "remember this" / "from now on" → floor `0.7`.
- Emotion-only text cannot become high.
- Generic tech keyword salad cannot become high.
- Caller-provided explicit importance is preserved when higher than floors.
- Out-of-range values are clamped to `[0, 1]`.

## Promotion guard behavior

Added `shouldPromoteMemory(category, importance, factQuality, schicht15MinImportance)`.

KNOWLEDGE.md pending queue now requires:

- `category` is `decision` or `fact`
- `importance >= schicht15MinImportance` (default `0.7`)
- `factQuality.shouldDownrank === false`
- `factQuality.shouldPromote === true` or `importance >= 0.7`

Examples:

| Text | Category | Importance | Promoted |
|---|---|---|---|
| `ok` | conversation | 0.20 | no |
| `go on!!!!` | conversation | 0.20 | no |
| `Today npm test passed` | conversation | 0.45 | no |
| `From now on, use German for repo prompts` | preference | 0.70 | no (preference not in KNOWLEDGE.md queue, but high memory) |
| `Dreamdale is a festival, not a city` | decision | 0.70 | yes |
| `Auth bypass in group chats was fixed` | decision | 0.70 | yes |

## Tests

New test files:

- `tests/memory-fact-quality.test.js` — classifier unit tests
- `tests/memory-categorization-safety.test.js` — category assignment tests
- `tests/memory-importance-safety.test.js` — importance scoring tests
- `tests/memory-promotion-quality.test.js` — promotion guard tests

Full suite: `npm test` passes 1463 tests.

## What is intentionally not changed

- Vector DB dimensions unchanged.
- Embedding model unchanged.
- LanceDB schema unchanged.
- No DB migrations.
- No re-embedding of existing memories.
- No rewriting of historical memories.
- `plur1bus/index.js` untouched (the stale packaged copy is outside this change scope).
- Deploy/protect/update scripts unchanged.
- Lint/test infrastructure unchanged.
- #49/#50/#51/#52/#53 safeguards preserved.
- Recall decision trace output remains invisible by default (`includeInPrompt` default false).

## Vector/DB invariance

Only new deterministic helpers and in-memory metadata were added. No persistent schema changes.

## Remaining risks

1. **German/English over-tuning:** The rule set is tuned for the project's bilingual usage. Other languages may need expansion.
2. **Auto-capture behavior change:** Auto-capture now uses computed importance instead of hardcoded `0.7`. Some captured operational context may score lower; this is intentional but should be monitored.
3. **`plur1bus/index.js` drift:** The packaged stale copy still uses old categorization/importance logic. If it is still deployed, it re-introduces the audited issues.
4. **Named entity extraction at sentence start:** Common words capitalized at sentence start (e.g., "Today") can be misclassified as named entities. The temporary-status guard and runtime-fact exceptions mitigate this, but edge cases remain.
5. **KNOWLEDGE.md category restriction:** Durable preferences with explicit instructions get high importance but are not queued for KNOWLEDGE.md because the existing queue only handles `decision`/`fact`. This is consistent with current behavior but may be revisited.

## PR recommendation

Ready for review. Focus areas:

- Conservatism of `lib/memory-fact-quality.js` rules
- Category assignment edge cases in `lib/categorize.js`
- Importance clamping behavior for auto-capture
- Promotion guard integration in `index.js`
- Test coverage for trivial/temporary/noisy inputs
