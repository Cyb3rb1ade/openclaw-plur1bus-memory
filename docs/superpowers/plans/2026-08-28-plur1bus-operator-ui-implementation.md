# PLUR1BUS Operator UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a safe, information-rich PLUR1BUS Control UI for exact OpenClaw `2026.8.1-beta.3` without adding a write bridge to the sandboxed tab.

**Architecture:** A bounded read-only health inspector builds closed aggregate facts from existing LanceDB partitions. `buildControlPlaneProjection()` maps health, policy, features, providers, and migration state into a recursively redacted schema-v2 view. The existing Control UI route server-renders that view as accessible cards while typed Gateway/session actions and OpenClaw Config/Secrets remain the sole write surfaces.

**Tech Stack:** Node.js 24 ESM, `node:test`, LanceDB via existing read-only `AgentDbPool`, OpenClaw plugin API `2026.8.1-beta.3`, no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-28-plur1bus-operator-ui-design.md`

## Global Constraints

- Pin OpenClaw runtime behavior to `2026.8.1-beta.3`; do not patch OpenClaw source, bundle, `node_modules`, or UI assets.
- The external tab stays `GET, HEAD` only with the existing CSP and `no-store` headers.
- No memory text, SecretRef identifier, secret, raw error text, filesystem path, command, or URL derived from configuration may be projected.
- Default workspace policy is enabled; only explicit overrides are listed.
- Health inspection is read-only, bounded, path-validated, coalesced, and must never create tables or cards.
- Feature, credential, workspace-policy, and re-embedding writes retain their existing official scoped API paths and audit behavior.

---

### Task 1: Closed health inspector

**Files:**
- Create: `lib/control-plane-health.js`
- Test: `tests/control-plane-health.test.js`
- Modify: `index.js`

**Interfaces:**
- Produces: `createControlPlaneHealthInspector({ scan, now, ttlMs })` with `snapshot()` and `invalidate()`.
- Consumes: an injected scan returning only aggregate partition counts, byte totals, and stable error codes.

- [ ] **Step 1: Write failing inspector tests**

```js
const inspector = createControlPlaneHealthInspector({ scan, now: () => 1_000, ttlMs: 1_000 });
assert.deepEqual(await Promise.all([inspector.snapshot(), inspector.snapshot()]), [expected, expected]);
assert.equal(scanCalls, 1);
assert.equal((await inspector.snapshot()).lastError.code, "lancedb_count_failed");
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test tests/control-plane-health.test.js`

Expected: FAIL because the inspector module does not exist.

- [ ] **Step 3: Implement TTL/coalescing and closed health normalization**

```js
export function createControlPlaneHealthInspector({ scan, now = Date.now, ttlMs = 10_000 } = {}) {
  return Object.freeze({ snapshot, invalidate });
}
```

Permit only `ready|degraded|unavailable`, non-negative safe counters, fixed
partition kinds, and stable code tokens. A failed scan returns `degraded` with
a generic code rather than throwing raw state into the Control UI.

- [ ] **Step 4: Wire a read-only scanner in `index.js`**

Use a fresh `AgentDbPool(..., { readOnly: true })` only for existing safe
directories. Validate directory entries with `safeAgentId`, use `resolveInside`
for all descendants, skip symlinks, cap directory/partition counts, close each
pool, and report only counts. Map physical workspace keys to a known policy
record when one exists; otherwise report a safe opaque key.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test tests/control-plane-health.test.js`

Commit:

```bash
git add lib/control-plane-health.js tests/control-plane-health.test.js index.js
git commit -m "feat: add redacted memory health inspector"
```

### Task 2: Schema-v2 control-plane projection

**Files:**
- Modify: `lib/control-plane-projection.js`
- Test: `tests/control-plane-projection.test.js`
- Modify: `index.js`

**Interfaces:**
- Consumes: `health`, `workspacePolicies`, existing `config`, `providers`, `capabilities`, `namespaces`, and `migration`.
- Produces: `memoryHealth`, `workspaceMatrix`, feature card metadata, and `reembeddingWorkflow` in schema version 2.

- [ ] **Step 1: Write failing redaction and default-policy tests**

```js
assert.equal(projection.schemaVersion, 2);
assert.equal(projection.workspaceMatrix.defaultEnabled, true);
assert.deepEqual(projection.memoryHealth.cards.byAgent, [{ id: "agent-a", cards: 3 }]);
assert.equal(JSON.stringify(projection).includes("sentinel-secret"), false);
assert.equal(JSON.stringify(projection).includes("memory body"), false);
```

- [ ] **Step 2: Run focused test and confirm RED**

Run: `node --test tests/control-plane-projection.test.js`

Expected: FAIL because schema-v2 fields are absent.

- [ ] **Step 3: Implement allow-listed projection helpers**

Project only fixed feature labels, dependency reasons, paused-hook explanations,
credential statuses, re-embedding steps, safe count records, and stable error
codes. Do not spread input objects. Keep existing schema-v1 fields where they
are harmless so existing Gateway consumers can migrate.

- [ ] **Step 4: Wire live policy/health input into the registered projection**

Pass `workspacePolicyStore.list()` and `await controlHealth.snapshot()` from
the plugin runtime. Do not resolve a secret or access a memory row.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test tests/control-plane-projection.test.js`

Commit:

```bash
git add lib/control-plane-projection.js tests/control-plane-projection.test.js index.js
git commit -m "feat: project workspace and health control state"
```

### Task 3: Accessible read-only dashboard

**Files:**
- Modify: `lib/setup/control-ui-plugin-runtime.js`
- Test: `tests/control-ui-plugin-runtime.test.js`

**Interfaces:**
- Consumes: schema-v2 projection only.
- Produces: server-rendered Memory Health, Workspace Matrix, Feature Cards, and Re-Embedding Workflow sections.

- [ ] **Step 1: Write failing rendering/security tests**

```js
assert.match(response.body, /Memory Health/);
assert.match(response.body, /Workspace Matrix/);
assert.match(response.body, /Re-Embedding Workflow/);
assert.doesNotMatch(response.body, /<script|<form|fetch\s*\(/i);
```

- [ ] **Step 2: Run focused test and confirm RED**

Run: `node --test tests/control-ui-plugin-runtime.test.js`

Expected: FAIL because the renderer still emits raw JSON only.

- [ ] **Step 3: Render semantic cards from fixed fields**

Use escaped text and fixed internal links only (`/config`, `/secrets`). Render
the required workflow with its current durable state and an explicit note that
the exact Beta-3 iframe intentionally cannot perform mutations. Provide
operator-safe guidance to the existing typed control surfaces; do not render a
form, a secret input, a Gateway token, or a mutation endpoint.

- [ ] **Step 4: Verify GET/HEAD and all mutation verbs remain blocked**

Run: `node --test tests/control-ui-plugin-runtime.test.js`

Expected: all rendering and CSP tests pass; `POST`, `PUT`, `PATCH`, and
`DELETE` return `405` before projection evaluation.

- [ ] **Step 5: Commit**

```bash
git add lib/setup/control-ui-plugin-runtime.js tests/control-ui-plugin-runtime.test.js
git commit -m "feat: render plur1bus operator dashboard"
```

### Task 4: Packed exact-Beta-3 verification and documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/OPENCLAW-COMPATIBILITY.md`
- Create evidence below: `/root/plur1bus-beta-lab/compat-work/evidence/operator-ui/`

- [ ] **Step 1: Test source suite, lint, and pack contents**

Run: `npm test`

Run: `npm pack --dry-run && npm pack`

Use the elevated local test execution required for Node child-process tests;
do not treat a sandbox `EPERM` as a product failure.

- [ ] **Step 2: Build a fresh isolated harness and install only the packed tarball**

Build a new `plur1bus-beta-fix`-prefixed resource set from exact OpenClaw
`2026.8.1-beta.3`. Install using `openclaw plugins install npm-pack:<tarball>
--force`; do not use a source link.

- [ ] **Step 3: Verify real runtime surface and non-mutating health path**

Use `plugins doctor`, runtime `plugins inspect`, authenticated GET/HEAD/POST
route probes, actual dashboard health output, workspace policy RPC/session
action, and re-embedding status RPC. Confirm row-count inspection creates no
table/card and no secret appears in output.

- [ ] **Step 4: Preserve host invariants and commit docs**

Take before/after host snapshots, stop only the new lab containers, retain
volumes and evidence, then commit the documentation.

```bash
git add CHANGELOG.md docs/OPENCLAW-COMPATIBILITY.md
git commit -m "docs: describe operator control ui"
```

