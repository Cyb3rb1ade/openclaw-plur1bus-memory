# Copy-on-Write Re-Embedding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a resumable, verified copy-on-write migration that safely changes embedding model, revision, options, or dimensions without mutating or losing the active memory generation.

**Architecture:** Pure fingerprint and state-machine modules drive an injected LanceDB/provider backend. Planning is source-read-only; apply writes a quarantined target generation; validation proves row/metadata/vector integrity; switch uses an OpenClaw host-mediated config mutation and maintenance gate; completed rollback is a reverse copy-on-write migration.

**Tech Stack:** Node.js 24 ESM, LanceDB `0.26.2`, OpenClaw Gateway/config/lifecycle APIs `2026.8.1-beta.3`, Transformers.js `4.2.0`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-27-workspace-control-plane-reembedding-design.md`

## Global Constraints

- Source namespaces and rollback generations are never overwritten, repointed after divergence, or automatically deleted.
- Fingerprints include provider, model, immutable revision, dimensions, endpoint identity, prefixes, pooling, normalization, local artifact identities, and schema version.
- Any vector-space change requires migration even at equal dimensions; credential-only rotation does not.
- Apply/switch/resume/rollback require `operator.admin` and a hash-bound expiring confirmation.
- All paths use `safeAgentId` and `resolveInside`; unknown/multiple/drifted sources fail closed.
- Cursor progress persists only after target write plus read-back verification.
- Switch blocks only PLUR1BUS reads/writes; ordinary OpenClaw messages remain available.
- Exact packed PLUR1BUS `7.5.0` must perform the real migration under OpenClaw `2026.8.1-beta.3`.

---

### Task 1: Immutable embedding fingerprints

**Files:**
- Create: `lib/reembedding/fingerprint.js`
- Test: `tests/reembedding-fingerprint.test.js`

**Interfaces:**
- Produces: `normalizeEmbeddingFingerprint(config, artifactIdentities)`, `embeddingFingerprintId(fingerprint)`, and `compareEmbeddingFingerprints(left, right)`.

- [ ] **Step 1: Write failing canonicalization tests**

```js
const a = normalizeEmbeddingFingerprint({ provider: "local-transformers", model: "m", revision: "abc", dimensions: 384, normalize: true }, [{ path: "onnx/model.onnx", sha256: "a".repeat(64) }]);
assert.equal(embeddingFingerprintId(a), embeddingFingerprintId({ ...a }));
assert.equal(compareEmbeddingFingerprints(a, { ...a, revision: "def" }).requiresMigration, true);
assert.equal(compareEmbeddingFingerprints(a, { ...a, credentialGeneration: "rotated" }).requiresMigration, false);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/reembedding-fingerprint.test.js`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement closed canonical fields and SHA-256 id**

Unknown fingerprint keys are rejected, endpoint URLs lose credentials/query/fragment, artifacts are sorted, and the canonical JSON is hashed with a schema prefix.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test tests/reembedding-fingerprint.test.js`

```bash
git add lib/reembedding/fingerprint.js tests/reembedding-fingerprint.test.js
git commit -m "feat: bind namespaces to embedding fingerprints"
```

### Task 2: Durable migration state machine and confirmations

**Files:**
- Create: `lib/reembedding/state-store.js`
- Create: `lib/reembedding/confirmation.js`
- Test: `tests/reembedding-state-store.test.js`

**Interfaces:**
- Produces: `createMigrationStateStore({stateRoot, now})`, `createMigrationConfirmation({planDigest, expiresAt, randomBytes})`, and `verifyMigrationConfirmation(token, record, now)`.

- [ ] **Step 1: Write failing transition/token tests**

```js
await state.transition(id, "planned", "confirmed", { expectedRevision: 1 });
await assert.rejects(() => state.transition(id, "confirmed", "completed", { expectedRevision: 2 }), /invalid migration transition/);
const issued = createMigrationConfirmation({ planDigest, expiresAt: 2000, randomBytes: () => Buffer.alloc(32, 7) });
assert.equal(Object.hasOwn(issued.persisted, "token"), false);
assert.equal(verifyMigrationConfirmation(issued.token, issued.persisted, 1999), true);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/reembedding-state-store.test.js`

Expected: FAIL because the state modules are absent.

- [ ] **Step 3: Implement strict transitions and mode-0600 atomic persistence**

The store permits only transitions defined in the spec, serializes one migration per state root, validates the whole document, and stores only the token hash, plan digest, expiry, redacted target SecretRef descriptor, cursors, receipts, and errors.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test tests/reembedding-state-store.test.js`

```bash
git add lib/reembedding/state-store.js lib/reembedding/confirmation.js tests/reembedding-state-store.test.js
git commit -m "feat: add durable reembedding state machine"
```

### Task 3: Pure source inventory and migration planning

**Files:**
- Create: `lib/reembedding/planner.js`
- Test: `tests/reembedding-planner.test.js`

**Interfaces:**
- Consumes: backend methods `inventoryActiveGeneration()`, `statDisk()`, `probeTargetProvider()` and fingerprint functions.
- Produces: `createReembeddingPlan(request, dependencies)` returning a redacted plan, digest, confirmation, source versions, row/call/byte estimates, and probe status.

- [ ] **Step 1: Write failing purity/drift tests**

```js
const plan = await createReembeddingPlan(request, deps);
assert.deepStrictEqual(writes, []);
assert.equal(plan.source.tables[0].rowCount, 17);
assert.equal(plan.target.secretRef.source, "store");
assert.equal(Object.hasOwn(plan.target, "resolvedSecret"), false);
await assert.rejects(() => createReembeddingPlan(request, manySourceDeps), /multiple active generations/);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/reembedding-planner.test.js`

Expected: FAIL because the planner is absent.

- [ ] **Step 3: Implement read-only plan and target probe policy**

Remote targets execute one real probe. Local targets probe only fully cached verified artifacts; otherwise return `probe_deferred_local_artifact`. Insufficient disk, zero/many source, schema mismatch, non-finite probe vectors, wrong dimensions, or provider errors fail before confirmation.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test tests/reembedding-planner.test.js`

```bash
git add lib/reembedding/planner.js tests/reembedding-planner.test.js
git commit -m "feat: plan copy-on-write reembedding"
```

### Task 4: LanceDB generation backend

**Files:**
- Create: `lib/reembedding/lance-backend.js`
- Modify: `index.js`
- Test: `tests/reembedding-lance-backend.test.js`

**Interfaces:**
- Produces backend methods `inventoryActiveGeneration`, `createQuarantinedGeneration`, `readSourceBatch`, `writeTargetBatch`, `readBackTargetRows`, `validateGeneration`, `removeSyntheticProbe`, and `close`.
- Consumes existing namespace layout, `AgentDbPool`, row schemas, `safeUuid`, `safeAgentId`, and `resolveInside`.

- [ ] **Step 1: Write failing schema-preservation tests**

```js
const source = fixtureRowsWithEverySchemaField();
await backend.writeTargetBatch(target, source.map((row) => ({ ...row, vector: newVectors[row.id], embeddingFingerprint: targetId })));
const readBack = await backend.readBackTargetRows(target, source.map((row) => row.id));
assert.deepStrictEqual(stripVectorFields(readBack), stripVectorFields(source));
assert.equal(sourceWrites.length, 0);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/reembedding-lance-backend.test.js`

Expected: FAIL because the backend is absent.

- [ ] **Step 3: Implement unique quarantined paths and exact row copies**

Target paths are `generations/<safe generation id>/<existing physical partition>`. The backend refuses an existing target, rejects duplicate/unsafe ids, reads inactive/history rows too, compares a stable non-vector row hash, and never exposes quarantined targets to normal pools.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test tests/reembedding-lance-backend.test.js tests/multi-namespace-pool.test.js`

```bash
git add lib/reembedding/lance-backend.js index.js tests/reembedding-lance-backend.test.js
git commit -m "feat: add quarantined lance generations"
```

### Task 5: Resumable apply and validation coordinator

**Files:**
- Create: `lib/reembedding/coordinator.js`
- Test: `tests/reembedding-coordinator.test.js`

**Interfaces:**
- Consumes: state store, backend, target embedding provider, workspace policy guard, limits `{batchSize, concurrency, maxCalls, maxBytes, deadlineMs}`.
- Produces: `plan`, `confirm`, `apply`, `resume`, `validate`, `status`, `shutdown`.

- [ ] **Step 1: Write failing crash/resume and validation tests**

```js
await assert.rejects(() => coordinator.apply({ id, token, failAfterTargetWrite: true }), /injected crash/);
assert.equal((await coordinator.status(id)).cursor.completedRows, 0);
await coordinator.resume({ id, token: resumedToken });
assert.equal(targetRowsById.size, sourceRows.length);
assert.equal((await coordinator.validate({ id })).state, "ready_to_switch");
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/reembedding-coordinator.test.js`

Expected: FAIL because the coordinator is absent.

- [ ] **Step 3: Implement bounded copy/readback/cursor updates**

Every batch rechecks source versions, policy snapshot, byte/call/deadline budgets, target dimension, finite values, ids, and non-vector hashes. A cursor advances only after readback. Shutdown rejects new batches, waits for the active batch, persists state, and closes provider/backend.

- [ ] **Step 4: Implement full validation**

Require exact counts, no duplicates, all metadata hashes, exact finite dimensions, deterministic sample re-embeddings, and real semantic recall ordering. Validation never selects the target as active.

- [ ] **Step 5: Verify GREEN and commit**

Run: `node --test tests/reembedding-coordinator.test.js`

```bash
git add lib/reembedding/coordinator.js tests/reembedding-coordinator.test.js
git commit -m "feat: execute and validate resumable reembedding"
```

### Task 6: Maintenance-gated switch and reverse migration rollback

**Files:**
- Create: `lib/reembedding/switch-runtime.js`
- Modify: `lib/reembedding/coordinator.js`
- Modify: `index.js`
- Test: `tests/reembedding-switch-runtime.test.js`

**Interfaces:**
- Consumes: host config read/patch/reload capabilities, plugin readiness/store/recall probes, and guard maintenance-gate hooks.
- Produces: `switchGeneration`, `automaticRollback`, and `planManualRollback`.

- [ ] **Step 1: Write failing switch/rollback tests**

```js
await assert.rejects(() => runtime.switchGeneration({ id, token, probe: failingProbe }), /readiness probe failed/);
assert.deepStrictEqual(configPatches.map((x) => x.generation), [targetGeneration, sourceGeneration]);
assert.equal(userMemoryOperationsDuringGate, 0);
const reverse = await runtime.planManualRollback({ completedId, targetFingerprint: priorFingerprint });
assert.equal(reverse.sourceGeneration, completedTargetGeneration);
assert.notEqual(reverse.targetGeneration, originalBaselineGeneration);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/reembedding-switch-runtime.test.js`

Expected: FAIL because switching is absent.

- [ ] **Step 3: Implement official host-mediated config patch/reload**

The implementation feature-detects the public config mutation and lifecycle interfaces. It enters the maintenance gate before patching, reloads, probes Gateway readiness plus real store/recall, removes and audits its reserved target-only synthetic row, and exits the gate only after completion or bounded automatic rollback.

- [ ] **Step 4: Implement completed rollback as reverse copy-on-write**

Manual rollback calls the same planner/apply/validate/switch pipeline with the current active generation as authoritative source and the prior fingerprint as target. It never directly repoints the immutable pre-switch baseline.

- [ ] **Step 5: Verify GREEN and commit**

Run: `node --test tests/reembedding-switch-runtime.test.js tests/reembedding-coordinator.test.js`

```bash
git add lib/reembedding/switch-runtime.js lib/reembedding/coordinator.js index.js tests/reembedding-switch-runtime.test.js
git commit -m "feat: switch and roll back embedding generations"
```

### Task 7: Operator RPC, session action, and CLI

**Files:**
- Create: `lib/setup/reembedding-plugin-runtime.js`
- Modify: `scripts/reindex-provider.mjs`
- Modify: `index.js`
- Test: `tests/reembedding-plugin-runtime.test.js`

**Interfaces:**
- Produces read method `plur1bus.reembedding.status` (`operator.read`) and admin methods `plan|apply|resume|switch|rollback` (`operator.admin`), typed actions when available, and CLI `plur1bus-reembedding`.

- [ ] **Step 1: Write failing scope/request tests**

```js
assert.deepStrictEqual(methods.map(({name, scope}) => [name, scope]), [
  ["plur1bus.reembedding.status", "operator.read"],
  ["plur1bus.reembedding.plan", "operator.admin"],
  ["plur1bus.reembedding.apply", "operator.admin"],
  ["plur1bus.reembedding.resume", "operator.admin"],
  ["plur1bus.reembedding.switch", "operator.admin"],
  ["plur1bus.reembedding.rollback", "operator.admin"],
]);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/reembedding-plugin-runtime.test.js`

Expected: FAIL because the operator adapter is absent.

- [ ] **Step 3: Implement strict requests and thin CLI**

The CLI only calls Gateway methods; it never imports LanceDB, edits host config, resolves a secret, or mutates a source checkout. Tokens are read interactively/stdin rather than command arguments. Responses are redacted machine JSON.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test tests/reembedding-plugin-runtime.test.js`

```bash
git add lib/setup/reembedding-plugin-runtime.js scripts/reindex-provider.mjs index.js tests/reembedding-plugin-runtime.test.js
git commit -m "feat: expose reembedding operator workflow"
```

### Task 8: Real packed-artifact migration gate

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/OPENCLAW-COMPATIBILITY.md`
- Create evidence below `/root/plur1bus-beta-lab/compat-work/evidence/reembedding/`

**Interfaces:**
- Consumes: exact PLUR1BUS `7.5.0` tarball, OpenClaw `2026.8.1-beta.3`, real Jina/E5/BGE/provider paths, fresh lab generations.
- Produces: migration/restart/rollback proof and SHA-256-bound report evidence.

- [ ] **Step 1: Run full local verification**

Run: `npm ci && npm run lint && npm test && npm audit && npm pack --dry-run && npm pack`

Expected: zero failures/vulnerabilities, only the documented platform skip, and no unexpected package files.

- [ ] **Step 2: Install only the tarball in fresh Beta-3 volumes**

Prove runtime registration, doctor, Gateway readiness, provider inference, manual and automatic memory paths before migration.

- [ ] **Step 3: Perform real migration and restart**

Plan, confirm, apply, validate, switch, restart only the lab container, recall every pre-migration UUID fact, store/recall a new fact, and prove two-agent/two-workspace isolation.

- [ ] **Step 4: Perform real reverse copy-on-write rollback**

Create a post-switch fact, plan the reverse migration from the current generation, apply/validate/switch, restart, and recall both pre-switch and post-switch facts. Prove no source generation was modified or deleted.

- [ ] **Step 5: Run three unchanged serial total gates and host-invariant comparison**

Record every runtime, fresh log scan, 20/20 flaky-test repetitions, productive Gateway PID/start/restart count, Docker resources, and ports. Stop only lab containers and leave volumes/evidence intact.

- [ ] **Step 6: Document and commit**

```bash
git add CHANGELOG.md docs/OPENCLAW-COMPATIBILITY.md
git commit -m "docs: describe safe reembedding workflow"
```
