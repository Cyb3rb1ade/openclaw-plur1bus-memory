# OpenClaw v2026.5.12-beta.6 Compatibility Review for PLUR1BUS v3.1

## Summary

- **Beta target:** `v2026.5.12-beta.6`, commit `c4292e053d7c86361700b3acb59cb51e4a310f2d`.
- **npm target:** `npm view openclaw@2026.5.12-beta.6 version` and `npm view openclaw@beta version` both returned `2026.5.12-beta.6`.
- **Primary local diff:** `v2026.5.12-beta.5..v2026.5.12-beta.6` = 10 commits, 151 files changed.
- **Merge-base:** `v2026.5.12-beta.5` is the merge-base for beta5 -> beta6, so the beta range is linear.
- **Forward look:** `origin/main` advanced to `b10b946b125d3147b4237e46033d9ae48f4af88e` during review and is not part of the Beta6 verdict.
- **ClawSweeper:** local gate reported 0 clean findings and 10 unreviewed commits. This is external review-state only, not a diff substitute.

Verdict: **Beta6 compatibility is pass-with-provider-blocked-functional-smokes.** The beta5 normal tarball install blocker is resolved by OpenClaw beta6's scanner changes. PLUR1BUS v3.1 installs as a managed tarball plugin with direct dependencies in an isolated non-root prefix. Full memory operation smokes remain blocked until an embedding provider is available.

## Evidence Split

- **Own local diff/file analysis:** beta5 -> beta6 `git log`, `git diff --stat`, focused diffs for `install-security-scan.runtime.ts`, `install.test.ts`, and `skill-scanner.ts`, plus OpenClaw SDK/manifest docs for memory embedding providers.
- **npm preflight:** exact beta6 and `@beta` availability only.
- **ClawSweeper state:** local `clawsweeper-gate.sh 2026.5.12-beta.5 2026.5.12-beta.6 --no-block`; not used as a diff replacement.
- **Runtime smoke:** isolated temp base `/tmp/openclaw-beta6-plur1bus-v31-STpLvI`, OpenClaw installed with exact beta6 under non-root `kimi`, using only `$BASE/prefix/bin/openclaw`.

No GitHub compare UI result was used as a full diff replacement.

## Local Findings

### High / Blocking

None found for PLUR1BUS v3.1 on Beta6.

### Compatibility-Positive Changes

1. **OpenClaw beta6 scopes plugin install code scanning to the plugin-owned runtime graph.**
   - Source: local diff of `src/plugins/install-security-scan.runtime.ts` and `src/plugins/install.test.ts`.
   - Commit: `c4292e053d`.
   - Impact: PLUR1BUS repo scripts and dependency runtime files are no longer scanned as if they were plugin-owned runtime code. Imported local plugin runtime files are still scanned.

2. **OpenClaw beta6 allows benign LanceDB runtime shim patterns.**
   - Source: local diff and tests.
   - Commit: `ab8b4eacce`.
   - Impact: known `@lancedb/lancedb` native-loader and ESM interop patterns no longer block managed plugin install. This directly removes the beta5 normal tarball install blocker.

3. **PLUR1BUS tarball lane is self-contained enough for first-class plugin install.**
   - Source: isolated managed tarball install plus direct import check.
   - Result: `@lancedb/lancedb`, `openai`, and optional `@huggingface/transformers` installed under the managed plugin directory and imported from there.
   - Result: no `memory-lancedb-stock` sibling exists in the managed tarball install path, so the legacy fallback did not mask dependency readiness.

### Medium / Smoke Required

- The plugin scanner still reports one suspicious network pattern for PLUR1BUS because Cohere reranking uses explicit `fetch("https://api.cohere.com/v2/rerank", ...)`. It is a warning, not a block. This should remain documented as expected remote-provider behavior.
- Without `hooks.allowConversationAccess`, Beta6 blocks `agent_end` for non-bundled plugins. After setting `hooks.allowConversationAccess=true` and `hooks.allowPromptInjection=true` in the isolated tarball profile, runtime inspect reports `agent_end`, `before_prompt_build`, `gateway_start`, and `gateway_stop`.
- Runtime inspect reports tool contracts from the manifest, but the runtime `registerTool` factory appears as `tools: [{ names: [] }]`. This is not a new Beta6 break in this review, but tool execution should stay in the functional smoke set.
- Functional memory smokes are blocked without a real or test embedding provider. This is not a Beta6 breaking change.

## Commit Classification Summary

- **PLUR1BUS relevant / compatibility-positive:** `c4292e053d`, `ab8b4eacce`, `e2c32243e9`.
- **Smoke-required but no direct fix:** `1f18e8864d`, `bd840af600` for Codex app-server/session behavior around runners.
- **No direct PLUR1BUS impact:** `485dbeb5ba`, `5f9249b059` iMessage media fixes.
- **No runtime impact:** `7470221401`, `bde26a965c`, `a44012c087` release/build metadata.

Full structured classification is in `reviews/openclaw-2026-05-13-beta6-high-medium-analysis.json`.

## Smoke Results

- `node --check extensions/memory-lancedb-namespaced/index.js`: pass.
- `node --check scripts/memory-doctor.mjs`: pass.
- `bash -n scripts/install-memory-system.sh`: pass.
- `node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js`: pass, 10/10.
- `npm pack ./extensions/memory-lancedb-namespaced`: pass, 17 files, provider files included.
- Exact non-root install-cli lane:
  - User: `kimi`.
  - Binary: `$BASE/prefix/bin/openclaw`.
  - Version: `OpenClaw 2026.5.12-beta.6 (c4292e0)`.
  - Status: pass.
- Link lane:
  - Profile: `plur1bus-beta6-v31-link`.
  - OpenClaw home: `$BASE/home-link/.openclaw`.
  - Status: pass as dev evidence.
  - Limitation: link lane does not install required dependencies, so it is not first-class plugin evidence.
- Tarball lane:
  - Profile: `plur1bus-beta6-v31-tarball`.
  - OpenClaw home: `$BASE/home-tarball/.openclaw`.
  - Status: pass.
  - Managed direct dependencies: pass.
  - Runtime inspect after hook permissions: pass.
  - Plugin doctor: pass.
- Root isolation:
  - `bareOpenclawUsed=false`.
  - No root escape files found under the isolated homes.
  - Commands used the isolated prefix binary instead of PATH `openclaw`.

## Function Regression Matrix

- `memory_store`: blocked, provider unavailable for embedding call.
- `memory_recall`: blocked, provider unavailable for embedding call.
- `memory_forget`: blocked as end-to-end smoke; registration/contracts present.
- `knowledge_update`: blocked as end-to-end smoke; registration/contracts present.
- Auto-Capture via `agent_end`: pass for hook registration after permissions.
- Auto-Recall via `before_prompt_build` / PromptSupplement: pass for hook registration.
- CorpusSupplement / `memory_search corpus=all`: pass for registration surface; end-to-end blocked without running memory provider smoke.
- Turn Journal: pass via unit coverage; runtime capture blocked without real agent turn/provider.
- Candidates: pass via unit coverage.
- Reaction Ledger: pass via unit coverage.
- BehaviorCards: pass via unit coverage.
- Embedding Queue: pass via unit/config coverage; provider execution blocked.
- Categories: pass via unit coverage.
- Origins: pass via unit coverage.
- Trust-Level: pass via unit coverage.
- Status-Machine: pass via unit coverage.
- Recall-Lanes: pass via unit coverage.
- Dreaming: not applicable to Beta6 compatibility smoke; no Beta6 breaking change found.
- OpenAI provider: implemented, execution blocked without key.
- OpenAI-compatible provider: implemented, execution blocked without key.
- Cohere reranker: implemented, execution blocked without key.
- Disabled reranker: implemented.
- E5 local embedding: experimental; not marked pass because no local model smoke was run.
- GTE local reranker: blocked/experimental pending Node/Transformers.js model smoke.

## Beta6 Integration Opportunities

- `api.registerMemoryEmbeddingProvider(adapter)` and `contracts.memoryEmbeddingProviders` are public Beta6 plugin surfaces, documented in `docs/plugins/sdk-overview.md` and `docs/plugins/manifest.md`, and used by bundled providers such as `openai`, `voyage`, and `memory-core`.
- Value for PLUR1BUS: high. PLUR1BUS v3.1 could expose its OpenAI-compatible and local-transformers embedding providers to OpenClaw natively without taking over the memory slot.
- Risk: medium. This should be a follow-up feature flag or separate branch because memory-core remains the default slot owner and PLUR1BUS must not regress current internal provider behavior.
- Other forward-looking options: `session_end` shutdown/restart finalizers, `onSessionTranscriptUpdate`, and `scheduleSessionTurn` for Dreaming/Promote/Prune. These are not required for Beta6 compatibility.

## Forward-Look: origin/main

`origin/main` is not part of the Beta6 Go/No-Go. Current local forward snapshot: `b10b946b125d3147b4237e46033d9ae48f4af88e`.

Focused main-only items worth tracking:

- `4d2e708726 fix(memory-lancedb): support cjk auto-capture triggers` - useful idea for PLUR1BUS capture/category logic.
- `2a67a7f65e`, `402b0df3b6`, `f4cb20300f`, `18ca285ed6` - managed plugin dependency/peer repair hardening; keep tarball install/update/uninstall in smokes.
- `68c77bb55d` and `46f7750c63` - plugin hook type export evolution; monitor imports but no current PLUR1BUS break.
- `b7572cc384` - tools in LLM input hook event; potentially useful for richer Recall/Reflex attribution later.

## Go/No-Go

Beta6 code compatibility: **pass**.

First-class managed plugin install: **pass** for tarball lane with direct dependencies.

Full functional memory runtime: **blocked by missing embedding provider**, not by OpenClaw Beta6.

No PLUR1BUS compatibility code change is required for Beta6 based on this review. Next worthwhile integration work is optional: add a feature-flagged `contracts.memoryEmbeddingProviders` / `registerMemoryEmbeddingProvider` adapter path for PLUR1BUS providers.
