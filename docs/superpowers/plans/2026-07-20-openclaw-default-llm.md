# OpenClaw Default LLM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every enabled PLUR1BUS chat-LLM call through the effective OpenClaw model for the current agent when the owning feature has no explicit model, while retaining complete feature-local direct overrides and eliminating hard-coded or cross-feature model fallbacks.

**Architecture:** A new `lib/llm-router.js` resolves one immutable route descriptor per owning feature and executes native OpenClaw or direct OpenAI-compatible calls behind a normalized result contract. `index.js` injects `api.runtime.llm.complete`, supplies the real `agentId` and audit purpose at invocation time, and keeps existing feature activation/budget/rate/fail-soft gates separate from route availability. Native calls omit `model` in default mode and bypass the PLUR1BUS pre-call result cache; direct calls require an explicit model and retain `lib/llm-call.js` plus its exact cache.

**Tech Stack:** Node.js ESM, OpenClaw `api.runtime.llm.complete`, `AbortController`, existing `lib/llm-call.js`, `lib/with-timeout.js`, `lib/llm-result-cache.js`, `safeWarn`/`safeDebug`, Node test runner (`node:test`), repository deploy-integrity tooling; no new dependency.

## Global Constraints

- Work only in `.worktrees/fix-high-mid-audit-findings` on `fix/high-mid-audit-findings`; do not modify `main`, push, or mutate the remote.
- Follow the approved design in `docs/superpowers/specs/2026-07-20-openclaw-default-llm-design.md`; an implementation shortcut may not weaken one of its binding decisions.
- Use strict RED-GREEN-REFACTOR TDD. Show the intended failure before implementation and rerun the narrow test after each behavior change.
- Scope is chat LLMs only. Embeddings, rerankers, vector dimensions, provider registry, memory data, LanceDB schema, and namespace layout are unchanged.
- Default mode means `api.runtime.llm.complete({ ... })` with the `model` key absent, not `model: undefined`, and with the current call's `agentId` when available.
- An explicit model belongs only to the feature that owns the call. `schicht15`, `skillMiner`, `criticalPush`, Emotion T3, dreams, persona, afterthought, query summarization, overlays, episode extraction, wiki, capture summarization, and consolidation must not inherit `merging.model`, `merging.baseUrl`, `merging.apiKey`, or `merging.headers`.
- A route is available independently of feature activation. Existing `enabled`, safe/recommended-profile, confirmation, rate, budget, threshold, timeout, and fail-soft gates remain authoritative and must have regression coverage.
- Direct transport fields (`baseUrl`, a resolved `apiKey`, or non-empty `headers`) without a non-empty feature-local model are an ambiguous partial override: issue a secret-free safe warning, make no request, and expose an unavailable route.
- Native runtime absence is fail-soft/unavailable. Never fall back to `kimi-for-coding`, `gpt-4o-mini`, another feature's model, or a direct credential.
- Native calls use a bounded combined abort signal. Direct calls retain the existing bounded `lib/llm-call.js` behavior.
- Native calls never consult the PLUR1BUS exact-result cache because the final fallback model is unknown before the host call. Direct calls retain exact caching with the existing `{scopeId, purpose}` allowlist.
- Do not make an LLM call at plugin registration time and do not copy OpenClaw's current default into PLUR1BUS config or an installer profile.
- Logs and diagnostics may contain feature, agent ID, route, provider/model returned by OpenClaw, and error class. They may not contain prompts, messages, API keys, auth headers, or raw credential-bearing config.
- Every new or changed export gets focused JSDoc. Every new catch rethrows, returns an error result, or logs through `safeWarn`/`safeDebug`; no new silent catch.
- Preserve the existing public `callLlm(messages, llmCfg) -> Promise<string|null>` convention at feature-module boundaries. The router may expose a richer result, but `index.js` must translate `failed` back into an exception and `unavailable` into `null` so existing callers keep their error/fallback semantics.
- The full authoritative gate is serial: `node --test --test-concurrency=1 tests/*.test.js test/*.test.js`. The known root-only `verify-workspace-writer` sandbox skip may remain; this change must add no skip.

---

### Task 1: Build the shared route resolver and dispatcher

**Files:**
- Create: `lib/llm-router.js`
- Create: `tests/llm-router.test.js`

**Public interface:**

```js
export const LLM_ROUTE_KINDS = Object.freeze({
  OPENCLAW_DEFAULT: "openclaw-default",
  OPENCLAW_OVERRIDE: "openclaw-override",
  DIRECT_OVERRIDE: "direct-override",
  UNAVAILABLE: "unavailable",
});

export function resolveFeatureLlmRoute(featureConfig, options) {}
export function isLlmRouteAvailable(route) {}
export async function completeFeatureLlm(messages, route, callOptions, dependencies) {}
```

`resolveFeatureLlmRoute(featureConfig, options)` accepts `{ feature, runtimeLlm, logger, resultCache }` and returns a frozen descriptor. It normalizes only the owning feature's `model`, `baseUrl`, `apiKey`, `headers`, `disableThinking`, and `timeoutMs`. The descriptor never stores another feature's config.

`completeFeatureLlm(messages, route, callOptions, dependencies)` accepts call-local `{ agentId, purpose, maxTokens, temperature, jsonMode, disableThinking, timeoutMs, signal, resultCacheContext }` plus injected `{ directCall }` and returns one of:

```js
{ status: "ok", text, route, provider, model, agentId, usage }
{ status: "unavailable", text: null, route: "unavailable", reason }
{ status: "failed", text: null, route, error }
```

- [ ] **Step 1: Write RED tests for all four resolution modes**

Create `tests/llm-router.test.js` with fake `runtimeLlm.complete`, fake `directCall`, and a logger that records structured-safe calls. Assert concrete descriptors and call counts for:

```js
const nativeDefault = resolveFeatureLlmRoute({}, {
  feature: "capture-summary",
  runtimeLlm,
  logger,
  resultCache,
});
assert.equal(nativeDefault.kind, LLM_ROUTE_KINDS.OPENCLAW_DEFAULT);
assert.equal(Object.hasOwn(nativeDefault, "model"), false);

const nativeOverride = resolveFeatureLlmRoute({ model: "anthropic/claude-sonnet-4-6" }, {
  feature: "merging",
  runtimeLlm,
  logger,
});
assert.equal(nativeOverride.kind, LLM_ROUTE_KINDS.OPENCLAW_OVERRIDE);
assert.equal(nativeOverride.model, "anthropic/claude-sonnet-4-6");

const direct = resolveFeatureLlmRoute({
  model: "vendor/model-a",
  baseUrl: "https://llm.example/v1",
  apiKey: "secret-value",
  headers: { Authorization: "Bearer second-secret" },
}, { feature: "skill-miner", runtimeLlm, logger, resultCache });
assert.equal(direct.kind, LLM_ROUTE_KINDS.DIRECT_OVERRIDE);

const ambiguous = resolveFeatureLlmRoute({ baseUrl: "https://llm.example/v1" }, {
  feature: "critical-push",
  runtimeLlm,
  logger,
});
assert.equal(ambiguous.kind, LLM_ROUTE_KINDS.UNAVAILABLE);
assert.equal(ambiguous.reason, "ambiguous-partial-override");
```

Also assert that blank strings are absent values, an empty headers object is not a transport override, and a missing `runtimeLlm.complete` produces `reason: "openclaw-runtime-unavailable"` without selecting a model.

- [ ] **Step 2: Run the resolver tests to verify RED**

Run: `node --test --test-concurrency=1 tests/llm-router.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/llm-router.js`.

- [ ] **Step 3: Implement route resolution only**

Create `lib/llm-router.js` using trim-aware normalization. Detect direct transport from non-empty `baseUrl`, non-empty resolved `apiKey`, or at least one header key. Return `UNAVAILABLE` before considering the native runtime when transport is partial. Log only fixed reason strings and `{ feature }`; do not interpolate config values.

Use `Object.freeze` on descriptors and implement:

```js
export function isLlmRouteAvailable(route) {
  return Boolean(route && route.kind !== LLM_ROUTE_KINDS.UNAVAILABLE);
}
```

Do not call the runtime or direct client in the resolver.

- [ ] **Step 4: Run the resolver tests to verify GREEN**

Run: `node --test --test-concurrency=1 tests/llm-router.test.js`

Expected: resolver tests PASS; dispatcher tests have not yet been added.

- [ ] **Step 5: Add RED dispatcher tests**

Append tests proving:

- native default sends `messages`, `agentId`, `purpose`, limits, temperature, and signal but has no own `model` property;
- two calls with `agentId: "agent-a"` and `agentId: "agent-b"` receive different fake host results without a PLUR1BUS config change;
- native explicit sends exactly the feature-local model;
- native results normalize host `{ text, provider, model, agentId, usage }` metadata;
- direct explicit calls only `directCall(messages, directCfg, options)`, includes the route's `resultCache`, and never calls the native runtime;
- unavailable routes call neither transport and return the fixed reason;
- native and direct rejection return `status: "failed"` with the original `Error`, without prompt/secret logging.

Use an injected `setTimer`/`clearTimer` seam or a short deterministic timeout. Assert a native request receives a signal that becomes aborted on timeout and when the caller signal aborts. The combined signal must clean up its timer/listener after settlement.

- [ ] **Step 6: Run dispatcher tests to verify RED**

Run: `node --test --test-concurrency=1 tests/llm-router.test.js`

Expected: FAIL because `completeFeatureLlm` does not yet dispatch or bound native requests.

- [ ] **Step 7: Implement dispatcher and normalized outcomes**

For native calls, construct parameters property-by-property so default mode truly omits `model`:

```js
const params = {
  messages,
  ...(callOptions.agentId ? { agentId: callOptions.agentId } : {}),
  ...(callOptions.purpose ? { purpose: callOptions.purpose } : {}),
  ...(Number.isFinite(callOptions.maxTokens) ? { maxTokens: callOptions.maxTokens } : {}),
  ...(Number.isFinite(callOptions.temperature) ? { temperature: callOptions.temperature } : {}),
  signal,
};
if (route.kind === LLM_ROUTE_KINDS.OPENCLAW_OVERRIDE) params.model = route.model;
```

Do not pass direct-only `baseUrl`, `apiKey`, `headers`, `jsonMode`, `disableThinking`, or `resultCache` to OpenClaw. If `jsonMode` is requested on native mode, preserve the existing prompt-level JSON contract; do not invent a host option absent from `LlmCompleteParams`.

For direct mode, merge call-local generation settings over the route descriptor and call the injected direct adapter with its existing result-cache option. Catch once at the router boundary, log a credential-free safe warning, and return `failed`; do not manufacture text.

- [ ] **Step 8: Run Task 1 tests and syntax checks**

Run:

```bash
node --test --test-concurrency=1 tests/llm-router.test.js
node --check lib/llm-router.js
git diff --check
```

Expected: all router tests PASS and both checks exit 0.

- [ ] **Step 9: Commit Task 1**

```bash
git add lib/llm-router.js tests/llm-router.test.js
git commit -m "feat: add OpenClaw LLM router"
```

---

### Task 2: Wire the runtime seam and feature-local core routes

**Files:**
- Modify: `index.js`
- Create: `tests/openclaw-default-llm-runtime.test.js`
- Modify: `tests/runtime-config-contract.test.js`

**Route ownership for this task:**

| Route variable | Owning config only | Existing activation gate |
|---|---|---|
| `mergingLlmCfg` | `cfg.merging` | `merging.enabled === true` |
| `schicht15LlmCfg` | `cfg.schicht15` | `schicht15.enabled === true` |
| `skillMinerLlmCfg` | `cfg.skillMiner` | `skillMiner.enabled === true` |
| `emotionT3LlmCfg` | `cfg.emotion.t3` | `emotion.t3.enabled === true` plus existing provider/budget behavior |
| `criticalPushLlmCfg` | `cfg.criticalPush` | `criticalPush.enabled !== false` at job invocation |

- [ ] **Step 1: Write RED plugin-runtime tests before changing `index.js`**

Create a focused fake API harness in `tests/openclaw-default-llm-runtime.test.js` using the same fresh-import and registered-command/hook patterns as `tests/auto-capture-batch.test.js` and `tests/plur1bus-internal-auth.test.js`. It must expose `runtime.llm.complete` and record parameters.

Assert:

1. `plugin.register(api)` makes zero LLM calls.
2. `merging.enabled:true` with no model remains enabled when native runtime exists.
3. A real merge/classifier command or hook call reaches native default with the invocation's agent ID and no `model` key.
4. `merging.model` is passed only for a merging call.
5. `schicht15`, `skillMiner`, and `criticalPush` without models do not receive `merging.model` even when it is configured.
6. A feature-local model without direct transport is a native override.
7. A feature-local model with its own direct transport uses the injected direct path and not native runtime.
8. Feature-local direct transport without a model makes no call and reaches the existing skip/fallback response.
9. Removing `api.runtime.llm.complete` makes native paths skip/fallback with a warning and no hard-coded model.

- [ ] **Step 2: Run runtime/config tests to verify RED**

Run:

```bash
node --test --test-concurrency=1 tests/openclaw-default-llm-runtime.test.js tests/runtime-config-contract.test.js
```

Expected: new assertions FAIL because `index.js` still disables missing-model features and inherits `merging` settings.

- [ ] **Step 3: Replace the top-level direct-only wrapper with the router seam**

Import `resolveFeatureLlmRoute`, `isLlmRouteAvailable`, and `completeFeatureLlm`. Keep `callOpenAiLlm` as the injected direct adapter. Implement the compatibility wrapper:

```js
async function callLlm(messages, llmCfg) {
  const result = await completeFeatureLlm(messages, llmCfg, {
    agentId: llmCfg?.callContext?.agentId,
    purpose: llmCfg?.callContext?.purpose,
    maxTokens: llmCfg?.maxTokens,
    temperature: llmCfg?.temperature,
    jsonMode: llmCfg?.jsonMode,
    disableThinking: llmCfg?.disableThinking,
    timeoutMs: llmCfg?.timeoutMs,
    signal: llmCfg?.signal,
    resultCacheContext: llmCfg?.resultCacheContext,
  }, {
    directCall: (directMessages, directCfg) => callOpenAiLlm(directMessages, directCfg, {
      loadOpenAI: getOpenAI,
      resultCache: directCfg?.resultCache,
    }),
  });
  if (result.status === "failed") throw result.error;
  return result.status === "ok" ? result.text : null;
}
```

The implementer may factor the adapter closure once, but the behavior and error translation are binding.

- [ ] **Step 4: Resolve core routes independently**

Replace the model-presence gates with activation plus `isLlmRouteAvailable(route)`. Resolve secrets only on the owning feature config before route construction. Remove all fallback expressions to `mergingModel`, `mergingCfg`, `mergingLlmCfg`, global embedding `apiKey`, or a named chat model.

Examples:

```js
const mergingEnabled = mergingCfg.enabled === true;
const mergingLlmCfg = mergingEnabled
  ? createFeatureRoute("merging", mergingCfg)
  : null;

const schicht15Enabled = schicht15Cfg.enabled === true;
const schicht15LlmCfg = schicht15Enabled
  ? createFeatureRoute("schicht15", schicht15Cfg)
  : null;
```

`createFeatureRoute` is a registration-local helper around `resolveFeatureLlmRoute` with `api.runtime?.llm`, `api.logger`, and `llmResultCache`; it does no model call. Do not use the embedding provider's top-level `apiKey` as a chat credential.

Construct the Critical Push route from `cfg.criticalPush` once or at job invocation, then wrap it in the existing `{ complete({prompt}) }` model adapter with the current `internalAgent` in call context. If unavailable, pass `model:null` and preserve the classifier's no-op contract.

- [ ] **Step 5: Preserve activation and availability logs**

Change logs from named-model claims to route-kind claims. An enabled native-default feature is not “disabled because model is empty.” Warnings for partial overrides and missing runtime come from the router and contain no secrets.

Do not change default `enabled` values, profile behavior, thresholds, `autoApply`, or command authorization.

- [ ] **Step 6: Run Task 2 tests to verify GREEN**

Run:

```bash
node --test --test-concurrency=1 tests/llm-router.test.js tests/openclaw-default-llm-runtime.test.js tests/runtime-config-contract.test.js tests/plur1bus-internal-auth.test.js tests/memory-store-merge-safety.test.js
node --check index.js
git diff --check
```

Expected: all selected tests PASS; no new skip.

- [ ] **Step 7: Commit Task 2**

```bash
git add index.js tests/openclaw-default-llm-runtime.test.js tests/runtime-config-contract.test.js
git commit -m "feat: use OpenClaw default for core LLM routes"
```

---

### Task 3: Carry agent/purpose context and migrate every generic caller

**Files:**
- Modify: `lib/llm-result-cache.js`
- Modify: `tests/llm-result-cache.test.js`
- Modify: `index.js`
- Create: `tests/openclaw-default-llm-callers.test.js`
- Modify focused existing tests when their fixture currently assumes `mergingLlmCfg` identity

**Required helper contract:**

Add a new export rather than changing cache-key semantics:

```js
/** Add call-local agent and purpose metadata without enabling caching. */
export function withLlmCallContext(llmCfg, agentId, purpose) {
  return { ...llmCfg, callContext: { agentId, purpose } };
}

export function withLlmResultCacheContext(llmCfg, scopeId, purpose) {
  return withLlmCallContext(
    { ...llmCfg, resultCacheContext: { scopeId, purpose } },
    scopeId,
    purpose,
  );
}
```

Native routing reads `callContext` but ignores `resultCache`; direct routing reads both. This preserves existing cache opt-ins while ensuring agent/purpose are not accidentally limited to cached transforms.

- [ ] **Step 1: Add RED helper tests**

In `tests/llm-result-cache.test.js`, assert `withLlmCallContext` is immutable, does not create `resultCacheContext`, and `withLlmResultCacheContext` produces both contexts with identical scope/purpose.

Run: `node --test --test-concurrency=1 tests/llm-result-cache.test.js`

Expected: FAIL because `withLlmCallContext` is not exported and the existing helper lacks `callContext`.

- [ ] **Step 2: Implement the helper and verify GREEN**

Add focused JSDoc and the implementation above. Do not add `callContext` to the exact cache key.

Run: `node --test --test-concurrency=1 tests/llm-result-cache.test.js tests/llm-router.test.js`

Expected: PASS.

- [ ] **Step 3: Write a RED ownership matrix test for all generic callers**

Create `tests/openclaw-default-llm-callers.test.js`. Use source-contract assertions for complete inventory plus executable fake-runtime tests for representative hook/command paths. The inventory must fail if any of these paths still receive `mergingLlmCfg` or `skillMinerLlmCfg` as a cross-feature default:

| Owning feature/purpose | Existing call sites to migrate |
|---|---|
| `capture-summary` | oversized auto-capture `summarizeForCapture` |
| `recall-query-summary` | command recall, tool recall, auto recall `makeQuerySummarizer` |
| `daily-consolidation` | `/plur1bus internal consolidate-daily` |
| `rem-dream` | `/plur1bus internal rem-dream` |
| `light-dream` | post-session `lightDream` |
| `episode-extraction` | post-session `extractEpisodesFromTurns` |
| `afterthought` | internal afterthought job |
| `persona-voice` | evolve, regenerate, scheduled seed |
| `wiki` | `runWikiCommand` synthesis route |
| `continuity-overlay` | `OverlayGenerator` and contradiction resolution |
| `memory-text-contradiction` | `ContradictionDetector` fallback closure |
| `schicht15` | knowledge promotion/update/compaction |
| `skill-miner` | skill extraction only |
| `critical-push` | classify-recent only |
| `emotion-classification` | Emotion T3 only |
| `merging` | merge decision, conflict/reconsolidation only |
| `neo-conversation-insights` | NEO conversation insight jobs |
| `memory-compaction` | compaction/summarization jobs |
| `dream-echo` / `dream-narrative` | their distinct generation calls |
| `meta-cognition` | LLM report only when `llmReport` gate is true |

For routes whose config object has no model/transport fields, call `createFeatureRoute(feature, {})`: this is native default, not inherited merging. For routes that have their own config object, pass only that object.

The executable cases must prove at least:

- capture and recall calls carry the real hook/tool agent ID;
- an explicit `merging.model` never appears in afterthought, persona, dream, overlay, episode, wiki, or query-summary runtime parameters;
- native calls do not increment the injected PLUR1BUS result-cache spy;
- a direct explicit deterministic transform still reaches its exact cache;
- `enabled:false` or the existing non-LLM gate produces zero runtime calls.

- [ ] **Step 4: Run the caller matrix to verify RED**

Run:

```bash
node --test --test-concurrency=1 tests/openclaw-default-llm-callers.test.js tests/openclaw-default-llm-runtime.test.js
```

Expected: FAIL on the first remaining borrowed route or missing call context.

- [ ] **Step 5: Introduce named route descriptors and migrate call sites**

In `index.js`, create only the descriptors needed by active code, for example:

```js
const captureSummaryLlmCfg = createFeatureRoute("capture-summary", {});
const recallQueryLlmCfg = createFeatureRoute("recall-query-summary", {});
const dailyConsolidationLlmCfg = createFeatureRoute("daily-consolidation", cfg.dailyConsolidation || {});
const remDreamLlmCfg = createFeatureRoute("rem-dream", {});
const lightDreamLlmCfg = createFeatureRoute("light-dream", {});
const episodeExtractionLlmCfg = createFeatureRoute("episode-extraction", {});
const afterthoughtLlmCfg = createFeatureRoute("afterthought", cfg.afterthought || {});
const personaVoiceLlmCfg = createFeatureRoute("persona-voice", cfg.personaVoice || {});
const wikiLlmCfg = createFeatureRoute("wiki", {});
const overlayLlmCfg = createFeatureRoute("continuity-overlay", overlayCfg);
```

If the manifest does not permit model/transport keys on one of those configs, only `{}` is used and no schema field is added in this task. Do not broaden configuration schema merely to make every route overrideable.

Wrap each invocation with `withLlmCallContext(route, agentId, purpose)`. Existing deterministic cache purposes continue using `withLlmResultCacheContext`, which now also carries call context. For non-allowlisted purposes, use a stable lower-kebab purpose string without adding it to `LLM_RESULT_CACHE_PURPOSES`.

Replace truthy/model checks with `isLlmRouteAvailable(route)` where the call is optional. Keep feature gates first, then route availability, so default mode does not activate a disabled feature.

Remove or rewrite these current cross-feature expressions completely:

```text
skillMinerLlmCfg || mergingLlmCfg
personaLlmCfg = skillMinerLlmCfg || mergingLlmCfg
llmCfg: mergingLlmCfg        // outside merging-owned calls
mergingLlmCfg?.model ? ...   // availability proxy
baseUrl: feature.baseUrl || mergingCfg.baseUrl
apiKey: feature.apiKey || mergingLlmCfg.apiKey || apiKey
headers: feature.headers || mergingCfg.headers
```

Do not remove the variable name `mergingLlmCfg` from true merging/conflict calls.

- [ ] **Step 6: Verify caller migration and cache boundary**

Run:

```bash
node --test --test-concurrency=1 \
  tests/llm-router.test.js \
  tests/llm-result-cache.test.js \
  tests/llm-result-cache-integration.test.js \
  tests/openclaw-default-llm-runtime.test.js \
  tests/openclaw-default-llm-callers.test.js \
  tests/auto-capture-batch.test.js \
  tests/auto-recall-decision-trace.test.js \
  tests/critical-classifier-double-push.test.js
node --check index.js
git diff --check
```

If `tests/llm-result-cache-integration.test.js` has a different existing name, use the exact `tests/llm-result-cache*.test.js` files returned by `rg --files tests | rg 'llm-result-cache'`; do not invent or silently omit the integration coverage.

Expected: all selected tests PASS; native cache spy stays at zero and direct cache tests remain green.

- [ ] **Step 7: Commit Task 3**

```bash
git add index.js lib/llm-result-cache.js tests/llm-result-cache.test.js tests/openclaw-default-llm-callers.test.js
git add tests/llm-result-cache*.test.js tests/auto-capture-batch.test.js tests/auto-recall-decision-trace.test.js
git commit -m "refactor: isolate feature LLM routes"
```

Before committing, inspect `git diff --cached --name-only` and unstage unchanged/unrelated paths; the glob command must not widen scope beyond files actually modified for this task.

---

### Task 4: Remove named defaults from Emotion T3 and pure domain modules

**Files:**
- Modify: `index.js`
- Modify: `lib/emotion.js`
- Modify: `lib/emotion-engine.js`
- Modify: `lib/tier3-llm.js`
- Modify: `lib/overlay-generator.js`
- Modify: `lib/interpretation-overlay.js` if its JSDoc still describes a default rather than an explicit example
- Modify: `test/emotion-tier-config.test.js`
- Modify/create focused overlay tests returned by `rg --files tests test | rg 'overlay-generator|interpretation-overlay'`

- [ ] **Step 1: Write RED pure-module tests**

Extend `test/emotion-tier-config.test.js` and the focused overlay test to assert:

- `EmotionEngine` passes no named model to `Tier3LLMClassifier` when an injected `callLlm` is present;
- `Tier3LLMClassifier({ callLlm })` classifies successfully without `model`;
- `Tier3LLMClassifier({ apiKey })` without an explicit model does not send a direct request and falls back to the supplied Tier-1 result or neutral result;
- explicit direct `{ apiKey, model }` still sends that exact model;
- `OverlayGenerator` accepts `model:null`/absence and records no invented model in provenance; when the injected completion result can report metadata, provenance uses that resolved model, otherwise the field is omitted;
- no pure module contains the runtime literals `kimi-for-coding` or `gpt-4o-mini`.

Run:

```bash
node --test --test-concurrency=1 test/emotion-tier-config.test.js tests/*overlay*.test.js
```

Expected: FAIL on current hard-coded defaults.

- [ ] **Step 2: Remove defaults and make injected completion authoritative**

Change all four runtime modules so absent model remains absent. In direct `Tier3LLMClassifier` mode, require both a client/credential and explicit model before sending; otherwise return the existing local/neutral fallback without a request. With injected `callLlm`, no model is needed because the router owns selection.

In `index.js`, build Emotion T3 from `cfg.emotion.t3` only:

- native runtime counts as a provider when T3 is explicitly enabled;
- a complete direct override counts as a provider;
- partial direct override and missing native runtime do not;
- `onlyWhenProviderAvailable`, forced-tier behavior, timeout, escalation confidence, and local fallback remain unchanged;
- the injected function adds current `agentId` and `LLM_RESULT_CACHE_PURPOSES.EMOTION_CLASSIFICATION` context to `emotionT3LlmCfg`.

Do not pass `mergingLlmCfg` or `mergingModel` into Emotion T3.

- [ ] **Step 3: Run emotion/overlay and runtime regression tests**

Run:

```bash
node --test --test-concurrency=1 \
  test/emotion-tier-config.test.js \
  tests/*emotion*.test.js \
  tests/*overlay*.test.js \
  tests/openclaw-default-llm-runtime.test.js \
  tests/openclaw-default-llm-callers.test.js
rg -n 'kimi-for-coding|gpt-4o-mini' lib index.js
```

Expected: all tests PASS. The final `rg` may show an explicit explanatory comment only if it is not a default claim; preferred result is no runtime-library match.

- [ ] **Step 4: Commit Task 4**

```bash
git add index.js lib/emotion.js lib/emotion-engine.js lib/tier3-llm.js lib/overlay-generator.js lib/interpretation-overlay.js test/emotion-tier-config.test.js tests/*overlay*.test.js tests/*emotion*.test.js
git commit -m "fix: remove hard-coded chat model defaults"
```

Inspect the staged path list and exclude unrelated wildcard matches before commit.

---

### Task 5: Align configuration, installer, docs, diagnostics, and deploy integrity

**Files:**
- Modify: `openclaw.plugin.json`
- Modify: `lib/setup/config-contract.js` only if current descriptions/default extraction need correction
- Modify: setup/profile sources found by `rg -n 'merging|skillMiner|schicht15|criticalPush|emotion.*model' lib/setup scripts`
- Modify: `docs/configuration.md`
- Modify: `README.md`
- Modify: `tests/config-docs-contract.test.js`
- Modify/create: `tests/openclaw-default-llm-contract.test.js`
- Modify: `scripts/lib/deploy-integrity.mjs`
- Modify: `tests/deploy-integrity.test.js`
- Modify: `.superpowers/sdd/progress.md`
- Modify: `docs/audits/2026-07-19-b11-configuration-contract-fix.md`

- [ ] **Step 1: Write RED schema/docs/profile/deploy contract tests**

Update `tests/config-docs-contract.test.js` so the old fallback assertion is replaced with all of:

```js
assert.match(configuration, /absent[^\n]*effective OpenClaw agent model/i);
assert.doesNotMatch(configuration, /Fallback[^\n]*merging\.model[^\n]*kimi-for-coding/i);
assert.equal(Object.hasOwn(defaults.emotion.t3, "model"), false);
```

Create `tests/openclaw-default-llm-contract.test.js` to scan current-behavior source/config/profile files and assert:

- no runtime chat model default literal in `index.js` or `lib/**/*.js`;
- no cross-feature fallback patterns identified in Task 3;
- optional chat model schema fields have no `default`;
- descriptions state absent means effective OpenClaw agent model;
- setup safe/recommended profile objects do not persist a chat model;
- direct transport plus missing model behavior is documented as fail-closed;
- explicit README examples remain clearly labelled examples and are not described as defaults;
- `DEPLOY_FILES` contains `lib/llm-router.js`.

Use a narrow file allowlist rather than scanning historical specs/plans, test fixtures, embedding/reranker defaults, or examples as if they were runtime defaults.

- [ ] **Step 2: Run contract tests to verify RED**

Run:

```bash
node --test --test-concurrency=1 tests/config-docs-contract.test.js tests/openclaw-default-llm-contract.test.js tests/deploy-integrity.test.js tests/smoke-feature-profiles.test.js
```

Expected: FAIL on old docs wording and missing router deploy entry.

- [ ] **Step 3: Update manifest/config descriptions without adding defaults**

For every existing chat-model schema field, state: absent uses the effective OpenClaw model for the target agent. For direct `baseUrl`/`apiKey`/headers fields, state that a feature-local explicit model is required for direct transport.

Do not add a global PLUR1BUS chat-model field. Do not copy values into safe/recommended profiles. Do not change embedding or reranker model defaults.

- [ ] **Step 4: Update current-behavior documentation**

In `docs/configuration.md` and `README.md`, document the four route modes, per-agent native selection, no cross-feature inheritance, native cache bypass, partial-override fail-closed behavior, and missing-runtime fail-soft behavior. Keep named model snippets only as explicit override examples.

Replace the current Emotion row claiming `merging.model -> kimi-for-coding` fallback with the OpenClaw-default contract.

- [ ] **Step 5: Add the router to deployment integrity**

Add `"lib/llm-router.js"` adjacent to `lib/llm-call.js` and `lib/llm-result-cache.js` in `scripts/lib/deploy-integrity.mjs`. Strengthen `tests/deploy-integrity.test.js` with an explicit assertion, while retaining the existing direct-import coverage test.

- [ ] **Step 6: Record route observability and B11 evidence**

Ensure diagnostics/log events use only these stable route labels:

```text
openclaw-default
openclaw-override
direct-override
unavailable
failed
```

Where the host returns provider/model, record those values without credentials. Update the B11 audit receipt and `.superpowers/sdd/progress.md` with the implementation commits, focused test command/count, remaining review state, and the fact that the earlier docs-only R5 resolution was superseded by this implemented runtime contract.

- [ ] **Step 7: Run Task 5 gates**

Run:

```bash
node --test --test-concurrency=1 \
  tests/config-docs-contract.test.js \
  tests/openclaw-default-llm-contract.test.js \
  tests/deploy-integrity.test.js \
  tests/smoke-feature-profiles.test.js \
  tests/runtime-config-contract.test.js
npm run lint
git diff --check
```

Expected: all tests PASS, lint exits 0, no whitespace errors.

- [ ] **Step 8: Commit Task 5**

```bash
git add openclaw.plugin.json lib/setup/config-contract.js lib/setup scripts/lib/deploy-integrity.mjs docs/configuration.md README.md tests/config-docs-contract.test.js tests/openclaw-default-llm-contract.test.js tests/deploy-integrity.test.js tests/smoke-feature-profiles.test.js .superpowers/sdd/progress.md
git add docs/audits/2026-07-19-b11-configuration-contract-fix.md
git commit -m "docs: align config with OpenClaw LLM defaults"
```

Inspect the staged diff and unstage unrelated setup files.

---

### Task 6: Independent review, remediation, and authoritative B11 verification

**Files:**
- Modify only files required by validated Critical/Important review findings
- Modify: `.superpowers/sdd/progress.md`
- Modify: `docs/audits/2026-07-19-b11-configuration-contract-fix.md`
- Create: `/tmp/plur1bus-sdd/openclaw-default-llm-review.md`
- Create: `/tmp/plur1bus-sdd/openclaw-default-llm-serial.md`

- [ ] **Step 1: Perform an independent specification-compliance review**

Give a fresh reviewer the approved spec, this plan, and the exact diff range from `33bb9c4` to current HEAD. Require a PASS/FAIL verdict for every binding decision and test-design item. The reviewer must explicitly inventory all `callLlm`, `llmCfg`, `mergingLlmCfg`, model fallback, direct transport, `runtime.llm.complete`, and named-model occurrences.

Save the evidence-backed result to `/tmp/plur1bus-sdd/openclaw-default-llm-review.md`.

- [ ] **Step 2: Perform an independent code-quality/security review**

Use another fresh reviewer or a separate review pass. Require findings grouped by Critical/Important/Minor and inspect:

- credentials/header/prompt leakage;
- mixed-provider partial overrides;
- wrong-agent routing;
- native model-key omission;
- cancellation listener/timer leaks;
- swallowed errors or changed fail-soft contracts;
- native cache contamination or direct-cache regressions;
- feature activation regressions;
- register-time model calls;
- deploy/repair omissions;
- source/docs/profile drift.

Do not accept “looks good” without file/line evidence.

- [ ] **Step 3: Fix every validated Critical/Important finding with TDD**

For each finding: reproduce it with a failing focused test, verify RED, implement the smallest fix, verify GREEN, and commit with a focused message. Re-run both independent review passes after fixes until there are no Critical or Important findings. Record Minor findings as accepted/deferred only with a concrete rationale in the review report.

- [ ] **Step 4: Run the focused B11/default-LLM gate**

Run:

```bash
node --test --test-concurrency=1 \
  tests/llm-router.test.js \
  tests/llm-result-cache*.test.js \
  tests/openclaw-default-llm-runtime.test.js \
  tests/openclaw-default-llm-callers.test.js \
  tests/openclaw-default-llm-contract.test.js \
  test/emotion-tier-config.test.js \
  tests/*emotion*.test.js \
  tests/*overlay*.test.js \
  tests/config-docs-contract.test.js \
  tests/deploy-integrity.test.js \
  tests/runtime-config-contract.test.js \
  tests/smoke-feature-profiles.test.js
npm run lint
git diff --check
```

Resolve wildcard paths first with `rg --files` and remove duplicate filenames if the shell would run the same test twice. Expected: all selected tests PASS, no new skip, lint/check exit 0.

- [ ] **Step 5: Run the authoritative full serial suite**

Run:

```bash
node --test --test-concurrency=1 tests/*.test.js test/*.test.js
```

Capture the complete TAP output and summarize command, commit, suite count, test count, pass/fail/skip, duration, and known-skip identity in `/tmp/plur1bus-sdd/openclaw-default-llm-serial.md`.

Expected: zero failures and no new skip. If the sandbox blocks a nested process with `EPERM`, rerun the exact same command under the already authorized execution mechanism; do not modify tests to evade the sandbox.

- [ ] **Step 6: Verify repository and branch boundaries**

Run:

```bash
git status --short --branch
git diff --check 33bb9c4..HEAD
git log --oneline --decorate 33bb9c4..HEAD
git -C /root/openclaw-plur1bus-memory status --short --branch
```

Expected: integration worktree clean on `fix/high-mid-audit-findings`; primary checkout unchanged from its pre-task state; no push performed.

- [ ] **Step 7: Close the B11 seam and hand off to B12-Core**

Update `.superpowers/sdd/progress.md` and the exact B11 receipt with:

- final implementation/fix commit range;
- independent spec and quality verdicts;
- focused and full serial evidence;
- exact known skip, if unchanged;
- “B11 final review complete” only after all Critical/Important findings are closed;
- B12 requirement: query refinement and semantic compression must consume `lib/llm-router.js`, pass current `agentId`, preserve base-recall fallback/timeout, and never add a model default.

Commit only the ledger/receipt update if it changed:

```bash
git add .superpowers/sdd/progress.md docs/audits/2026-07-19-b11-configuration-contract-fix.md
git commit -m "docs: close OpenClaw default LLM review"
```

Then continue the active remediation sequence without pausing: `B12-Core -> B5 -> B13 -> (B8 || B15) -> B12-P -> B14`.
