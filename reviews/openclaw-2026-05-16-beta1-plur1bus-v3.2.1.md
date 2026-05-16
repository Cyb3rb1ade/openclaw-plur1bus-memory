# PLUR1BUS v3.2.1 vs OpenClaw 2026.5.16-beta.1

## Verdict

- **Beta compatibility:** partial pass.
- **First-class augment-plugin readiness:** pass after local fix.
- **Runtime pass:** not claimed; no live gateway was started.
- **No OpenClaw-dist patching, no root cron, no systemctl path:** preserved.
- **memory-core slot ownership:** preserved in the live config check.
- **PLUR1BUS functional surface:** load/registration intact; provider-backed store/recall smoke blocked by missing isolated embedding provider.

The important result is that OpenClaw `2026.5.16-beta.1` can install and load PLUR1BUS `3.2.1` through ClawHub, local npm-pack managed install, and linked dev install. The managed tarball lane is the strongest evidence: dependencies resolve inside the isolated plugin install, not through the legacy sibling fallback.

## Target Snapshot

- OpenClaw npm beta: `2026.5.16-beta.1`
- OpenClaw GitHub tag: `v2026.5.16-beta.1`
- Tag commit: `dc8790d3b4091bef59b6f1327fc6fe5e9cccdb4f`
- Baseline tag: `v2026.5.12`
- Baseline commit: `f066dd2f31c231f38fbcaacd6f6dfce0801143b3`
- Range size: `1963` commits
- Diff stat: `2966 files changed, 134026 insertions, 28924 deletions`
- PLUR1BUS repo commit: `467f330874d7f463433a67e191e8591a09a36ba9`
- PLUR1BUS package: `@cyb3rb1ade/plur1bus-memory@3.2.1`

GitHub release notes and npm preflight were used as context. Compatibility findings here come from local git log/grep/diff and isolated OpenClaw CLI runs, not from GitHub Compare rendering.

## Non-root Harness

- Base: `/home/kimi/plur1bus-321-beta16-20260516041520`
- OpenClaw binary: `/home/kimi/plur1bus-321-beta16-20260516041520/prefix/bin/openclaw`
- UID/GID: `1000/1000`
- Bare `openclaw` from PATH: not used
- Exact install: `openclaw@2026.5.16-beta.1`
- Gateway start: not performed

`/tmp` was not writable for `kimi` in this environment, so the isolated base was moved under `/home/kimi`. That is a harness correction, not a live-system dependency.

## Live Gateway Gate

The live gateway was not started. Live config was inspected read-only and no secrets are recorded here.

- `plugins.slots.memory`: `memory-core`
- PLUR1BUS entry: enabled
- `hooks.allowConversationAccess`: true
- `baseDbPath`: unchanged, `~/.openclaw/memory/lancedb-namespaced`
- embedding model/dimensions: unchanged, `text-embedding-3-large` / `3072`
- Cohere reranker: unchanged, `rerank-v3.5`
- `agents.list[].memorySearch`: none found
- `agents.defaults.memorySearch`: present but disabled; not modified in this audit

Because the live `agents.defaults.memorySearch` block still exists, live gateway start remains blocked under the user-supplied gate unless that config cleanup is explicitly approved.

## Static And Package Gates

- `node --check index.js`: pass
- `node --check lib/neo-arch.js`: pass
- `node --check lib/providers/openclaw-memory-embedding-adapters.js`: pass
- `node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js`: pass, 11 tests
- `npm pack`: pass
- Tarball: `cyb3rb1ade-plur1bus-memory-3.2.1.tgz`
- shasum: `28d55abe0336481498d17b6268d28f323546056e`

## Install Lanes

### ClawHub Managed Install

Pass.

- Installed `@cyb3rb1ade/plur1bus-memory@3.2.1`
- Manifest id resolved to `memory-lancedb-namespaced`
- `plugins inspect --json`: pass
- `plugins inspect --json --runtime`: pass
- `plugins doctor`: pass, no plugin issues detected

### Tarball Managed Install

Pass.

- Installed from isolated `npm-pack:` tarball
- Required deps installed inside managed plugin tree:
  - `@lancedb/lancedb`
  - `openai`
- Optional dep installed:
  - `@huggingface/transformers`
- No sibling fallback was needed.
- Runtime hooks registered:
  - `agent_end`
  - `before_prompt_build`
  - `gateway_start`
  - `gateway_stop`
- Runtime command registered:
  - `/plur1bus`
- Memory embedding providers surfaced:
  - `plur1bus-openai`
  - `plur1bus-openai-compatible`
  - `plur1bus-e5-small`

### Linked Dev Install

Pass after fixing harness permissions.

OpenClaw Beta16 blocks linked plugins from world-writable paths. The initial isolated source path was mode `777`, so the loader correctly blocked it. After `chmod go-w` on the isolated source tree, linked inspect/runtime-inspect/doctor passed.

## PLUR1BUS Surface

Manifest contracts still declare:

- `memory_store`
- `memory_recall`
- `memory_forget`
- `knowledge_update`

Runtime Inspect in Beta16 shows the plugin as `shape: non-capability`, with `capabilityMode: none`, which is correct for the current augment design.

Initial Runtime Inspect showed an empty tool `names` array. Local source review found the cause: PLUR1BUS used a tool factory without the Beta16-style `api.registerTool(factory, { names: [...] })` metadata. That has now been fixed in the working tree and verified with a fresh isolated tarball. Runtime Inspect now reports:

- `memory_recall`
- `memory_store`
- `memory_forget`
- `knowledge_update`

This fix is not published as a release package yet. I still did not mark provider-backed tool smokes as pass without a real provider or deterministic mock.

## Breaking Changes / Compatibility Risks

1. **Config `kind` is rejected.**
   Beta16 rejects `plugins.entries.<id>.kind`. This is correct: `kind` belongs to plugin manifests and exclusive slot plugins, not user config. Do not put `kind: "extension"` in OpenClaw config.

2. **Manifest has no explicit `kind`, and that is correct.**
   Beta16 documents manifest `kind` as an exclusive slot concept, currently `"memory"` or `"context-engine"`. PLUR1BUS must not set `kind: "memory"` because memory-core remains slot owner. Runtime `plugin.kind = "extension"` remains only a deprecated compatibility fallback and should not drive architecture.

3. **World-writable linked plugin paths are blocked.**
   This is a Beta16 security hardening and is good behavior. The tarball/managed lane is unaffected.

4. **Provider-backed functional smokes are blocked.**
   `memory_store -> memory_recall -> memory_forget` needs an isolated OpenAI/OpenAI-compatible key, local E5 smoke, or deterministic mock embedding provider. No live keys were used in this audit.

## ClawSweeper

Local ClawSweeper ran over `v2026.5.12..v2026.5.16-beta.1`.

- Clean: `866`
- Skipped non-code: `52`
- Findings: `79`
- High: `3`
- Medium: `46`
- Low: `29`
- Unweighted: `1`
- Unreviewed: `966`

High findings:

- `65d7232218` - exec command form detection. No direct PLUR1BUS runtime impact; confirms no shell fallback should be primary path.
- `dc7fab4dc5` - PI model discovery cache. Smoke-required for provider visibility; isolated plugin inspect stayed green.
- `2f2563314a` - delayed plugin marketplace. Smoke-required for ClawHub install; ClawHub managed install passed.

Relevant medium/plugin-memory areas were reviewed locally: package entry validation, compatibility metadata, managed peer dependencies, installed dependency scanning, alternate memory slot owners, lifecycle hook timeouts, runtime plugin preload, memory watcher pressure, malformed embedding JSON handling, active-memory provider routing, and command-cron lightweight turns.

## New OpenClaw Integration Opportunities

- **`session_end` with `shutdown` / `restart` reason:** high value for PLUR1BUS final capture/flush, but needs duplicate-capture guards.
- **`api.runtime.events.onSessionTranscriptUpdate(...)`:** high value for incremental Turn Journal capture without JSONL whole-file scans.
- **`api.runtime.state.openKeyedStore(...)`:** useful for leases, idempotency and scheduler state.
- **`api.session.workflow.scheduleSessionTurn(...)`:** useful for Dreaming/Promote/Prune scheduling behind a feature flag.
- **`contracts.memoryEmbeddingProviders` / `registerMemoryEmbeddingProvider`:** already integrated in PLUR1BUS v3.2.1 and visible in Beta16 inspect.
- **Gateway methods / admin HTTP RPC:** defer; useful later for operator diagnostics, but too broad for this compatibility branch.

## Go / No-Go

Go for isolated OpenClaw Beta16 plugin compatibility: **yes, partial pass**.

No-go for claiming full runtime memory functionality: **provider-backed tool smokes were blocked**.

No-go for live gateway start under the user gate: **live `agents.defaults.memorySearch` remains present and was not modified in this audit**.

Recommended next fixes:

1. Add a deterministic mock embedding provider smoke for `memory_store -> memory_recall -> memory_forget`.
2. Publish the local `registerTool` names fix in the next patch release if it should reach PLUR1BUS users.
