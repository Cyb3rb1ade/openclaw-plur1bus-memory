# Neo MainThread Drain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Neo Capture and embedding-status drain enabled while moving heavy synchronous work out of the Gateway MainThread and making replay idempotent.

**Architecture:** Add a Worker Thread runtime for Neo capture/drain so synchronous JSONL work no longer runs on the Gateway MainThread. Add deterministic IDs and append-time dedupe to Neo JSONL records so full-history replay does not repeatedly append old turns. Keep JSONL as the durable audit format for this phase.

**Tech Stack:** Node.js ES modules, built-in `node:test`, built-in `node:fs`, existing PLUR1BUS Neo JSONL store.

---

## File Structure

- Modify `/.openclaw/extensions/memory-lancedb-namespaced/lib/neo-arch.js`
  - Add deterministic Neo ID helpers.
  - Add append-time dedupe for primary Neo JSONL stores.
  - Keep existing exported APIs compatible.
- Create `/.openclaw/extensions/memory-lancedb-namespaced/lib/neo-worker-runtime.js`
  - Manage a long-lived Worker Thread.
  - Provide `runNeoAgentEnd(event, ctx, options)`.
- Create `/.openclaw/extensions/memory-lancedb-namespaced/lib/neo-worker-runner.js`
  - Execute `recordHook`, `captureNeoFromAgentEnd`, and `drainEmbeddingQueue` inside the worker.
- Modify `/.openclaw/extensions/memory-lancedb-namespaced/index.js`
  - Create Neo runtime during plugin registration.
  - Replace inline capture/drain with runtime enqueue.
- Modify `/.openclaw/extensions/memory-lancedb-namespaced/tests/smoke-neo.test.js`
  - Add deterministic replay/dedupe tests.
- Create `/.openclaw/extensions/memory-lancedb-namespaced/tests/neo-worker-runtime.test.js`
  - Add worker runtime tests.

### Task 1: Deterministic Neo IDs And Append Dedupe

**Files:**
- Modify: `/.openclaw/extensions/memory-lancedb-namespaced/lib/neo-arch.js`
- Test: `/.openclaw/extensions/memory-lancedb-namespaced/tests/smoke-neo.test.js`

- [ ] **Step 1: Write failing replay test**

Add a test that creates a Neo store, calls `captureNeoFromAgentEnd()` twice with the same messages, then asserts `turn-journal.jsonl`, `memory-candidates.jsonl`, and `embedding-queue.jsonl` do not grow on the second replay for already-seen records.

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
node --test tests/smoke-neo.test.js
```

Expected: the new replay test fails because IDs are currently random and append dedupe does not exist.

- [ ] **Step 3: Implement deterministic IDs**

In `neo-arch.js`, import `createHash` from `node:crypto` alongside `randomUUID`. Add helpers:

```js
function stableHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
}

function stableNeoId(prefix, parts = []) {
  return `${prefix}_${stableHash(parts.map(part => String(part || "")).join("\u001f"))}`;
}
```

Use stable IDs in:

- `turnEventsFromMessages()`: include workspace key, agent id, session id, role, timestamp when available, index, and normalized content.
- `memoryCandidatesFromTurns()`: derive from source turn id plus normalized statement.
- `reactionSignalsFromTurns()`: derive from source turn id plus polarity/target.
- `behaviorCardsFromReactions()`: derive from source signal id plus statement.

- [ ] **Step 4: Implement append-time dedupe**

Add `appendJsonlDedupe(path, items, options)` that reads recent IDs from the target file and appends only records whose `id` is absent. Use this for turns, candidates, reactions, behavior cards, and embedding queue. For the queue, dedupe by a stable queue ID or by `targetType + targetId + status`.

- [ ] **Step 5: Run test and verify GREEN**

Run:

```bash
node --test tests/smoke-neo.test.js
```

Expected: replay test passes and existing Neo smoke tests still pass.

### Task 2: Neo Worker Runtime

**Files:**
- Create: `/.openclaw/extensions/memory-lancedb-namespaced/lib/neo-worker-runtime.js`
- Create: `/.openclaw/extensions/memory-lancedb-namespaced/lib/neo-worker-runner.js`
- Test: `/.openclaw/extensions/memory-lancedb-namespaced/tests/neo-worker-runtime.test.js`

- [ ] **Step 1: Write failing scheduler tests**

Create tests for:

- `runNeoAgentEnd()` returns capture and drain counts from the worker.
- the worker writes Neo JSONL files correctly.
- worker errors are surfaced as rejected promises to the caller.
- terminating the runtime cleans up the worker.

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
node --test tests/neo-worker-runtime.test.js
```

Expected: fails because `lib/neo-worker-runtime.js` does not exist.

- [ ] **Step 3: Implement runtime module**

Create `createNeoWorkerRuntime(options)`:

```js
export function createNeoWorkerRuntime(options = {}) {
  return {
    runNeoAgentEnd(event, ctx, jobOptions) {
      // post job to Worker and resolve with worker result
    },
    async close() {
      // terminate worker
    },
  };
}
```

- [ ] **Step 4: Run test and verify GREEN**

Run:

```bash
node --test tests/neo-worker-runtime.test.js
```

Expected: worker runtime tests pass.

### Task 3: Wire Runtime Into Plugin Hook

**Files:**
- Modify: `/.openclaw/extensions/memory-lancedb-namespaced/index.js`
- Test: `/.openclaw/extensions/memory-lancedb-namespaced/tests/*.test.js`

- [ ] **Step 1: Add import**

Import `createNeoWorkerRuntime` from `./lib/neo-worker-runtime.js`.

- [ ] **Step 2: Create runtime after Neo config is resolved**

Inside `register()`, after `neoWorkspaceAliases` and drain config are defined, create:

```js
const neoWorkerRuntime = createNeoWorkerRuntime({
  logger: api.logger,
});
```

- [ ] **Step 3: Replace inline hook work**

In the `agent_end` Neo block, replace direct `captureNeoFromAgentEnd(...)` and direct `neoStore.drainEmbeddingQueue(...)` with:

```js
const neoResult = await neoWorkerRuntime.runNeoAgentEnd(event, ctx, {
  rootDir: neoRoot,
  hookMeta: {
    agentId,
    sessionId: event?.sessionId || event?.sessionKey || event?.runId || "",
    runner: event?.runner || event?.provider || "",
    background,
  },
  config: { obsidianBridge: obsidianBridgeCfg, neo: neoCfg },
  workspaceAliases: neoWorkspaceAliases,
  embeddingDrainEnabled: neoEmbeddingAutoDrainEnabled,
  embeddingDrainImpact: neoEmbeddingDrainImpact,
  embeddingDrainMaxItems: neoEmbeddingDrainMaxItems,
});
api.logger.info?.(`plur1bus-neo: worker captured turns=${neoResult.capture.turns}, candidates=${neoResult.capture.candidates}, reactions=${neoResult.capture.reactions}, behaviorCards=${neoResult.capture.behaviorCards}${background ? " (background)" : ""}`);
```

- [ ] **Step 4: Run all unit tests**

Run:

```bash
node --test tests/*.test.js
```

Expected: all tests pass.

### Task 4: Verification And Review

**Files:**
- Verify changed files only.

- [ ] **Step 1: Inspect diff**

Run:

```bash
git diff -- lib/neo-arch.js lib/neo-worker-runtime.js lib/neo-worker-runner.js index.js tests/smoke-neo.test.js tests/neo-worker-runtime.test.js
```

Expected: changes are limited to Neo runtime/capture/drain and tests.

- [ ] **Step 2: Run focused tests**

Run:

```bash
node --test tests/smoke-neo.test.js tests/neo-worker-runtime.test.js
```

Expected: both focused test files pass.

- [ ] **Step 3: Run full unit suite**

Run:

```bash
node --test tests/*.test.js
```

Expected: full unit suite passes or any unrelated baseline failures are identified precisely.
