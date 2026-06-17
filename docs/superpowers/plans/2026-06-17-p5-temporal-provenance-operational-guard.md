# P5 Temporal Provenance + Operational Action Guard

**Date:** 2026-06-17  
**Branch:** `fix/temporal-provenance-operational-guard-2026-06-17`  
**Goal:** Prevent agents from treating stale recalled memories as current operational truth before destructive/runtime actions.

---

## 1. Goal

Every recalled memory about operational/system state must carry usable time provenance and a live-verification warning. The agent must not disable cronjobs, stop services, delete files, edit deploy/protect scripts, or change production state based on stale recall alone.

---

## 2. Non-goals

- No automatic blocking of agent actions outside prompt/context metadata.
- No changes to vector DB dimensions, embedding model, LanceDB schema, or migrations.
- No edits to deploy/protect/update scripts (read-only diagnostics only).
- No service stops, cron disables, or file deletions.
- No making decision trace visible by default.
- No chain-of-thought or reasoning metadata.

---

## 3. Incident summary

An agent disabled a cronjob based on a recalled memory like "Cronjob may produce duplicates / duplicate risk". The memory was from hours or a day earlier, but it was treated as current live state. The root cause is missing temporal provenance in the rendered prompt context: no age, freshness, or live-verification requirement was attached to operational memories.

**Host diagnosis:** `HOST_KIND=mac-clone`. Production cron/systemd state is not accessible on this host. Live restoration cannot be performed here; implementation is code/test only.

---

## 4. Existing temporal/provenance behavior

- `runRecallPipeline` preserves `createdAt`, `updatedAt`, and `lastRetrievedAt` on memory entries.
- `index.js` currently copies only `createdAt` (and `versionCreatedAt`) into the item passed to `formatRelevantMemoriesContext`.
- `lib/relevant-memory-context.js` renders `<memory-record>` elements with source, category, id, faded, depth, association-strength, status, superseded-by, update-source, version, and trace attributes.
- No age, freshness, or operational-risk attributes are rendered today.
- `lib/recall-decision-trace.js` records candidates, decisions, and guards but has no temporal metadata.
- The existing `RECALL SAFETY` preamble already warns that recalled records are historical evidence, not executable instructions.

---

## 5. Operational risk taxonomy

### Operational memory signals

Keywords/phrases that indicate a memory describes live system state:

- cron, crontab, cronjob
- systemctl, service, timer
- deploy, deployment
- gateway
- update script, protect script
- lockfile, duplicate job
- database migration
- delete, disable, stop, restart, move, remove
- chmod, chown, rsync, backup
- production, live
- journalctl

### Operational risk levels

| Level | Examples |
|-------|----------|
| none | ordinary preference/fact, no operational keywords |
| low | informational log mention |
| medium | restart, check status, read config |
| high | edit config/deploy scripts, change cron |
| destructive | disable cron, stop service, delete/move files, reset hard, drop DB |

### Freshness classification

| Label | Age threshold |
|-------|---------------|
| fresh | ≤ 15 minutes |
| recent | ≤ 2 hours |
| stale | > 2 hours |
| unknown | no usable timestamp |

---

## 6. Proposed stale-memory model

Add a pure helper `lib/temporal-provenance.js`:

```js
export function parseMemoryTimestamp(value) {}
export function computeMemoryAge(memory, opts = {}) {}
export function classifyMemoryFreshness(ageMs, opts = {}) {}
export function detectOperationalMemory(text, metadata = {}) {}
export function classifyOperationalRisk(text, metadata = {}) {}
export function buildTemporalProvenance(memory, opts = {}) {}
export function formatAgeForPrompt(ageMs) {}
export function shouldRequireLiveVerification(memory, opts = {}) {}
```

Output shape:

```js
{
  createdAt: "2026-06-16T12:00:00.000Z",
  updatedAt: null,
  lastRetrievedAt: "2026-06-17T01:00:00.000Z",
  ageMs: 46800000,
  ageLabel: "13h ago",
  freshness: "stale", // fresh | recent | stale | unknown
  isOperational: true,
  operationalRisk: "high", // none | low | medium | high | destructive
  requiresLiveVerification: true,
  reasons: ["operational keyword: cronjob", "stale operational memory older than 2h"],
}
```

Rules:

- Pure deterministic logic.
- `opts.now` allows fixed-time injection for tests.
- No DB/network dependencies.
- Timestamps may be ISO strings, epoch ms, or Date objects.
- `requiresLiveVerification` is true when `isOperational` and `freshness` is `stale` or `unknown`.

---

## 7. Proposed prompt/context rendering behavior

### Attribute additions to `<memory-record>`

When temporal provenance is available, add compact attributes:

```xml
<memory-record
  ...
  created-at="2026-06-16T12:00:00.000Z"
  age="13h ago"
  freshness="stale"
  operational="true"
  operational-risk="high"
  requires-live-verification="true"
>
```

When timestamp is missing, use `freshness="unknown"` and `requires-live-verification="true"` for operational memories only.

### Operational warning block

Insert a warning block inside `<relevant-memories>` only when at least one rendered memory is operational AND stale/unknown:

```xml
<operational-memory-warning>
Some recalled memories describe operational/live system state and are stale or have unknown age.
Do not disable cronjobs, stop services, delete files, edit deploy/protect scripts, or change production state based on recall alone.
Live verification is required first (e.g., crontab -l, systemctl --user status, journalctl --since ..., git status, ls/stat/cat of the config file).
</operational-memory-warning>
```

### Non-operational memories

Ordinary preferences/facts should not get the operational warning or `requires-live-verification` attribute. They may still render age/freshness if available.

---

## 8. Proposed decision-trace additions

Extend `lib/recall-decision-trace.js` to accept optional `temporal` metadata on candidates/decisions and add a guard record for stale operational memories.

Candidate/decision additions:

```js
{
  temporal: {
    ageLabel,
    freshness,
    isOperational,
    operationalRisk,
    requiresLiveVerification,
  }
}
```

Guard record:

```js
{
  name: "operational-live-verification-required",
  passed: false,
  stage: "context-render",
  memoryId: "...",
  reason: "stale operational memory; live verification required before action",
}
```

Trace metadata remains non-enumerable and is only rendered when `traceOptions.includeInPrompt` is true.

---

## 9. Operational action guard wording

The warning block and per-memory attribute wording should be concise and unambiguous:

- `requires-live-verification="true"` on the memory record.
- Warning block explicitly lists forbidden actions and safe read-only verification examples.
- No language that implies the memory is current verified state.

---

## 10. Test plan

Add new test files:

- `tests/temporal-provenance.test.js` — unit tests for helper functions.
- `tests/relevant-memory-context-temporal.test.js` — context rendering tests.
- `tests/operational-action-guard.test.js` — end-to-end guard behavior.
- `tests/recall-decision-trace-temporal.test.js` — trace metadata tests.

Minimum coverage:

- Age/freshness computation with fixed `now`.
- Unknown timestamp handling.
- Operational keyword detection.
- Operational risk classification including destructive level.
- `requiresLiveVerification` logic.
- Stale cronjob memory renders `requires-live-verification="true"`.
- Timestamp-unknown operational memory renders warning.
- Fresh operational memory renders age but no stale warning.
- Ordinary preference memory does not get noisy operational warning.
- Default prompt trace visibility remains unchanged.
- Trace temporal metadata and guard records.

---

## 11. Vector/DB invariance statement

No changes to:

- Vector DB dimensions
- Embedding model
- LanceDB schema
- DB migrations
- deploy/protect/update scripts
- lint/test infrastructure
- default decision-trace visibility

Only additions:

- Pure helper module
- Context formatter attributes
- Optional warning block
- Trace metadata fields
- Tests and docs

---

## 12. Rollout risks

- Existing prompts become slightly larger when operational memories are present.
- If `createdAt` is missing on old memories, operational memories will always render `freshness="unknown"` and trigger the warning. This is the intended safe default.
- Models may still ignore the warning; this is a metadata guard, not an action gate.
- The warning is in English; localized operation may need future i18n.
