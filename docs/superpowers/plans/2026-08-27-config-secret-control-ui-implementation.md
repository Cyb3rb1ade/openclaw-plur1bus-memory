# Config, Secrets, and Control UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every PLUR1BUS feature and credential safely configurable through official OpenClaw surfaces while adding a redacted read-only PLUR1BUS status tab.

**Architecture:** The plugin manifest owns schema, `uiHints`, and `configContracts.secretInputs`; runtime credential resolution is delegated to OpenClaw's public SecretInput SDK. A pure redacted projection feeds read-scoped Gateway/status routes and a sandboxed read-only external Control UI tab, while all mutations remain in OpenClaw Config/Secrets or typed operator actions.

**Tech Stack:** Node.js 24 ESM, JSON Schema, OpenClaw plugin/SecretInput/Control UI APIs `2026.8.1-beta.3`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-27-workspace-control-plane-reembedding-design.md`

## Global Constraints

- Secret values never appear in logs, HTML, status JSON, audit records, reports, snapshots, or process arguments.
- Credential inputs accept backward strings plus OpenClaw `env`, `store`, `file`, and `exec` SecretRefs.
- Built-in OpenClaw Config and Secrets pages remain the only Beta-3 browser write surfaces.
- The external PLUR1BUS tab is route-authenticated and strictly read-only.
- `additionalProperties: false` remains enforced and dependencies fail closed.
- Registration is feature-detected, exact-once, and version-string independent.

---

### Task 1: SecretInput manifest and validation contract

**Files:**
- Modify: `openclaw.plugin.json`
- Modify: `lib/setup/config-contract.js`
- Test: `tests/config-contract.test.js`
- Test: `tests/secret-input-manifest.test.js`

**Interfaces:**
- Consumes: the ten existing credential paths under `embedding`, `embedding.fallback`, `reranker`, `merging`, `schicht15`, `skillMiner`, `criticalPush`, and `emotion.t3`.
- Produces: `configContracts.secretInputs` patterns and `uiHints[path].sensitive === true` for each path.

- [ ] **Step 1: Add failing manifest contract tests**

```js
for (const path of credentialPaths) {
  assert.equal(manifest.uiHints[path].sensitive, true);
  assert.ok(manifest.configContracts.secretInputs.some((entry) => entry.path === path));
}
assert.doesNotThrow(() => validatePluginConfig({ embedding: { apiKey: { source: "env", id: "PLUR1BUS_EMBEDDING_KEY" } } }));
assert.throws(() => validatePluginConfig({ embedding: { apiKey: { source: "env", id: "../bad" } } }), /embedding\.apiKey/);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/config-contract.test.js tests/secret-input-manifest.test.js`

Expected: FAIL because credential fields are string-only and no contracts exist.

- [ ] **Step 3: Add exact SecretRef shapes and ordered UI hints**

Each credential schema uses `oneOf` with non-empty string or a closed object discriminator for `env`, `store`, `file`, and `exec`. The internal validator adds `validateSecretInput(value, path)` so invalid objects cannot pass merely because their JSON type is object.

- [ ] **Step 4: Verify GREEN and OpenClaw manifest lint**

Run: `node --test tests/config-contract.test.js tests/secret-input-manifest.test.js`

Run inside the exact lab image: `openclaw doctor --lint --json`.

- [ ] **Step 5: Commit**

```bash
git add openclaw.plugin.json lib/setup/config-contract.js tests/config-contract.test.js tests/secret-input-manifest.test.js
git commit -m "feat: declare secure plur1bus secret inputs"
```

### Task 2: Public SDK credential resolution

**Files:**
- Create: `lib/providers/secret-input.js`
- Modify: `lib/providers/config-normalize.js`
- Modify: `lib/providers/env.js`
- Modify: `index.js`
- Test: `tests/provider-secret-input.test.js`

**Interfaces:**
- Consumes: `resolveConfiguredSecretInputString(value, {config, env, path})` from `openclaw/plugin-sdk/secret-input-runtime`.
- Produces: `resolvePlur1busCredential(value, {path, hostConfig, resolver})` and `resolvePlur1busCredentialConfig(cfg, options)` returning an in-memory clone.

- [ ] **Step 1: Write failing resolution/redaction tests**

```js
const resolved = await resolvePlur1busCredential({ source: "store", id: "embedding-primary" }, {
  path: "embedding.apiKey", resolver: async () => "sentinel-secret",
});
assert.equal(resolved, "sentinel-secret");
assert.equal(JSON.stringify(statusProjection).includes("sentinel-secret"), false);
await assert.rejects(() => resolvePlur1busCredential({ source: "store", id: "missing" }, { path: "embedding.apiKey", resolver: async () => { throw new Error("sentinel-secret"); } }), (error) => !error.message.includes("sentinel-secret") && error.message.includes("embedding.apiKey"));
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/provider-secret-input.test.js`

Expected: FAIL because structured values are unsupported.

- [ ] **Step 3: Implement lazy public SDK loader and redacted errors**

```js
export async function resolvePlur1busCredential(value, { path, hostConfig, resolver }) {
  if (value === undefined || value === null || value === "") return undefined;
  try { return await resolver(value, { config: hostConfig, path }); }
  catch { throw new Error(`PLUR1BUS credential resolution failed for ${path}`); }
}
```

Plain strings keep their current environment interpolation behavior. Structured SecretRefs never flow through `String(value)` or any logger. Provider instances receive only the resolved in-memory value and dispose it with the provider generation.

- [ ] **Step 4: Verify GREEN, rotation, and lifecycle disposal**

Run: `node --test tests/provider-secret-input.test.js tests/provider-env-resolve.test.js tests/provider-lifecycle-shutdown.test.js`

Expected: env/store/file/exec references resolve through the injected SDK; rotating the backing value changes the next provider generation without exposing either value.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/secret-input.js lib/providers/config-normalize.js lib/providers/env.js index.js tests/provider-secret-input.test.js
git commit -m "feat: resolve credentials through openclaw secret inputs"
```

### Task 3: Redacted control-plane projection

**Files:**
- Create: `lib/control-plane-projection.js`
- Test: `tests/control-plane-projection.test.js`

**Interfaces:**
- Consumes: effective config, workspace policy, provider fingerprints, DB summary, and migration state.
- Produces: `buildControlPlaneProjection(input)` containing only configured/effective/reason states and credential source kinds.

- [ ] **Step 1: Write failing projection tests**

```js
const projection = buildControlPlaneProjection({ config, policy, providers, namespaces, migration });
assert.deepStrictEqual(projection.features.skillMiner, { configured: true, effective: false, reason: "skill_workshop_unavailable" });
assert.deepStrictEqual(projection.credentials.embedding, { status: "configured", source: "store" });
assert.equal(JSON.stringify(projection).includes(config.embedding.apiKey.id), false);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/control-plane-projection.test.js`

Expected: FAIL because the projection module is absent.

- [ ] **Step 3: Implement closed feature and credential projections**

Only known feature paths and known credential paths are read. SecretRef identifiers, file paths, commands, environment names, literals, and resolved values are omitted; only `missing|configured` plus `plaintext|env|store|file|exec` is returned.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/control-plane-projection.test.js`

Expected: dependency reasons, workspace-disabled effective states, and recursive sentinel-secret absence pass.

- [ ] **Step 5: Commit**

```bash
git add lib/control-plane-projection.js tests/control-plane-projection.test.js
git commit -m "feat: add redacted control plane projection"
```

### Task 4: Read-only Beta-3 Control UI tab

**Files:**
- Create: `lib/setup/control-ui-plugin-runtime.js`
- Test: `tests/control-ui-plugin-runtime.test.js`
- Modify: `index.js`

**Interfaces:**
- Consumes: `api.session.controls.registerControlUiDescriptor`, `api.registerHttpRoute`, and `getProjection(request)`.
- Produces: descriptor id `plur1bus`, exact route `/plugins/memory-lancedb-namespaced/control`, and read-scoped Gateway method `plur1bus.control.status`.

- [ ] **Step 1: Write failing route and registration tests**

```js
assert.deepStrictEqual(descriptors, [{ id: "plur1bus", title: "PLUR1BUS", path: "/plugins/memory-lancedb-namespaced/control" }]);
assert.equal(route.auth, "gateway");
assert.equal(route.match, "exact");
assert.equal(await invokeRoute("POST"), 405);
assert.equal(renderedHtml.includes("sentinel-secret"), false);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/control-ui-plugin-runtime.test.js`

Expected: FAIL because no descriptor or route exists.

- [ ] **Step 3: Implement escaped, CSP-locked GET/HEAD HTML**

The route uses no script, form, fetch, or mutation helper. It sends `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `Cache-Control: no-store`, handles only GET/HEAD, and renders the pre-redacted projection through HTML escaping.

- [ ] **Step 4: Register with capability detection**

```js
registerControlUiRuntime({ api, getProjection });
```

If the descriptor API is absent, the Gateway status method remains available and one non-secret warning names the missing capability.

- [ ] **Step 5: Verify GREEN in unit and exact runtime**

Run: `node --test tests/control-ui-plugin-runtime.test.js`

Run in lab: `openclaw plugins inspect memory-lancedb-namespaced --runtime --json` and request the route with Gateway auth, proving GET succeeds and POST returns 405.

- [ ] **Step 6: Commit**

```bash
git add lib/setup/control-ui-plugin-runtime.js tests/control-ui-plugin-runtime.test.js index.js
git commit -m "feat: add read-only plur1bus control tab"
```

### Task 5: Packed-runtime config and secret proof

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/OPENCLAW-COMPATIBILITY.md`
- Create evidence below `/root/plur1bus-beta-lab/compat-work/evidence/control-ui/`

**Interfaces:**
- Consumes: exact packed PLUR1BUS `7.5.0` and OpenClaw `2026.8.1-beta.3`.
- Produces: doctor/inspect/route/secret-rotation evidence without secret material.

- [ ] **Step 1: Test schema editing and all SecretRef kinds in a fresh lab volume**

Use synthetic lab-only env/store/file/exec references. Read back only `configured` and source kind; scan evidence for the synthetic values before accepting it.

- [ ] **Step 2: Rotate one embedding credential without changing its fingerprint**

Reload through OpenClaw lifecycle, prove the old provider is disposed and a real embedding probe uses the rotated reference, with no re-embedding plan required.

- [ ] **Step 3: Validate UI and log freshness**

Prove exactly one tab/route/method registration, read-only route behavior, no duplicate provider generation, and no config/secret/plugin errors in fresh logs.

- [ ] **Step 4: Document operator workflow and commit**

```bash
git add CHANGELOG.md docs/OPENCLAW-COMPATIBILITY.md
git commit -m "docs: describe plur1bus config and secrets surfaces"
```
