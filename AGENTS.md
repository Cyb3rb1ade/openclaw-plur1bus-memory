# PLUR1BUS — Agent Development Guide

This document supplements `README.md` with build steps, conventions, and agent-focused guidance for the PLUR1BUS memory plugin.

## Architecture Overview

PLUR1BUS is an OpenClaw v6 plugin that provides per-agent long-term memory using:

- **LanceDB** — authoritative store, per-agent isolated tables (`{baseDbPath}/{agentId}/`)
- **Obsidian Bridge** — human-readable Markdown vault mirror, bidirectional sync
- **Memory Graph** — semantic, entity, emotional, and episode edges between memory cards
- **Telegram/Chat Commands** — user-facing inspection and editing without leaving the chat
- **Background Jobs** — daily consolidation, critical-push classification, skill mining, REM dreaming

## Embedding-Cache v2

`lib/embedding-cache.js` provides the embedding cache with the following behavior:

- **In-memory layer** — LRU+TTL, bounded by `embeddingCacheMaxEntries`.
- **Persistent SQLite layer** — optional, uses Node.js built-in `node:sqlite` (no external dependency). Enabled with `embeddingCachePersist: true`. WAL mode, `busy_timeout`, atomic UPSERT, `auto_vacuum=INCREMENTAL`.
- **Cache key** — `provider + model + dimensions + scopeId + cacheVersion + sha256(normalizedText)`. `scopeId` is the agent id when `embeddingCacheScope: "agent"` (default) or `"shared"` when scope is shared.
- **Request coalescing** — identical cache keys share one in-flight compute promise; errors are not cached.
- **Size limits** — `embeddingCacheMaxBytes` with soft target at 90% and hard stop on persist writes when the limit is reached.
- **Metrics** — counters for hits, misses, persist hits/writes/skips, coalesced requests; enabled with `embeddingCacheMetrics: true`.
- **No plaintext by default** — `debug_text` is only stored when `embeddingCachePersistDebug: true`.

## LLM-Result-Cache

`lib/llm-result-cache.js` provides an exact, agent-scoped cache for deterministic internal LLM transformations:

- **Purpose allowlist** — only the purposes in `LLM_RESULT_CACHE_PURPOSES` are cached; unknown or missing purposes always bypass the cache (fail-open to live calls). Main chat, critical classification, dream narratives, and other non-deterministic paths are never cached.
- **Cache key** — SHA-256 over `cacheVersion + purpose + scopeId + endpoint + credentialHash + model + messages + maxTokens + temperature + jsonMode + disableThinking + headersHash`. Prompts, credentials, and headers enter the key only as hashes; model/credential rotation invalidates automatically.
- **In-memory layer** — LRU with absolute TTL (`llmResultCacheTtlMs`, clamped to 60 s–7 d, default 24 h), bounded by `llmResultCacheMaxEntries` (clamped to 0–10,000, default 256; clamping logs a warning).
- **Persistent SQLite layer** — optional (`llmResultCachePersist: true`), uses Node.js built-in `node:sqlite` (requires Node ≥ 22.5; older Node falls back to memory-only). WAL mode, `busy_timeout`, atomic UPSERT, `auto_vacuum=INCREMENTAL`. Stores hashed keys, response text, and usage metadata — never prompts, credentials, or headers. Files at `llm-result-cache-v1/{agentId}.db` (dir `0o700`, file `0o600`); note that response text is stored as plaintext (opt-in).
- **Size limits** — `llmResultCacheMaxBytes` (clamped to 0–1 GiB, default 64 MiB) with soft target at 90% and hard skip on persist writes when the limit is reached.
- **Request coalescing** — identical cache keys share one in-flight compute promise; errors and invalid results (empty text, malformed JSON-mode output) are never cached.
- **Lifecycle** — expired rows are swept on open and close; `close()` drains in-flight writes before closing handles and is registered via `registerGatewayShutdown`. Cache defects must never block capture, recall, or the message flow — all failure paths degrade to live calls.
- **Metrics** — per-scope counters for hits, misses, persist hits/writes/skips, coalesced requests, and avoided tokens; enabled with `llmResultCacheMetrics: true` (default), surfaced via `/state`.

## Recall boosters (additive only)

These features sit **after** normal recall and only append results. They must never replace primary recall or write memory data.

### Semantic Lens

- Loads precomputed `.plur1bus/semantic-lens-index.json` from the workspace.
- Adds community/bridge/faded memories after normal recall; dedupes against base recall IDs.
- Default `enabled: false`; caps `maxLensMemories: 3`, `maxBridgeMemories: 2`, `maxFadedMemories: 1`, `maxCommunities: 2`.
- Hard timeout 50 ms; fallback returns base recall unchanged.
- No writes, no live graph recompute, no second recall path.

### Conversation Reactivation Recall (CRR)

- MVP reactivation hook that appends a `<memory-reactivation>` block.
- Triggers: idle gap (45 min), continuation signal, first substantive message, post-compaction gap.
- Default `enabled: false`; `visibleHints: false`.
- Hard caps: `maxReactivationMemories: 3`, `maxFadedReactivationMemories: 1`, `maxOpenThreads: 3`, `maxCommunities: 2`.
- Hard timeout 50 ms; silent fallback on error.
- Module-level in-memory state only; no persistence, no writes to cards/tags/graph/records/quarantine.

### Graph-link managed blocks / semanticDiscovery

- Record notes contain an idempotent managed block (`id="graph-links"`) with wikilinks.
- Tiers: `explicit`, `type`, `semantic`; default semantic threshold 0.78.
- `semanticDiscovery` builds `.plur1bus/link-index.json` from memory mirrors + vectors behind a confirmation gate.
- Conflicts with manual edits are reported, not overwritten.

### Technical frontmatter tags

Memory mirrors use technical filter tags, not semantic content tags:

- `plur1bus/memory`
- `plur1bus/agent/<id>`
- `plur1bus/workspace/<id>`
- `plur1bus/category/<cat>`
- `plur1bus/scope/<scope>`

Use these for filtering and grouping only.

## Coding Standards

### Naming
- `camelCase` for functions, variables, and file names
- `PascalCase` for classes
- `UPPER_SNAKE_CASE` for constants

### Documentation
- **JSDoc for new or changed exports in the current phase**. Existing exports may be supplemented when touched, but do not retroactively document everything.
- Keep JSDoc focused: `@param`, `@returns`, and a one-line description are sufficient.

### Async Style
- Prefer `async/await` over raw Promise chains.
- Promise chains (`.then().catch()`) are **allowed only for justified technical cases**, e.g.:
  - Per-file Promise-Queue mutexes (`atomic-json.js`)
  - Bounded concurrency workers (`runWithConcurrency`)
- Never use floating `.catch(() => {})` that silently swallows errors. Log via `safeWarn`/`safeDebug`.

### Error Handling
- No silent catches. Every catch must either re-throw, return an error result, or log at `warn`/`debug` level.
- Use `safeWarn` / `safeDebug` helpers when logging without access to `api.logger`.
- Destructive operations must write an audit log entry via `appendDestructiveOpLog`.

## Security Guidelines

### Input Validation
- `safeUuid(id)` — mandatory for every LanceDB memory ID parameter
- `safeAgentId(id)` — mandatory before using an ID in a filesystem path
- `resolveInside(baseDir, ...parts)` — mandatory before any file read/write; blocks path traversal even for non-existent targets
- `validateInput(value, { maxLength, name, required })` — mandatory for all user-facing text inputs (commands, callbacks, corrections, search queries)

### Enum Validation
- `safeStatus(value)` — allows only: `active`, `superseded`, `archived`, `deleted`
- `safeType(value)` — allows only the documented memory type set

### Authorization
- Destructive commands (`/forget`, `/correct`, `/enable`, `/disable`, `/plur1bus setup`) use `isAuthorized()`:
  - If a whitelist **is** configured (`allowedUserIds`/`allowedChatIds`), it is enforced everywhere; destructive commands require `userId` in `allowedUserIds` (`chatId` alone is never sufficient).
  - If **no** whitelist is configured, destructive commands are allowed **only in a private 1:1 chat** (single owner; `/forget` and `/correct` are archive-first and recoverable). In groups/supergroups/channels — or when the chat type cannot be determined — they remain **denied** (fail-safe). Chat type is classified via `resolveChatKind()`.
- Confirmation callbacks/commands are bound to `userId + chatId + nonce` via `createConfirmation()` / `validateConfirmation()`. Sender identity is resolved via `resolveIdentity()` (tolerant of channel field-name variants).

## LanceDB Schema Extensions

When adding new columns to the LanceDB `memories` table:

1. Use `addColumns` with `valueSql` for defaults:
   ```js
   await table.addColumns([
     { name: "newColumn", type: new Float32(), valueSql: "0.0" },
   ]);
   ```
2. Provide a fallback in code for tables that have not yet been migrated:
   ```js
   const val = record.newColumn ?? 0.0;
   ```
3. Migration is idempotent and non-destructive; it runs on first `init()`.

## Bi-Temporal Memory (`validFrom`/`validUntil`)

Two columns on the `memories` table describe the REAL-WORLD validity window
of a claim ("Firma A was true from X until Y") — orthogonal to System Time:

- `createdAt`/`updatedAt` are when PLUR1BUS captured/edited the row, **never**
  when the described fact became/stopped being true. `validFrom`/`validUntil`
  must never be derived from either — this is a standing invariant, not just
  an initial design choice; grep for it before adding a new writer.
- `expiresAt` is a hard TTL that **removes** a row from recall once passed.
  `validUntil` is its semantic opposite: the row stays fully present and
  queryable, only the claim is understood to no longer hold after that point.
- `0` on either field means "no known bound in that direction" (mirrors
  `expiresAt`'s own `0` = "no TTL" convention) — never the Unix epoch.
- Boundary rule, left-inclusive/right-exclusive: `validFrom <= validAt <
  validUntil`.

Historical facts are **not** modeled as version-chain edits
(`safeUpdate()`'s supersede path). A superseding fact ("Firma B") is a new,
independent row; the superseded row ("Firma A") stays `status: "active"`
with its `validUntil` closed via `applyValidTimeCloseToLanceDb` (a direct
metadata mutation, not a versioning edit). Both rows coexist; only the
`validAt` window passed to recall decides which one a query surfaces.
`buildUpdateEntry()` (`lib/safe-update.js`) carries `validFrom`/`validUntil`
forward verbatim across a content-changing `safeUpdate()` — a rewording of a
claim's text does not change when the claim was true.

`validAt` is opt-in on `memory_recall`/`memory_search` (query side),
defaulting to `null` (no temporal filtering; rows with known
`validFrom`/`validUntil` remain eligible and their bounds are visibly labeled
in recall output). When supplied, the primary and refined ANN searches push
the validity predicate into LanceDB before the hard candidate limit. A
read-only legacy namespace that specifically reports a missing
`validFrom`/`validUntil` column is retried exactly once without the predicate,
then filtered by the same JavaScript lifecycle gate; unrelated query errors
propagate and never trigger that fallback. **Capture-side population is
wired.** The `memory_store`
tool schema has optional `validFrom`/`validUntil` string parameters (the
orchestrating LLM's own judgment is the population mechanism — no relative-
time NLP extraction exists or is planned; the parameter descriptions
explicitly tell the model to leave the field out for vague phrasing like
"seit letztem Monat" rather than guess). Both live store paths
(`storeMemoryFromToolParams` and the `memory_store` tool's own inline
duplicate-merge copy) run `normalizeCapturedValidityWindow()` on the incoming
params before building the entry — unparseable/absent values degrade to `0`
(unknown), never a guessed date. Both paths also call
`hasDisjointValidityWindows()` at their store-time LLM-merge guard (right
next to the existing `validateMergedTextPreservesFacts` abort check): a
merge candidate with a known, disjoint validity window aborts the merge and
falls through to a normal, separate store; an allowed merge's
`validFrom`/`validUntil` come from `combineValidTimeForMerge()` rather than
being silently dropped. `findMergeCandidate`'s projection carries both
fields so the guard has real data to compare against. Recall deduplication
keeps text/canonical-origin copies whose known validity windows are disjoint,
and namespace bridge candidates are compared against every overlapping
winner. Compaction routes text-compatible memories with known disjoint windows
to a logged/persisted `mark_redundant` proposal instead of a merge; that action
is not low-risk auto-apply, so it neither merges nor archives those historical
rows automatically.

Durable store-time merges persist candidate lineage in the existing
`mergedFrom` JSON array as `[candidateId, "valid-time:<from>:<until>"]`.
Replacement verification requires both markers and an actual array; malformed
JSON, non-array JSON, legacy arrays without the fingerprint, changed candidate
bounds, or mismatched replacement fields fail closed. The candidate is
revalidated after replacement preparation and again immediately before the
original is deleted. Do not derive a new replacement ID from mutable candidate
bounds and do not auto-delete repairable or conflicting forks.

**Gotcha for anyone touching `lib/valid-time.js`'s merge-guard functions**:
LanceDB returns `int64` columns — including `validFrom`/`validUntil` — as
native JS `BigInt`, and `Number.isFinite(someBigInt)` is *always* `false`.
The shared `toFiniteMs()`/`knownWindow()` path accepts only safe-integer
Numbers or safely representable BigInts, maps both `0` and `0n` to an unknown/
open bound, and is used by `isEntryValidAt()`, disjointness checks, and merge
union logic. Never reintroduce truthiness or direct `0n !== 0` sentinel checks;
validity remains left-inclusive/right-exclusive for Number and BigInt rows.

Rows can receive non-zero bounds directly through `memory_store`'s optional
`validFrom`/`validUntil` inputs. Existing rows can also have `validUntil`
closed through `applyValidTimeCloseToLanceDb`; that adapter still has no
dedicated chat-command surface (e.g. `/correct`).

## Testing

Run tests with:

```bash
node --test tests/*.test.js
```

- Tests are unit-level and DB-free.
- Every phase must add its own regression tests.
- Current baseline: 3,609 tests (3,608 passing, 0 failing, 1 skipped), 630 suites.

## Dependency Audit

Last audit run: 2026-06-05

- `npm audit`: **0 vulnerabilities**
- `npm ci --ignore-scripts`: passes

### Runtime Dependencies

| Package | Spec | Resolved | Pinned? |
|---------|------|----------|---------|
| `@lancedb/lancedb` | `^0.26.2` | `0.26.2` | No (`^`) — version fixed by `package-lock.json` |
| `openai` | `^6.27.0` | `6.42.0` | No (`^`) — version fixed by `package-lock.json` |

### Optional Dependencies

| Package | Spec | Resolved | Pinned? |
|---------|------|----------|---------|
| `@huggingface/transformers` | `4.2.0` | `4.2.0` | Yes |

All versions are effectively pinned at install time by `package-lock.json`. No critical CVEs were reported at the time of the last audit. Major upgrades require a separate plan.

## Backup / Restore

Before destructive fixes or schema migrations, create a snapshot:

```bash
# Automatic snapshot (recommended)
./scripts/backup-snapshot.sh

# Manual snapshot (fallback)
cp -r ~/.openclaw/memory/lancedb-namespaced ~/.openclaw/memory/lancedb-namespaced.bak.$(date +%Y%m%d-%H%M%S)
```

Restore from a snapshot (dry-run by default):

```bash
# Dry-run: see what would be restored
./scripts/restore-snapshot.sh ~/.openclaw/.snapshots/plur1bus-YYYYMMDD-HHMMSS

# Actually restore
./scripts/restore-snapshot.sh --confirm ~/.openclaw/.snapshots/plur1bus-YYYYMMDD-HHMMSS
```

The plugin writes archives before every deletion (`/forget`, `/correct`). The archive path is reported in the command response.
