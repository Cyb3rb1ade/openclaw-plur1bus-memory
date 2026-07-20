# OpenClaw Default LLM Contract

**Date:** 2026-07-20  
**Status:** Approved
**Scope:** PLUR1BUS chat/LLM calls only. Embedding and reranker models are not chat LLMs and remain outside this contract.

## Goal

Whenever an enabled PLUR1BUS feature needs a chat LLM and that feature has no
explicit model override, it must use the effective OpenClaw model for the target
agent. PLUR1BUS must not invent, persist, or silently select a model such as
`kimi-for-coding` or `gpt-4o-mini`.

The effective model, provider, credentials, aliases, and fallback order remain
owned by OpenClaw. Explicit PLUR1BUS feature overrides remain supported.

## Binding decisions

1. **OpenClaw owns the default.** Default-mode calls use
   `api.runtime.llm.complete()` with the `model` field omitted.
2. **Agent scope is preserved.** PLUR1BUS passes the current `agentId` whenever
   the caller has one. OpenClaw therefore applies an agent-specific model before
   `agents.defaults.model.primary` and manages its configured fallbacks.
3. **Explicit overrides win.** A non-empty model on the feature that owns the
   call is authoritative for that call.
4. **No cross-feature model inheritance.** An absent `emotion.t3.model`,
   `schicht15.model`, `skillMiner.model`, or `criticalPush.model` does not inherit
   `merging.model`. It uses the OpenClaw default. Features without their own
   model key also use the OpenClaw default.
5. **No implicit activation.** This contract changes model selection only.
   Existing manifest/profile `enabled` gates, confirmation gates, budgets,
   rate limits, provider gates, and fail-soft behavior remain authoritative.
6. **No hard-coded runtime fallback.** Library constructors and runtime callers
   do not default to a named chat model.

## Resolution modes

Every chat-LLM invocation resolves into exactly one of these modes.

### Native default

Condition:

- the owning feature has no non-empty `model`; and
- it has no direct endpoint/credential transport fields that imply an
  incomplete explicit provider override.

Behavior:

- call `api.runtime.llm.complete({ messages, agentId, purpose, ... })`;
- omit `model` entirely;
- let OpenClaw resolve the effective agent model, provider authentication,
  aliases, and fallback chain;
- record the provider/model returned by OpenClaw in diagnostics without
  exposing credentials.

### Native explicit override

Condition:

- the owning feature has a non-empty `model`; and
- it does not supply direct OpenAI-compatible transport settings.

Behavior:

- call `api.runtime.llm.complete()` with that explicit model;
- retain `agentId`, audit purpose, timeout/cancellation, and OpenClaw-managed
  provider authentication/fallback behavior.

### Direct explicit override

Condition:

- the owning feature has a non-empty `model`; and
- it explicitly supplies one or more direct transport fields such as
  `baseUrl`, `apiKey`, or custom headers.

Behavior:

- preserve the existing bounded OpenAI-compatible direct-call path;
- use only that feature's explicit model and transport settings;
- never fill a missing value from another feature's config;
- preserve exact-result caching only for this route, whose endpoint,
  credential fingerprint, and model are known before the call.

### Ambiguous partial override

Condition:

- direct transport fields are present but the owning feature has no model.

Behavior:

- do not send a request;
- return the feature's normal fail-soft/skip result and log a safe warning;
- never combine custom credentials or a custom endpoint with an inferred
  OpenClaw model;
- never log secrets or headers.

This fail-closed rule prevents credentials intended for one endpoint from being
used with a model selected for another provider.

## Architecture

### Shared LLM router

A focused runtime module owns chat-LLM selection and dispatch. Its public API:

- accepts the OpenClaw runtime surface, logger, and existing direct-call
  implementation through dependency injection;
- accepts messages, the owning feature config, `agentId`, purpose, token and
  temperature limits, timeout, and optional cancellation signal;
- returns normalized text plus resolved provider/model metadata where
  available;
- reports an explicit unavailable/failed result instead of inventing a model.

The router is the only component allowed to decide between native and direct
chat-LLM execution. Feature modules remain responsible for prompts, parsing,
budgets, and domain fallbacks.

### Runtime seam

`index.js` creates one router from `api.runtime` during registration. It does
not snapshot `agents.defaults.model.primary`; native calls omit `model` so the
current OpenClaw runtime remains authoritative after supported config reloads.

Callers pass the current agent ID at invocation time. A caller that genuinely
has no agent context omits it and therefore uses OpenClaw's default agent model.
No LLM call is made during plugin registration.

### Feature ownership

The following enabled PLUR1BUS paths use the shared contract:

- merge/conflict resolution and reconsolidation;
- Schicht 1.5 knowledge promotion;
- Skill Miner;
- Critical Push classification;
- Emotion Tier 3;
- daily consolidation, dreaming, dream narrative/echo, persona voice,
  afterthoughts, meta-cognition LLM reports, and other callers that previously
  borrowed the merging LLM config;
- B12 query refinement and semantic compression when those features are
  implemented.

Each call is attributed to its real feature for explicit config selection and
audit purpose. A call belonging to Emotion T3 may use `emotion.t3.model`; it
does not use `merging.model`. A call belonging to merging may use
`merging.model`.

Pure domain modules such as the emotion engine do not inspect OpenClaw config.
They receive an injected completion function and never select a named model.

## Availability and feature gates

Model availability is separate from feature activation.

- `enabled:false` remains a hard no-call gate.
- Safe-profile LLM features remain off.
- Recommended-profile features keep their existing explicit activation,
  confirmation, rate, and fail-soft gates.
- A native OpenClaw runtime counts as an available LLM route even when no model
  appears in PLUR1BUS config.
- Direct mode counts as available only when its explicit model and transport
  contract is complete.
- If `api.runtime.llm.complete` is unavailable, native-mode calls skip/fallback
  with a warning. They do not fall back to a named model or direct credentials
  from another feature.

## Errors, timeouts, and cancellation

- Native calls receive a bounded abort signal derived from the feature timeout
  and any caller signal.
- Direct calls retain the existing bounded timeout.
- Provider errors follow each feature's existing fail-soft or explicit error
  contract; the shared router does not turn errors into plausible content.
- Every caught error is returned, rethrown, or logged through the repository's
  safe logging conventions. No new silent catch is allowed.
- Logs may contain feature name, agent ID, route, provider/model returned by
  OpenClaw, and error class. They must not contain prompts, API keys, auth
  headers, or raw credential-bearing config.

## Caching and observability

- Direct explicit calls retain PLUR1BUS exact-result caching because their
  endpoint/model identity is known before execution.
- Native OpenClaw calls do not use the existing pre-call PLUR1BUS result-cache
  key: OpenClaw may select a fallback model, and guessing that identity would
  risk a cross-model cache hit. Host-level caching remains available.
- Decision Trace and diagnostics record `openclaw-default`,
  `openclaw-override`, `direct-override`, `unavailable`, or `failed`, plus the
  resolved provider/model when the runtime returns it.
- No credential material is persisted in traces or cache metadata.

## Configuration and documentation

- Chat-model schema fields remain optional and have no named default.
- Descriptions state: absent model means the effective OpenClaw agent model.
- Direct endpoint/credential fields require an explicit model to become an
  active direct route; otherwise the invocation fails closed as an ambiguous
  partial override.
- Examples may name models only as explicit examples, never as defaults.
- Current-behavior documentation must not claim `merging.model` is the fallback
  for another feature.
- Installer and profile application must not copy the current OpenClaw model
  into PLUR1BUS config. Leaving the field absent preserves live inheritance.

## Compatibility and rollout

- Existing complete explicit feature overrides keep working.
- Existing configurations that omitted chat models begin using the effective
  OpenClaw agent model only when their feature is already enabled.
- Existing configurations with direct transport fields but no model no longer
  infer a foreign model; they skip/fallback and emit a migration warning.
- Existing `merging.model` remains authoritative for merging calls only.
- No memory data, LanceDB schema, embeddings, reranker vector dimensions,
  provider registry, or namespace layout changes.
- If a new router module is added, deployment-integrity and repair manifests
  must include it.

## Test design

TDD coverage must prove the following boundaries before implementation:

1. Native default omits `model`, carries the correct `agentId` and purpose, and
   returns the provider/model reported by a fake OpenClaw runtime.
2. Different agent IDs can resolve to different host models without PLUR1BUS
   config changes.
3. Native explicit override passes the owning feature's model to OpenClaw.
4. Direct explicit override uses the existing direct client and never invokes
   the native runtime.
5. Direct transport without a model makes no request and returns an explicit
   unavailable/skip result.
6. Missing native runtime makes no request and never selects a hard-coded
   fallback.
7. Feature-specific absence does not inherit `merging.model`.
8. Existing activation, confirmation, rate, timeout, and fail-soft gates remain
   unchanged.
9. Emotion T3 and its pure classifiers contain no named model fallback.
10. Source and current-behavior documentation contain no hard-coded PLUR1BUS
    runtime chat-model default; explicit examples remain allowed.
11. B12 query refinement/compression use the same router and preserve their
    timeout/base-recall fallback contracts.
12. Focused runtime/config/docs/deploy tests and the complete serial suite pass
    with no new skip.

## Non-goals

- Changing embedding or reranker providers/models.
- Enabling an otherwise disabled LLM feature.
- Persisting OpenClaw's current default into PLUR1BUS config.
- Reimplementing OpenClaw provider authentication, alias resolution, model
  catalogs, or fallback order.
- Adding a second plugin-specific global chat-model setting.
- Changing prompts, memory semantics, recall ranking, or storage as part of
  this contract.

## Sequencing with the remediation program

This contract is a B11/B12 seam correction and must land before B12-Core:

1. implement and independently review the shared router and migrated B11 LLM
   callers;
2. re-run the B11 configuration/runtime/docs/deploy gates and full serial suite;
3. update the exact-base B12 brief so query refinement/compression bind to this
   router;
4. continue `B12-Core -> B5 -> B13 -> (B8 || B15) -> B12-P -> B14`.

Main and remote remain untouched throughout this sequence.
