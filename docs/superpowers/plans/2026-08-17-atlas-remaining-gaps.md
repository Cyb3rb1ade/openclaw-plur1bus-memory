# Remaining Atlas Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close or honestly document every remaining Atlas gap as independently shippable workstreams off `main` @ `3e5586d`.

**Architecture:** Eight branches, one workstream each. Tests-only and render-only streams first. Mutation streams (resolve, drift apply, derived scope) later. Host patch is not removed.

**Tech Stack:** Node ≥ 22.5, `node --test`, existing LanceDB adapters, `safeUpdate`, neo JSONL.

**Spec:** `docs/superpowers/specs/2026-08-17-atlas-remaining-gaps-design.md`

## Global Constraints

- Branch each workstream from current `origin/main` (after PR #114).
- No `conflict` on the `-Infinity` list.
- `/correct` keeps `skipDriftGate: true`.
- Missing LanceDB `epistemicStatus` stays `""` for scoring; only render labels may say `untrusted`.
- Do not pass `requester` into derived readers until those records carry `visibility.scope` or an explicit ownership fallback.
- `postinstall` stays `|| true`.
- No live-store writes in tests.
- Do not bump version or publish.

---

### Task 1: Tombstone e2e for compaction, auto-capture, light-dream

**Files:**
- Create: `tests/tombstone-bulk-writers.test.js`
- Modify: none of production (guards already exist)
- Test: `tests/tombstone-bulk-writers.test.js`

**Interfaces:**
- Consumes: `assertCardWriteAllowed` (`lib/tombstone-write-guard.js`), `appendTombstoneToRegistry`, `buildTombstone`
- Produces: three failing-then-passing cases that a forgotten fingerprint cannot `table.add`

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTombstoneToRegistry, buildTombstone } from "../lib/tombstone.js";
import { assertCardWriteAllowed } from "../lib/tombstone-write-guard.js";

const UUID = "00000000-0000-4000-8000-0000000000aa";

function forgotten(baseDbPath, text) {
  const t = buildTombstone({
    card: { id: UUID, text, scope: "agent-private" },
    agentId: "agent-a", actor: "user", sourceOp: "forget",
  });
  appendTombstoneToRegistry(baseDbPath, "agent-a", { ...t, status: "committed" });
}

describe("tombstone bulk writers", () => {
  it("blocks compaction-shaped merge text", () => {
    const root = mkdtempSync(join(tmpdir(), "tomb-bulk-"));
    const baseDbPath = join(root, "lancedb-namespaced");
    mkdirSync(baseDbPath, { recursive: true });
    forgotten(baseDbPath, "forgotten merge text");
    const guard = assertCardWriteAllowed({
      baseDbPath, agentId: "agent-a", text: "forgotten merge text", scope: "agent-private",
    });
    assert.equal(guard.allowed, false);
    assert.equal(guard.action, "tombstone_blocked");
    rmSync(root, { recursive: true, force: true });
  });
});
```

Add sibling cases whose `text` matches auto-capture `buildCaptureRow` input and light-dream `updated.text` when it differs from `row.text`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tombstone-bulk-writers.test.js`

Expected: FAIL only if the helper regresses; on current `main` this should PASS (guards exist). If it passes immediately, keep it as the lock. Then add one integration case that stubs `table.add` and asserts call count 0 when compaction's merge guard returns blocked — copy the merge `case` setup from `tests/valid-time.test.js` compaction section.

- [ ] **Step 3: If a writer is unguarded, add `assertCardWriteAllowed` before `table.add`**

Do not change light-dream same-text replay.

- [ ] **Step 4: Run focused + `node --test tests/tombstone*.test.js`**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/tombstone-bulk-writers.test.js
git commit -m "test(tombstone): lock bulk writers against forgotten fingerprints"
```

---

### Task 2: Shared prompt-field renderer

**Files:**
- Create: `lib/prompt-memory-fields.js`, `tests/prompt-memory-fields.test.js`
- Modify: `lib/neo-arch.js` `formatNeoRecallContext`, `lib/relevant-memory-context.js`, `lib/conversation-reactivation-recall.js`
- Do not modify: `lib/recall-pipeline.js` `projectRecallEntry`

**Interfaces:**
- Produces: `renderPromptMemoryAttrs(entry) → { status, epistemic, createdAtMs }`
  - `status`: `entry.status` if set, else `"active"`
  - `epistemic`: `normalizeEpistemicStatus(entry.epistemicStatus)` (label only)
  - `createdAtMs`: `parseMemoryTimestamp(entry.createdAt) ?? parseMemoryTimestamp(entry.updatedAt) ?? null`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderPromptMemoryAttrs } from "../lib/prompt-memory-fields.js";

describe("renderPromptMemoryAttrs", () => {
  it("labels missing epistemic as untrusted without inventing a stored value", () => {
    const a = renderPromptMemoryAttrs({ status: "active" });
    assert.equal(a.epistemic, "untrusted");
    assert.equal(a.status, "active");
    assert.equal(a.createdAtMs, null);
  });
  it("does not treat missing status as superseded", () => {
    assert.equal(renderPromptMemoryAttrs({}).status, "active");
  });
});
```

- [ ] **Step 2: Run test**

Run: `node --test tests/prompt-memory-fields.test.js`

Expected: FAIL `Cannot find package` / `renderPromptMemoryAttrs is not a function`

- [ ] **Step 3: Implement `lib/prompt-memory-fields.js` and switch the three formatters to it**

Keep `projectRecallEntry.epistemicStatus` as `row.epistemicStatus || ""`.

- [ ] **Step 4: Run** `node --test tests/prompt-memory-fields.test.js tests/epistemic-status.test.js tests/crr-status-filter.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/prompt-memory-fields.js tests/prompt-memory-fields.test.js lib/neo-arch.js lib/relevant-memory-context.js lib/conversation-reactivation-recall.js
git commit -m "fix(recall): unify prompt status and epistemic labels at render time"
```

---

### Task 3: Global inject cap

**Files:**
- Create: `lib/inject-budget.js`, `tests/inject-budget.test.js`
- Modify: `index.js` prepend join (~10595), `openclaw.plugin.json` `recall` group

**Interfaces:**
- Produces: `applyGlobalInjectBudget({ blocks: Array<{name, text, droppable}>, maxChars }) → string`
  - Drop from the end of `droppable: true` blocks first
  - Never drop blocks named `time`, `temporal`, `reminder`
  - On throw, caller uses original join

- [ ] **Step 1: Write the failing test**

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyGlobalInjectBudget } from "../lib/inject-budget.js";

describe("applyGlobalInjectBudget", () => {
  it("trims memories before time context", () => {
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "memories", text: "M".repeat(100), droppable: true },
        { name: "time", text: "TIME", droppable: false },
      ],
      maxChars: 20,
    });
    assert.match(out, /TIME/);
    assert.ok(out.length <= 20 + 8);
  });
});
```

- [ ] **Step 2: Run** `node --test tests/inject-budget.test.js` — expect FAIL module not found

- [ ] **Step 3: Implement and wrap the join in `index.js`**

```js
prependContext: applyGlobalInjectBudget({
  blocks: [
    { name: "neo", text: neoContext, droppable: true },
    { name: "start", text: startNoticeContext, droppable: true },
    { name: "memories", text: fullMemoriesContext + nudge + conflictNudge + skillProposalNudge, droppable: true },
    { name: "time", text: timeContext, droppable: false },
    { name: "temporal", text: temporalContinuityContext, droppable: false },
    { name: "reminder", text: reminderNudge, droppable: false },
  ],
  maxChars: cfg.recall?.globalInjectMaxChars ?? 17_000,
})
```

- [ ] **Step 4: Run** `node --test tests/inject-budget.test.js tests/b12p-runtime-reachability.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/inject-budget.js tests/inject-budget.test.js index.js openclaw.plugin.json
git commit -m "feat(recall): cap concatenated prompt injection across features"
```

---

### Task 4: Retrieval golden eval (no weight change)

**Files:**
- Create: `tests/fixtures/recall-golden.json`, `tests/recall-golden.test.js`

**Interfaces:**
- Fixture shape: `{ query, items: [{ id, statement, status, epistemicStatus, origin }], expectedOrder: [id…] }`
- Test calls `scoreNeoRecallItem` only

- [ ] **Step 1: Write fixture + test that locks current ranks**

```js
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreNeoRecallItem } from "../lib/neo-arch.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/recall-golden.json", import.meta.url)));

describe("recall golden", () => {
  it("keeps committed rank order", () => {
    const scored = golden.items
      .map((item) => ({ id: item.id, score: scoreNeoRecallItem(item, golden.query) }))
      .sort((a, b) => b.score - a.score);
    assert.deepEqual(scored.map((s) => s.id), golden.expectedOrder);
  });
});
```

Populate `expectedOrder` by running the scorer once and committing the result. Include one `demoted` (must not appear / `-Infinity`) and one `conflict` (finite, below `active`).

- [ ] **Step 2: Run** `node --test tests/recall-golden.test.js` — first run may fail until `expectedOrder` matches; pin it, do not change weights

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/recall-golden.json tests/recall-golden.test.js
git commit -m "test(recall): pin neo score ranks without changing weights"
```

---

### Task 5: Curation resolve command

**Files:**
- Modify: `index.js` curation branch (~6930), `lib/i18n-dictionary.js`
- Test: `tests/curation-resolve.test.js`

**Interfaces:**
- Produces: `/plur1bus curation resolve <id> keep|drop`
  - `keep` → `transitionRecordStatus(record, "promoted")`
  - `drop` → `transitionRecordStatus(record, "demoted")` (already hard-withheld)
  - `checkAuth(..., { destructive: true })`
  - append via existing `appendCandidates`

- [ ] **Step 1: Write failing test** that imports a new `resolveCurationRecord(store, id, action, ctx)` from `lib/curation-resolve.js`

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNeoStore, transitionRecordStatus } from "../lib/neo-arch.js";
import { resolveCurationRecord } from "../lib/curation-resolve.js";

describe("resolveCurationRecord", () => {
  it("keep promotes a conflict record", () => {
    const dir = mkdtempSync(join(tmpdir(), "curation-"));
    const store = createNeoStore(dir, "default");
    const rec = { id: "11111111-1111-4111-8111-111111111111", status: "conflict", statement: "x", category: "workflow_preference" };
    store.appendCandidates([rec]);
    const out = resolveCurationRecord(store, rec.id, "keep", { authorized: true });
    assert.equal(out.ok, true);
    const newest = store.readCandidates(50).filter((r) => r.id === rec.id).at(-1);
    assert.equal(newest.status, "promoted");
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run** — expect FAIL module not found

- [ ] **Step 3: Implement `lib/curation-resolve.js` and wire `index.js`**

Do not add `conflict` to `scoreNeoRecallItem` `-Infinity`.

- [ ] **Step 4: Run** `node --test tests/curation-resolve.test.js tests/neo-demoted-withhold.test.js`

Expected: PASS (`conflict` still finite)

- [ ] **Step 5: Commit**

```bash
git add lib/curation-resolve.js tests/curation-resolve.test.js index.js lib/i18n-dictionary.js
git commit -m "feat(curation): resolve conflict records via keep or drop"
```

---

### Task 6: Drift-gate consumer on conflict apply

**Files:**
- Create: `lib/jobs/apply-conflict-resolution.js`, `tests/apply-conflict-resolution.test.js`
- Modify: `lib/jobs/conflict-resolver.js` (call the adapter when `recommendation === "apply_via_safe_reconsolidation"` **and** `opts.confirm === true`)

**Interfaces:**
- Produces: `applyConflictViaSafeUpdate(db, conflict, opts) → { ok, reason }`
  - calls `safeUpdate` **without** `skipDriftGate`
  - on drift throw, return `{ ok: false, reason: "review_only" }`
  - requires `opts.confirm === true`

- [ ] **Step 1: Write failing test**

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyConflictViaSafeUpdate } from "../lib/jobs/apply-conflict-resolution.js";

describe("applyConflictViaSafeUpdate", () => {
  it("refuses without confirm", async () => {
    const out = await applyConflictViaSafeUpdate({}, { id: "x" }, { confirm: false });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "confirm_required");
  });
});
```

- [ ] **Step 2: Run** — expect FAIL module not found

- [ ] **Step 3: Implement adapter; do not set `skipDriftGate`**

`/correct` at `index.js` stays `skipDriftGate: true`.

- [ ] **Step 4: Run** `node --test tests/apply-conflict-resolution.test.js tests/safe-update-dataloss.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/jobs/apply-conflict-resolution.js tests/apply-conflict-resolution.test.js lib/jobs/conflict-resolver.js
git commit -m "feat(conflict): apply reconsolidation through safeUpdate drift gate"
```

---

### Task 7: Derived-record scope schema then readers

**Files:**
- Modify: `lib/episodes.js` `createEpisode`, `lib/memory-graph.js` `createEdge`, dream/pattern writers that already have `aclBindings`
- Modify: `lib/neo-arch.js` `readDreams` / `readEpisodes` / `readGraphEdges` / `readPatterns` — add optional `requester` **only after** writers stamp `visibility`
- Test: `tests/derived-record-scope.test.js`

**Interfaces:**
- New records: `visibility: { scope, agentId, workspaceIdentity, ownerUserId }`
- `isDerivedRecordAccessible(record, requester)` — if `visibility.scope` missing, allow only when `record.agentId === requester.agentId` (fail-closed otherwise)
- Readers: `(limit, requester)` ; omit `requester` → current unfiltered behavior (compat)

- [ ] **Step 1: Write failing tests for writer stamp + reader filter**

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDerivedRecordAccessible } from "../lib/neo-arch.js";

describe("derived record ACL", () => {
  it("denies a foreign agent when visibility is missing", () => {
    assert.equal(isDerivedRecordAccessible(
      { agentId: "a" },
      { agentId: "b" },
    ), false);
  });
  it("allows the owning agent on a legacy unscoped row", () => {
    assert.equal(isDerivedRecordAccessible(
      { agentId: "a" },
      { agentId: "a" },
    ), true);
  });
});
```

- [ ] **Step 2: Run** — expect FAIL export missing

- [ ] **Step 3: Implement helper, stamp on create, then thread optional requester**

Do not pass requester from existing callers until stamps ship.

- [ ] **Step 4: Run** `node --test tests/derived-record-scope.test.js tests/smoke-neo.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/neo-arch.js lib/episodes.js lib/memory-graph.js lib/dreaming/*.js tests/derived-record-scope.test.js
git commit -m "feat(neo): stamp and honor scope on derived records"
```

---

### Task 8: Host-patch skip flag (do not remove patch)

**Files:**
- Modify: `scripts/setup-feature-crons.mjs`, `patches/apply-cron-plugin-direct-dispatch.mjs` header comment, `README.md` install note
- Test: existing `tests/cron-plugin-direct-dispatch-patch.test.js` plus one env case

**Interfaces:**
- `process.env.PLUR1BUS_SKIP_HOST_PATCH === "1"` → skip `applyCronPluginDirectDispatchPatch`, still exit 0

- [ ] **Step 1: Write failing test** that `PLUR1BUS_SKIP_HOST_PATCH=1` does not call apply

- [ ] **Step 2: Run** — expect FAIL

- [ ] **Step 3: Gate the apply call; add Atlas objection comment at the callsite**

- [ ] **Step 4: Run** `node --test tests/cron-plugin-direct-dispatch-patch.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-feature-crons.mjs patches/apply-cron-plugin-direct-dispatch.mjs README.md tests/cron-plugin-direct-dispatch-patch.test.js
git commit -m "docs(install): allow skipping the host cron patch"
```

---

## Execution order

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

Each task is its own branch off `origin/main` if shipping separately; otherwise sequential commits on one branch.
