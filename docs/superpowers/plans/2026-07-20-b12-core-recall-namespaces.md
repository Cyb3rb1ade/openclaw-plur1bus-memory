# B12-Core Recall and Namespaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close FA-03 and FE-ADD-05 by making same-agent multi-namespace recall schema-reachable, path-safe, role-safe, and correctly merged through both registered recall entry points.

**Architecture:** Preserve absent-config legacy-flat storage exactly, while an explicitly supplied `namespaces` object selects a normalized immutable named layout. The pool resolves and validates every namespace and agent path, opens legacy routes without creating or migrating them, and both public recall paths use one pure global merge for result, canonical, and trace output. B12-Core deliberately does not implement any FA-07 runtime option; those remain B12-P.

**Tech Stack:** Node.js ESM, OpenClaw plugin registration, LanceDB, manifest-derived configuration, existing B7 database leases, Node `node:test`.

---

## Binding scope and base

- Worktree: `/root/openclaw-plur1bus-memory/.worktrees/fix-high-mid-audit-findings`
- Branch: `fix/high-mid-audit-findings`
- Planning HEAD: `a53e244` (`docs: close OpenClaw default LLM review`)
- In scope: FA-03 and FE-ADD-05 only.
- Out of scope until B12-P: Query Refinement wiring, `candidateTopK` behavior changes, Adaptive Budget, Semantic Compression, GraphIndex, and Pattern Surfacing.
- Out of scope until B13: cross-agent/workspace/user sharing and ACL redesign.
- Multi-namespace means the same validated `agentId` across named storage namespaces. It is not cross-agent recall.
- Every configured existing namespace is required for a recall. A genuinely
  absent legacy-read-only table is skipped; every other initialization/query
  failure rejects the public recall without returning another namespace's
  partial results.
- Existing B7 lease/shutdown semantics, B3 outer timeout/admission behavior, per-agent auth/model routing, Semantic Lens, and CRR remain unchanged.

## File responsibilities

- `openclaw.plugin.json`: strict public `namespaces` schema only.
- `lib/setup/config-contract.js`: generic JSON-schema `pattern` validation.
- `lib/namespace-config.js`: pure validation and immutable layout normalization.
- `lib/multi-namespace-pool.js`: validated route construction and read/write role enforcement.
- `index.js`: raw-presence capture, safe pool construction, legacy read-only DB mode, and shared merge invocation in tool/hook.
- `lib/recall-pipeline.js`: pure `mergeNamespaceRecallResults()` helper.
- `lib/recall-decision-trace.js`: optional sanitized namespace provenance on existing event helpers.
- Tests: unit contracts plus one real registered tool/hook integration test.
- Docs/receipt: current behavior and exact remediation evidence.

## Authoritative configuration contract

The manifest exposes this strict optional object:

```json
{
  "namespaces": {
    "activeWriteNamespace": "lancedb-local",
    "activeRecallNamespaces": ["lancedb-local"],
    "legacyReadOnlyNamespaces": ["lancedb-namespaced"],
    "crossNamespaceRecall": true
  }
}
```

Every identifier matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. Arrays contain
only identifiers; an explicitly supplied active-recall array has at least one
item. The optional object and its children have no manifest defaults, so an
absent raw `namespaces` key remains absent after B11 materialization.
`crossNamespaceRecall` is semantically false unless explicitly true. Runtime
semantic defaults are:

```text
write = activeWriteNamespace || DEFAULT_NAMESPACE
active recall = activeRecallNamespaces || [write]
legacy recall = crossNamespaceRecall ? legacyReadOnlyNamespaces || [] : []
```

The writer must be present in active recall. The entire active-recall set is
disjoint from the configured legacy-read-only set. Stable duplicates collapse;
invalid values and overlaps fail with the exact plugin config path.

`resolveNamespaceLayout(baseDbPath, effectiveNamespaces, { explicit, path })`
returns a deeply frozen layout:

```js
{
  mode: "legacy-flat" | "named",
  baseDir,
  baseDbPath,
  activeWriteNamespace: string | null,
  activeRecallNamespaces: readonly string[],
  legacyReadOnlyNamespaces: readonly string[],
  recallReadNamespaces: readonly string[],
  crossNamespaceRecall: boolean,
}
```

- `explicit:false`: `baseDbPath/{agentId}` stays exact; its basename is not
  interpreted as a namespace.
- `explicit:true` and `basename(baseDbPath) === activeWriteNamespace`: the
  named root is `dirname(baseDbPath)`, preserving the existing active path.
- `explicit:true` and the basename matches no configured namespace:
  `baseDbPath` is the named root.
- If the basename matches a configured non-write namespace, reject the
  ambiguous layout instead of silently rewriting it or routing through `.`.

## Authoritative merge contract

`mergeNamespaceRecallResults(namespaceResults, options)` performs exactly one
cross-namespace merge after the existing per-table pipeline:

```js
{
  maxOut,
  canonicalMaxItems,
  dedupEnabled,
  dedupJaccard,
  trace,
}
```

It stable-sorts memory candidates globally by score, collapses duplicate IDs
with the higher score winning, applies `dedupResults(memories, memorySlots,
dedupJaccard)` only when dedup is enabled, deduplicates canonical items by
normalized heading plus text, caps canonical globally, and ensures
`canonical.length + memories.length <= maxOut`. It clones output wrappers,
retains all entry ownership fields, labels the wrapper with the validated
namespace, and never mutates inputs. Child traces are replayed into one master
through the existing capped add-helpers with a sanitized `namespace` field;
cross-namespace drops are recorded as `deduped`, then the summary is recomputed.

### Task 1: Schema and immutable namespace layout

**Files:**
- Modify: `tests/config-contract.test.js`
- Modify: `tests/namespace-config.test.js`
- Modify: `openclaw.plugin.json`
- Modify: `lib/setup/config-contract.js`
- Modify: `lib/namespace-config.js`

- [ ] **Step 1: Write the schema RED tests**

Replace only `namespaces` in the B11 unreachable loop and add assertions equivalent to:

```js
const raw = {
  namespaces: {
    activeWriteNamespace: "ns-write",
    activeRecallNamespaces: ["ns-write", "ns-read"],
    legacyReadOnlyNamespaces: ["ns-old"],
    crossNamespaceRecall: true,
  },
};
const cfg = resolveEffectiveConfig(raw);
assert.deepEqual(cfg.namespaces, raw.namespaces);
assert.equal(Object.isFrozen(cfg.namespaces), true);
assert.equal(Object.hasOwn(resolveEffectiveConfig({}), "namespaces"), false);

assertConfigError(
  () => validatePluginConfig({ namespaces: { activeWriteNamespace: "../escape" } }),
  `${PLUGIN_CONFIG_PATH}.namespaces.activeWriteNamespace`,
  /pattern|format/i,
);
assertConfigError(
  () => validatePluginConfig({ namespaces: { activeRecallNamespaces: ["ok", "bad/name"] } }),
  `${PLUGIN_CONFIG_PATH}.namespaces.activeRecallNamespaces[1]`,
  /pattern|format/i,
);
```

Keep `retroactiveInterference` and `quietHours` unreachable.

- [ ] **Step 2: Run the schema tests and verify RED**

Run:

```bash
node --test --test-concurrency=1 tests/config-contract.test.js
```

Expected: namespace-valid input fails as an unknown top-level field and the
malicious-value assertions do not yet reach pattern validation.

- [ ] **Step 3: Add manifest schema plus generic pattern validation**

Add a top-level strict `namespaces` object with the four fields above and no
object/child defaults. Add this generic branch to `validateNode()` after
type/enum checks:

```js
if (typeof value === "string" && schema.pattern !== undefined) {
  const expression = new RegExp(schema.pattern);
  if (!expression.test(value)) errorAt(configPath, `must match ${schema.pattern}`);
}
```

Do not special-case namespace field names in the config validator and do not
add any FA-07 schema in this task.

- [ ] **Step 4: Run schema tests and verify GREEN**

Run the command from Step 2. Expected: all pass.

- [ ] **Step 5: Write layout RED tests**

Replace the old loose resolver expectations with tests for:

```js
resolveNamespaceLayout("/db/custom", {}, { explicit: false, path: NS_PATH })
// legacy-flat; baseDbPath === "/db/custom"; no named writer

resolveNamespaceLayout("/memory/ns-write", {
  activeWriteNamespace: "ns-write",
  activeRecallNamespaces: ["ns-write", "ns-read"],
  legacyReadOnlyNamespaces: ["ns-old"],
  crossNamespaceRecall: true,
}, { explicit: true, path: NS_PATH })
// baseDir === "/memory"; reads ["ns-write", "ns-read", "ns-old"]

resolveNamespaceLayout("/memory", {
  activeWriteNamespace: "ns-write",
}, { explicit: true, path: NS_PATH })
// baseDir === "/memory"; active recall defaults to ["ns-write"]
```

Also assert exact-path rejection for empty active recall, write missing from
active recall, active/legacy overlap, traversal, slash, backslash, whitespace,
absolute, and overlong identifiers; reject a `baseDbPath` ending in configured
`ns-old` when the writer is `ns-write`; prove input mutation cannot change the
frozen result.

- [ ] **Step 6: Run layout tests and verify RED**

Run:

```bash
node --test --test-concurrency=1 tests/namespace-config.test.js
```

Expected: FAIL because `resolveNamespaceLayout` does not exist and loose
resolvers accept invalid/overlapping input.

- [ ] **Step 7: Implement the minimal layout normalizer**

Export the constant and function with focused JSDoc. Use
`ConfigContractError`, `basename`, and `dirname`; clone/deduplicate arrays
before deep-freezing. Retain the three old exports only as compatibility
wrappers over normalized semantic defaults, never as a second validator.

- [ ] **Step 8: Run Task 1 GREEN and commit**

```bash
node --test --test-concurrency=1 \
  tests/config-contract.test.js tests/namespace-config.test.js \
  tests/runtime-config-contract.test.js tests/config-audit.test.js
node --check lib/setup/config-contract.js
node --check lib/namespace-config.js
git diff --check
git add openclaw.plugin.json lib/setup/config-contract.js lib/namespace-config.js \
  tests/config-contract.test.js tests/namespace-config.test.js
git commit -m "feat: validate namespace configuration"
```

### Task 2: Contained pool paths and non-mutating legacy reads

**Files:**
- Modify: `tests/multi-namespace-pool.test.js`
- Create: `tests/memory-db-readonly.test.js`
- Modify: `tests/runtime-config-contract.test.js`
- Modify: `lib/multi-namespace-pool.js`
- Modify: `index.js`

- [ ] **Step 1: Write pool/path RED tests**

Construct pools only from `resolveNamespaceLayout()` output and prove:

```js
assert.throws(() => pool.getWriteDb("../agent"), /Invalid agent ID/);
assert.throws(() => pool.getReadDbs("agent/name"), /Invalid agent ID/);
assert.equal(pool.layout.activeWriteNamespace, "ns-write");
```

Add real temporary-directory fixtures for an outside symlink namespace and two
valid names resolving to the same in-root target. Both must reject before a
child pool is created. Mutating the original config arrays after layout/pool
creation must not create a late route. Write aliases must never construct a
legacy-read-only child. Preserve existing ordered nested leases, reverse
release, shutdown coalescing, and contextual aggregate failures.

- [ ] **Step 2: Run pool tests and verify RED**

```bash
node --test --test-concurrency=1 tests/multi-namespace-pool.test.js
```

Expected: malicious agent IDs and symlink/collision paths are accepted or
routed by raw `join()`, and the constructor still consumes mutable raw config.

- [ ] **Step 3: Implement contained pool routing**

Make `MultiNamespacePool` consume the frozen layout. Precompute canonical
namespace paths with `resolveInside(layout.baseDir, namespace)` and reject a
duplicate canonical target. Revalidate the namespace and containment in
`_getPool()`. Call `safeAgentId(agentId || "default")` in every public alias.
Pass `{ readOnly: true }` only for configured legacy children. Keep
`_trackOperation`, acquisition order, and shutdown mechanics unchanged.

- [ ] **Step 4: Write legacy-read-only RED tests**

Create a minimal real LanceDB `memories` table under a legacy namespace, record
its schema field names and filesystem state, then open it through
`MemoryDB(..., { readOnly: true })`. Assert the table remains queryable and the
schema/path state is unchanged. For a missing legacy agent path and an existing
directory without `memories`, assert `init()` returns `false`, leaves
`table === null`, creates no directory/table, and calls no `addColumns`.

- [ ] **Step 5: Run read-only tests and verify RED**

```bash
node --test --test-concurrency=1 tests/memory-db-readonly.test.js
```

Expected: current `MemoryDB.init()` creates a missing table and migrates an
existing legacy table.

- [ ] **Step 6: Implement read-only MemoryDB/AgentDbPool mode**

Extend constructors without changing active defaults:

```js
new MemoryDB(dbPath, vectorDim, logger, { readOnly: true })
new AgentDbPool(basePath, vectorDim, logger, { readOnly: true })
```

In read-only mode, validate the agent with `safeAgentId`, resolve its final path
with `resolveInside`, return `false` before connecting if the path is absent,
open only an existing `memories` table, refresh schema fields, and skip every
create/migration call. Active mode retains current create/migrate behavior.

- [ ] **Step 7: Write runtime-layout RED tests**

Extend `tests/runtime-config-contract.test.js` to prove raw absence keeps
`baseDbPath/{agentId}`, explicit root produces
`baseDbPath/ns-write/{agentId}`, explicit leaf `.../ns-write` preserves that
same active path, and an ambiguous non-write leaf rejects with the exact
`.namespaces` config path. Invalid config must still reject before the first
API/filesystem action.

- [ ] **Step 8: Wire raw presence and safe layout in `index.js`**

Use exactly one raw-presence capture before effective resolution:

```js
const rawPluginConfig = api.pluginConfig || {};
const namespacesExplicit = Object.hasOwn(rawPluginConfig, "namespaces");
let cfg = resolveEffectiveConfig(rawPluginConfig);
const baseDbPath = api.resolvePath(cfg.baseDbPath || DEFAULT_BASE_DB_PATH);
const namespaceLayout = resolveNamespaceLayout(baseDbPath, cfg.namespaces, {
  explicit: namespacesExplicit,
  path: `${PLUGIN_CONFIG_PATH}.namespaces`,
});
```

Delete the `"."` heuristic. Construct the pool from `namespaceLayout`. In both
recall paths, retain only read entries whose `await db.init()` result is not
`false` and whose `db.table` exists; an absent legacy table is skipped, while
any real initialization error rejects the whole recall.

- [ ] **Step 9: Run Task 2 GREEN and commit**

```bash
node --test --test-concurrency=1 \
  tests/multi-namespace-pool.test.js tests/memory-db-readonly.test.js \
  tests/runtime-config-contract.test.js tests/agent-db-pool-lease.test.js
node --check index.js
node --check lib/multi-namespace-pool.js
git diff --check
git add index.js lib/multi-namespace-pool.js \
  tests/multi-namespace-pool.test.js tests/memory-db-readonly.test.js \
  tests/runtime-config-contract.test.js
git commit -m "fix: contain namespace storage routes"
```

### Task 3: Correct result, canonical, and trace merge on both public paths

**Files:**
- Create: `tests/namespace-recall-merge.test.js`
- Create: `tests/multi-namespace-recall-runtime.test.js`
- Modify: `tests/recall-decision-trace.test.js`
- Modify: `lib/recall-pipeline.js`
- Modify: `lib/recall-decision-trace.js`
- Modify: `index.js`

- [ ] **Step 1: Write pure merge RED tests**

Build two namespace results with globally interleaved scores, one duplicate ID,
two near-duplicate texts, duplicated canonical content, and child traces.
Assert:

```js
const merged = mergeNamespaceRecallResults(inputs, {
  maxOut: 4,
  canonicalMaxItems: 1,
  dedupEnabled: true,
  dedupJaccard: 0.78,
  trace: master,
});
assert.deepEqual(merged.memories.map((item) => item.entry.id), ["a-high", "b-high", "a-low"]);
assert.equal(merged.canonical.length, 1);
assert.deepEqual(new Set(merged.trace.candidates.map((item) => item.namespace)), new Set(["ns-a", "ns-b"]));
```

Add separate tests proving `dedupEnabled:false` preserves similar different-ID
rows, `maxOut` includes canonical slots, duplicate IDs keep the higher score,
ties preserve configured namespace order, ownership fields survive, and input
objects/arrays remain byte/deep identical.

- [ ] **Step 2: Run merge tests and verify RED**

```bash
node --test --test-concurrency=1 \
  tests/namespace-recall-merge.test.js tests/recall-decision-trace.test.js
```

Expected: missing merge export and missing namespace trace provenance.

- [ ] **Step 3: Implement namespace-aware trace replay and pure merge**

Add optional sanitized `namespace` fields to `addTraceCandidate`,
`addTraceDecision`, `addTraceGuard`, and `addTraceStoreDecision`, with matching
JSDoc. Export `mergeNamespaceRecallResults()` from `lib/recall-pipeline.js`.
Use the existing add-helpers to replay child events into the master, use
`dedupResults(flat, memorySlots, dedupJaccard)` with all three arguments, add
cross-namespace dedup decisions, and call `summarizeTrace()` once at the end.

- [ ] **Step 4: Run pure merge GREEN**

Run the command from Step 2. Expected: all pass.

- [ ] **Step 5: Write registered runtime RED tests**

With two real same-dimension namespace tables for one agent, traverse the
registered `memory_recall`, its `memory_search` alias, and
`before_prompt_build`. Prove all three return one legitimate A record and one
legitimate B record; Canonical `KNOWLEDGE.md` appears once; decision-trace
events carry both namespace labels; `limit` is respected globally; and
`dedup:false` preserves similar distinct records. Traverse `memory_store` and
prove it changes only the active writer while the legacy table's row count and
schema remain unchanged. Also prove a configured namespace initialization
error rejects without returning the other namespace's partial result.

- [ ] **Step 6: Run runtime tests and verify RED**

```bash
node --test --test-concurrency=1 tests/multi-namespace-recall-runtime.test.js
```

Expected: valid `namespaces` was previously unreachable or the current merge
returns only one memory, duplicates canonical, and retains only the first trace.

- [ ] **Step 7: Wire the same helper into tool and hook**

For multi-namespace calls, create one child trace and phase timer per namespace,
run the existing pipeline, and attach `{ namespace }` to its result. Run
canonical search only for the first configured namespace. Suppress child
retrieval-ledger callbacks, merge once through `mergeNamespaceRecallResults`,
then emit the existing retrieval entry once for final IDs. Keep the single-
namespace path behavior unchanged. Use the identical helper/options in
`memory_recall`/`memory_search` and `before_prompt_build`.

- [ ] **Step 8: Run Task 3 GREEN and commit**

```bash
node --test --test-concurrency=1 \
  tests/namespace-recall-merge.test.js \
  tests/multi-namespace-recall-runtime.test.js \
  tests/recall-decision-trace.test.js \
  tests/recall-pipeline-decision-trace.test.js \
  tests/auto-recall-decision-trace.test.js \
  tests/recall-p0.test.js tests/smoke-reranker-pipeline.test.js
node --check index.js
node --check lib/recall-pipeline.js
node --check lib/recall-decision-trace.js
git diff --check
git add index.js lib/recall-pipeline.js lib/recall-decision-trace.js \
  tests/namespace-recall-merge.test.js tests/multi-namespace-recall-runtime.test.js \
  tests/recall-decision-trace.test.js
git commit -m "fix: merge multi-namespace recall globally"
```

### Task 4: Documentation, receipt, independent reviews, and B12-Core gates

**Files:**
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/recall-architecture.md`
- Create: `docs/audits/2026-07-20-b12-core-recall-namespaces-fix.md`
- Modify: `.superpowers/sdd/progress.md`

- [ ] **Step 1: Update current-behavior docs**

Replace the incorrect cross-agent claim with same-agent named storage routing.
Document legacy-flat absence compatibility, explicit root versus active-leaf
base paths, identifier syntax, role disjointness, cross-namespace opt-in,
legacy non-mutating reads, shared embedding dimension expectation, global
result/canonical/trace caps, and that sharing remains B13.

- [ ] **Step 2: Create the B12-Core receipt**

Record exact base/fix commits, changed files, every observed RED/GREEN, public
tool/hook proof, malicious path/symlink/collision proof, legacy read-only proof,
positive same-agent multi-namespace behavior, bypass review, and remaining
uncertainty. Mark FA-03 CLOSED and FE-ADD-05 CLOSED. State explicitly:

> FA-07 remains OPEN for B12-P. B12-Core did not expose or change Query
> Refinement, Semantic Compression, Adaptive Budget, GraphIndex,
> candidateTopK runtime behavior, or Pattern Surfacing.

- [ ] **Step 3: Run the B12-Core focused gate**

```bash
node --test --test-concurrency=1 \
  tests/config-contract.test.js tests/runtime-config-contract.test.js \
  tests/config-audit.test.js tests/namespace-config.test.js \
  tests/multi-namespace-pool.test.js tests/memory-db-readonly.test.js \
  tests/namespace-recall-merge.test.js tests/multi-namespace-recall-runtime.test.js \
  tests/recall-decision-trace.test.js tests/recall-pipeline-decision-trace.test.js \
  tests/auto-recall-decision-trace.test.js tests/agent-db-pool-lease.test.js \
  tests/runtime-scheduler-b3.test.js tests/deploy-integrity.test.js \
  tests/recall-p0.test.js tests/smoke-reranker-pipeline.test.js
npm run lint
git diff --check
```

- [ ] **Step 4: Perform independent spec then quality/security review**

The spec reviewer must map every FA-03 and FE-ADD-05 clause to source plus a
causal test and confirm no FA-07/B13 behavior was added. Only after PASS, a
fresh quality/security reviewer checks traversal, symlink/canonical collision,
agent validation, read-only bypasses, config ambiguity, mutation, result/trace
caps, partial-result leakage, leases, and docs/source drift. Fix every validated
Critical/Important finding with a new RED-GREEN cycle and repeat both reviews.

- [ ] **Step 5: Run the authoritative serial suite**

```bash
node --test --test-concurrency=1 tests/*.test.js test/*.test.js
```

Require zero failures and no new skip. Record exact suites/tests/pass/fail/skip,
duration, and the unchanged root-only permission skip if present.

- [ ] **Step 6: Commit closure and preserve boundaries**

```bash
git add README.md docs/configuration.md docs/recall-architecture.md \
  docs/audits/2026-07-20-b12-core-recall-namespaces-fix.md \
  .superpowers/sdd/progress.md
git commit -m "docs: close B12 core recall remediation"
git status --short --branch
git diff --check a53e244..HEAD
git -C /root/openclaw-plur1bus-memory status --short --branch
```

Expected: clean feature worktree; clean untouched `main...origin/main`; no push.

## Self-review

- Spec coverage: every FA-03 defect (wrong `dedupResults` arity, canonical
  duplication, first-trace-only behavior, unreachable config, misleading
  cross-agent docs) and every FE-ADD-05 invariant (strict identifiers,
  containment, collision rejection, explicit opt-in, disjoint roles, no `.`
  collapse, positive multi-read path) maps to a task and causal test.
- Scope check: all six FA-07 lanes, B13 sharing/ACL, provider/dimension
  migrations, and unrelated storage redesigns remain excluded.
- Type consistency: all tasks use `resolveNamespaceLayout`, frozen layout field
  names, `MemoryDB/AgentDbPool(..., { readOnly })`, and
  `mergeNamespaceRecallResults` consistently.
- Placeholder scan: every implementation step names its test, command, and
  expected failure/error contract.
