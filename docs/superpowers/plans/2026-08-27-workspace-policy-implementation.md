# Workspace Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, default-enabled per-agent/per-workspace PLUR1BUS policy and enforce it at every memory boundary without using session ownership as identity.

**Architecture:** `WorkspacePolicyStore` owns a mode-0600 atomic JSON document under the plugin state root. `WorkspacePolicyGuard` consumes the canonical `resolveMemoryRequestContext()` result, while one OpenClaw-native runtime adapter exposes scoped Gateway, session-action, CLI, command, and read-only UI projection surfaces.

**Tech Stack:** Node.js 24 ESM, `node:test`, OpenClaw plugin API `2026.8.1-beta.3`, existing PLUR1BUS context/validation helpers.

**Spec:** `docs/superpowers/specs/2026-08-27-workspace-control-plane-reembedding-design.md`

## Global Constraints

- Unknown workspace policies default to `enabled: true`.
- The durable key is exactly `(safeAgentId(agentId), canonical workspaceIdentity)`; session owner is never consulted.
- State remains below the PLUR1BUS state root and every derived path uses `resolveInside`.
- Policy replacement is atomic, mode `0600`, schema-versioned, and revision-checked.
- A disabled workspace performs no memory DB, embedding, reranking, hook injection, Skill Miner, Cron, Obsidian, or workspace maintenance work.
- Disablement never deletes memory data or workspace artifacts.
- OpenClaw host source, bundle, `node_modules`, and Control UI assets remain unmodified.

---

### Task 1: Durable policy store

**Files:**
- Create: `lib/workspace-policy.js`
- Test: `tests/workspace-policy.test.js`

**Interfaces:**
- Consumes: `safeAgentId(id)`, `normalizeWorkspaceTarget(value)`, `resolveInside(baseDir, ...parts)`.
- Produces: `workspacePolicyKey({agentId, workspaceIdentity})`, `createWorkspacePolicyStore({stateRoot, now, logger})` with `get`, `list`, and async `set` methods.

- [ ] **Step 1: Write failing store tests**

```js
const store = createWorkspacePolicyStore({ stateRoot: root, now: () => 1234 });
assert.deepStrictEqual(store.get({ agentId: "agent-a", workspaceIdentity: "workspace:v1:alpha" }), {
  agentId: "agent-a", workspaceIdentity: "workspace:v1:alpha", enabled: true, revision: 0, source: "default",
});
const disabled = await store.set({ agentId: "agent-a", workspaceIdentity: "workspace:v1:alpha", enabled: false, expectedRevision: 0, actorId: "operator:test" });
assert.equal(disabled.revision, 1);
assert.equal(statSync(join(root, "control", "workspace-policy.json")).mode & 0o777, 0o600);
await assert.rejects(() => store.set({ agentId: "agent-a", workspaceIdentity: "workspace:v1:alpha", enabled: true, expectedRevision: 0, actorId: "operator:test" }), /revision conflict/);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/workspace-policy.test.js`

Expected: FAIL because `lib/workspace-policy.js` does not exist.

- [ ] **Step 3: Implement canonical keys and serialized atomic replacement**

```js
export function workspacePolicyKey({ agentId, workspaceIdentity }) {
  return `${safeAgentId(agentId)}\u0000${normalizeWorkspaceTarget(workspaceIdentity, "workspace identity")}`;
}

export function createWorkspacePolicyStore({ stateRoot, now = Date.now, logger = null }) {
  const statePath = resolveInside(stateRoot, "control", "workspace-policy.json");
  return Object.freeze({ get, list, set });
}
```

The implementation validates the complete loaded document, treats malformed existing state as an error, queues writers per store, writes a unique sibling temporary file with mode `0600`, `fsync`s it, renames it, and `chmod`s the final path to `0600`.

- [ ] **Step 4: Verify GREEN and focused regression coverage**

Run: `node --test tests/workspace-policy.test.js tests/b13-memory-request-context.test.js`

Expected: all tests pass, including agent isolation, workspace isolation, owner-field invariance, malformed-state failure, and concurrent revision conflict.

- [ ] **Step 5: Commit**

```bash
git add lib/workspace-policy.js tests/workspace-policy.test.js
git commit -m "feat: add durable workspace policy store"
```

### Task 2: Common workspace guard

**Files:**
- Create: `lib/workspace-policy-guard.js`
- Test: `tests/workspace-policy-guard.test.js`

**Interfaces:**
- Consumes: `store.get({agentId, workspaceIdentity})` and immutable memory contexts.
- Produces: `createWorkspacePolicyGuard({store, invalidate})` with `decision`, `requireEnabled`, `automatic`, and `set`.

- [ ] **Step 1: Write failing guard tests**

```js
assert.deepStrictEqual(guard.automatic(disabledCtx), { allowed: false, reason: "workspace_disabled" });
assert.throws(() => guard.requireEnabled(disabledCtx), (error) => error.code === "workspace_disabled");
await guard.set({ memoryCtx: enabledCtx, enabled: false, expectedRevision: 0, actorId: "operator:test" });
assert.deepStrictEqual(invalidations, [{ agentId: "agent-a", workspaceIdentity: "workspace:v1:alpha" }]);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/workspace-policy-guard.test.js`

Expected: FAIL because the guard module does not exist.

- [ ] **Step 3: Implement fail-closed decisions and post-commit invalidation**

```js
export function workspaceDisabledResult(policy) {
  return { ok: false, code: "workspace_disabled", retryable: false, policy };
}
```

Missing or conflicting identity fails closed for workspace-bound operations. Automatic hooks return a no-op decision rather than throwing. `set` invalidates caches/tickets only after the durable write succeeds and before returning.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/workspace-policy-guard.test.js`

Expected: all guard tests pass and no injected DB/provider spy is called while disabled.

- [ ] **Step 5: Commit**

```bash
git add lib/workspace-policy-guard.js tests/workspace-policy-guard.test.js
git commit -m "feat: enforce workspace policy decisions"
```

### Task 3: OpenClaw-native policy control surfaces

**Files:**
- Create: `lib/setup/workspace-policy-plugin-runtime.js`
- Test: `tests/workspace-policy-plugin-runtime.test.js`
- Modify: `index.js`

**Interfaces:**
- Consumes: `resolveRegisteredMemoryContext(commandCtx)`, policy guard, `api.registerGatewayMethod`, `api.registerCli`, optional typed session-action capability.
- Produces: Gateway methods `plur1bus.workspacePolicy.get|list|set`, CLI `plur1bus-workspace`, and typed action `workspace-policy.set` when publicly available.

- [ ] **Step 1: Write failing registration and validation tests**

```js
assert.deepStrictEqual(gateway.map((x) => [x.name, x.options.scope]), [
  ["plur1bus.workspacePolicy.get", "operator.read"],
  ["plur1bus.workspacePolicy.list", "operator.read"],
  ["plur1bus.workspacePolicy.set", "operator.write"],
]);
await setHandler({ params: { sessionKey: "agent:agent-a:main", enabled: false, expectedRevision: 0 }, respond });
assert.equal(resolveSessionCalls[0], "agent:agent-a:main");
assert.equal(Object.hasOwn(seenMutation, "workspacePath"), false);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/workspace-policy-plugin-runtime.test.js`

Expected: FAIL because the runtime adapter is absent.

- [ ] **Step 3: Implement exact schemas, scopes, and feature detection**

The set RPC accepts only `{sessionKey, enabled, expectedRevision}` and resolves trusted identity through an injected host session resolver. Configured-workspace CLI operations accept only declared aliases, never raw paths. Missing required public capabilities produce a named capability error.

- [ ] **Step 4: Integrate registration once in `plugin.register`**

```js
registerWorkspacePolicyRuntime({
  api,
  guard: workspacePolicyGuard,
  resolveSessionMemoryContext,
  resolveConfiguredMemoryContext,
});
```

Registration occurs beside the existing feature-cron runtime and is paired with lifecycle disposal if the host capability returns a disposer.

- [ ] **Step 5: Verify GREEN**

Run: `node --test tests/workspace-policy-plugin-runtime.test.js tests/plugin-entry.test.js`

Expected: exact-once registration, correct scopes, strict request shape, and no owner/path authority.

- [ ] **Step 6: Commit**

```bash
git add lib/setup/workspace-policy-plugin-runtime.js tests/workspace-policy-plugin-runtime.test.js index.js
git commit -m "feat: expose workspace policy control surfaces"
```

### Task 4: Gate tools, hooks, commands, and services

**Files:**
- Modify: `index.js`
- Modify: `lib/setup/feature-cron-plugin-runtime.js`
- Test: `tests/workspace-policy-runtime-gates.test.js`
- Test: `tests/feature-cron-plugin-runtime.test.js`

**Interfaces:**
- Consumes: `workspacePolicyGuard.decision(memoryCtx)`.
- Produces: one `withWorkspacePolicy(memoryCtx, kind, operation)` boundary used by tools/commands and one `automaticWorkspacePolicy(memoryCtx)` check used by hooks/services.

- [ ] **Step 1: Add failing call-count tests for every operation class**

```js
for (const invoke of [storeTool, recallTool, captureHook, recallHook, skillMinerJob, obsidianJob, featureCron]) {
  await invoke(disabledCtx);
}
assert.deepStrictEqual({ dbCalls, embedCalls, rerankCalls, modelCalls, injections }, { dbCalls: 0, embedCalls: 0, rerankCalls: 0, modelCalls: 0, injections: 0 });
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/workspace-policy-runtime-gates.test.js tests/feature-cron-plugin-runtime.test.js`

Expected: FAIL because disabled contexts still reach operation spies.

- [ ] **Step 3: Place guards at the last trusted common boundaries**

Explicit calls return `{ok:false, code:"workspace_disabled"}`. Automatic hooks return `undefined` or unchanged event data. Feature Cron returns `{text:"NO_REPLY", metadata:{skipped:"workspace_disabled"}}`. Background queues check again immediately before provider/DB work.

- [ ] **Step 4: Add authorized chat commands**

`/plur1bus workspace status|enable|disable` reuses `checkAuth`; mutations pass `{destructive:true}` and require an expected revision printed by status.

- [ ] **Step 5: Verify GREEN and full unit suite**

Run: `node --test tests/workspace-policy-runtime-gates.test.js tests/feature-cron-plugin-runtime.test.js tests/b13-acl-callsite-adapters.test.js`

Run: `npm test`

Expected: all non-platform tests pass; no unexpected skip.

- [ ] **Step 6: Commit**

```bash
git add index.js lib/setup/feature-cron-plugin-runtime.js tests/workspace-policy-runtime-gates.test.js tests/feature-cron-plugin-runtime.test.js
git commit -m "feat: gate plur1bus by workspace policy"
```

### Task 5: Packed Beta-3 runtime proof

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/OPENCLAW-COMPATIBILITY.md`
- Create evidence below `/root/plur1bus-beta-lab/compat-work/evidence/workspace-policy/`

**Interfaces:**
- Consumes: the exact locally packed PLUR1BUS `7.5.0` tarball and OpenClaw `2026.8.1-beta.3`.
- Produces: restart-safe two-agent/two-workspace evidence used by the final compatibility report.

- [ ] **Step 1: Document the default-enabled policy and fail-closed semantics**

Add upgrade notes that no policy file means enabled, disablement preserves data, and owner reassignment does not change the key.

- [ ] **Step 2: Build and install the packed artifact in fresh lab volumes**

Run: `npm pack --dry-run && npm pack`

Run the lab installer only through `openclaw plugins install npm-pack:<absolute-tarball> --force`.

- [ ] **Step 3: Exercise two workspaces and two agents**

Store unique UUID facts, disable one workspace, prove explicit and automatic paths skip only that workspace, restart only the lab container, re-enable, and recall the original facts.

- [ ] **Step 4: Record host invariants and stop only lab containers**

Compare productive Gateway PID/start/restart count, existing Docker resources, and open ports with the pre-run snapshot.

- [ ] **Step 5: Commit documentation**

```bash
git add CHANGELOG.md docs/OPENCLAW-COMPATIBILITY.md
git commit -m "docs: describe workspace policy compatibility"
```
