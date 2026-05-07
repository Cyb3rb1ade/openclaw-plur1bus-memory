## [2.1.28] - 2026-05-07

### Fixed
- Added OpenClaw `2026.5.7` support to the guarded updater, runtime patch dispatcher, and ExecStartPre patch path.
- Extended the `2026.5.4+` compatibility patch to cover `2026.5.7`; tarball dry-run and live marker verification passed.
- Repaired local YAAWC patch drift by restoring the Kimi `maxTokens` default to `32768` and rebuilding the YAAWC Docker stack.

### Verified
- Production OpenClaw upgraded to `2026.5.7`.
- ClawSweeper checked `2026.5.6 -> 2026.5.7`: 76 commits, 76 unreviewed reports, no state-repo findings available yet.
- `openclaw plugins doctor`, external `memory-doctor provider-check`, gateway restart/probe, YAAWC Docker rebuild, and HTTP readiness on `127.0.0.1:3020` passed.
- One known warning remains: the gateway read-diagnostic probe times out after the WebSocket connection is accepted; local loopback connect is OK.

## [2.1.27] - 2026-05-07

### Fixed
- Added OpenClaw `2026.5.6` support to the guarded updater, runtime patch dispatcher, and ExecStartPre patch path.
- Extended the `2026.5.4+` compatibility patch to cover `2026.5.6`; tarball dry-run and live marker verification passed.
- Repaired local YAAWC patch drift: `contentUtils.ts` preserves `AIMessage.additional_kwargs`, `reranker.ts` provides Cohere reranking, and `simpleWebSearchTool.ts` calls `rerank()`.

### Verified
- Production OpenClaw upgraded to `2026.5.6`.
- ClawSweeper checked `2026.5.5 -> 2026.5.6`: 17 commits, 17 unreviewed reports, no state-repo findings available yet.
- `update-openclaw.sh --check`, live update patch verification, YAAWC Docker rebuild, gateway restart, memory health checks, plugin registry refresh, and cron delivery-target checks passed.
- One known warning remains: the Whisper container is stopped, while NVIDIA/Riva STT is active and the old Faster-Whisper VAD path is intentionally skipped.

## [2.1.26] - 2026-05-06

### Fixed
- Removed deployment-specific `SYSTEM-DOCUMENTATION.md` from the public Git release scope and added it to `.gitignore`.
- Moved current systemd, ExecStartPre patch-chain, ClawSweeper, provider-check, cron and OpenClaw `2026.5.5` operational notes into the canonical public `how-to-memory-perfect.md`.
- Updated README links so the GitHub landing page points to `how-to-memory-perfect.md` as the single public operations document.

## [2.1.25] - 2026-05-06

### Fixed
- Added OpenClaw `2026.5.5` support to the guarded updater, ClawSweeper gate, runtime patch dispatcher, and ExecStartPre patch path.
- Taught ClawSweeper to resolve the local short commit from `openclaw --version` when the installed version has no GitHub tag or npm `gitHead`.
- Extended the `2026.5.4` compatibility patch to cover `2026.5.5`; tarball dry-run and live marker verification passed.
- Kept Kimi-only cron jobs pinned with `payload.fallbacks: []` after the update while preserving normal agent fallbacks.

### Verified
- Production OpenClaw upgraded to `2026.5.5`.
- ClawSweeper checked `2026.5.4 -> 2026.5.5`: 54 commits, 54 unreviewed reports, no state-repo findings available yet.
- `openclaw plugins doctor`, external `memory-doctor provider-check`, gateway journal readiness, and `openclaw cron list` passed after the final restart.

## [2.1.24] - 2026-05-05

### Fixed
- Added the versioned OpenClaw `2026.5.4` compat patch and dispatcher path.
- Made the 5.4 subagent lane import patch resilient to hashed `lanes-*.js` bundle filenames.
- Updated the guided OpenClaw updater to default to `2026.5.4`, dry-run the matching tarball patch, preserve 5.4 plugin contracts, and load `OPENAI_API_KEY` from `/root/.openclaw/.env` for the optional memory reindex.
- Hardened update diagnostics for ClawSweeper tag resolution, cron CLI fallbacks, intentional disabled cron jobs, Docker visibility in sandboxed checks, and plugin runtime drift detection.

### Verified
- Production OpenClaw upgraded to `2026.5.4`.
- `openclaw plugins doctor`, `memory-doctor stats`, and external `memory-doctor provider-check` passed after the upgrade.
- Live ExecStartPre patch chain under `/root/.openclaw/patches` synchronized and verified on gateway restart.

## [2.1.23] - 2026-05-04

### Fixed
- Made the OpenClaw update validation preserve the full `adaptive-learning-loop` runtime tool contract: `adaptive_learning_log`, `adaptive_learning_feedback`, `adaptive_learning_review`, and `adaptive_learning_apply`.
- Applied the same contract fix to the live local `adaptive-learning-loop` manifest and verified that `openclaw plugins doctor` no longer reports `contracts.tools` warnings.

## [2.1.22] - 2026-05-04

### Fixed
- Declared all `memory-lancedb-namespaced` runtime tools in `contracts.tools`: `memory_recall`, `memory_store`, `memory_forget`, and `knowledge_update`.
- Updated `update-openclaw.sh` validation so future OpenClaw updates preserve the complete memory tool contract instead of only `memory_recall`.
- Verified live plur1bus Store+Recall smoke tests on `main`, `bernhardine`, and `heisenberg` after the manifest fix.

## [2.1.21] - 2026-05-04

### Fixed
- Added the versioned OpenClaw `2026.5.3-1` compat patch and kept the existing `2026.4.29` path as a separate wrapper instead of reusing the old hotfix blindly.
- Replaced the removed `openclaw plugins deps --json` update check with explicit local runtime dependency and manifest contract validation.
- Added initial `contracts.tools` metadata for `memory-lancedb-namespaced`.
- Added a dependency-only `memory-lancedb-stock/index.js` runtime stub so the local LanceDB dependency package can remain installed without TypeScript runtime warnings.
- Migrated `memory-lancedb-namespaced` Auto-Recall and GC nudges from legacy `before_agent_start` to `before_prompt_build`.
- Disabled stale Discord channel auto-enable during 5.3 updates when the bundled Discord plugin is not present.
- Extended `update-openclaw.sh` with target-version validation, tarball patch dry-run, ClawSweeper full-range scan support, post-install patching, and 5.3-specific cleanup.

### Documentation
- Updated README, `HOW-TO-UPDATE.md`, `SYSTEM-DOCUMENTATION.md`, and `how-to-memory-perfect.md` for the validated OpenClaw `2026.5.3-1` local compat path.
- Documented that `toolsAllow` prefiltering and `hooks.allowConversationAccess` are upstream in OpenClaw `2026.5.3-1`, so the local 5.3 patch only keeps the remaining operational fixes.

## [2.1.20] - 2026-05-02

### Fixed
- Added a bundled runtime-deps race guard for OpenClaw `2026.4.29`: if the shared `plugin-runtime-deps` root already contains semver-satisfied packages, startup and per-plugin staging skip redundant `npm install` runs instead of racing into `ENOTEMPTY` rename failures.
- Documented the provider-neutral deployment pattern: existing agent, subagent, session and cron chat routes are preserved by default, while plur1bus only configures memory-internal embeddings and optional LLM features by explicit user choice.
- Clarified that native OpenClaw `agents.defaults.memorySearch` is optional and independent from plur1bus. It can be disabled without disabling plur1bus Auto-Recall or Auto-Capture.
- Removed deployment-specific quick-reference documentation from the public package. The canonical public documentation is `how-to-memory-perfect.md`.

### Documentation
- Added `SYSTEM-DOCUMENTATION.md` with systemd user service, ExecStartPre patch chain, user-cron GC, session-start, runtime-deps cache and provider-neutral operational notes.
- Added `HOW-TO-UPDATE.md` with the safe OpenClaw/plur1bus update, verification and release checklist.
- Updated README, plugin README and `how-to-memory-perfect.md` for OpenClaw `>=2026.4.29`, provider-neutral operation and runtime-deps cache repair.

## [2.1.19] - 2026-05-01

### Fixed
- Hardened provider-specific OpenClaw model configuration checks so optional compatibility guards only apply when the matching provider is configured.
- Kept provider routing user-controlled and avoided hidden defaults in optional memory LLM paths.

## [2.1.18] - 2026-05-01

### Fixed
- Restored Telegram group-chat automatic delivery by keeping group final replies and reasoning stream callbacks visible according to OpenClaw's schema-supported message policy.
- Updated update and patch scripts so OpenClaw restarts do not revert group delivery policy.

## [2.1.17] - 2026-05-01

### Fixed
- Removed hardcoded optional LLM fallbacks. `merging.enabled=true` now requires an explicit `merging.model`; `schicht15.enabled=true` requires either `schicht15.model` or an explicit `merging.model`.
- Made installer LLM merging provider-neutral: the model prompt is mandatory when the user enables merging.
- Clarified that plur1bus only requires an OpenAI-compatible embeddings endpoint or OpenRouter; optional LLM features need an explicitly configured OpenAI-compatible chat-completions endpoint.

## [2.1.16] - 2026-05-01

### Fixed
- Fixed Telegram direct-chat delivery after OpenClaw `2026.4.29` message-policy changes.
- Persisted reply-visibility repair in both `update-openclaw.sh` and `apply-plur1bus-user-hotfix.sh`.
- Added schema-safe provider-specific model defaults where required by OpenClaw validation.

## [2.1.15] - 2026-05-01

### Fixed
- Added subagent lane isolation and completion announce backpressure for OpenClaw `2026.4.29`.
- Native subagent dispatch, steer and send calls now use per-child lanes instead of the global subagent lane.
- Internal/session-only completion announcements no longer wait for a full final agent response.

## [2.1.14] - 2026-05-01

### Fixed
- Added heartbeat backlog backpressure for OpenClaw `2026.4.29` so broad startup/interval heartbeat sweeps are staggered instead of immediately re-entering a tight loop.
- Added a startup grace floor for heartbeat scheduling so Gateway cold starts can finish HTTP/channel readiness before due heartbeats begin.
- Kept per-agent LanceDB routing unchanged and did not disable any memory subsystem.
- Corrected installer `--dry-run` reporting for plugin copies, documentation copies and conflict-log additions.

## [2.1.13] - 2026-05-01

### Fixed
- Isolated normal embedded OpenClaw agent runs by session-derived global lanes when no explicit lane is provided.
- Made OpenClaw startup heartbeats due-aware.
- Added stale task-registry zombie reconciliation before old running tasks can spawn CPU-bound recovery children.

## [2.1.12] - 2026-05-01

### Fixed
- Isolated ActiveMemory embedded recall on its own command lane instead of OpenClaw's default lane.
- Added persistent silent-reply policy repair so intentional silent direct replies stay silent.
- Kept per-agent LanceDB routing under `{baseDbPath}/{agentId}/` unchanged.
- Fixed installer help so it exits before target detection.

## [2.1.11] - 2026-05-01

### Fixed
- Added provider-specific request-parameter guards for OpenClaw `2026.4.29` where required by configured providers.
- Tightened ActiveMemory prompt-hook blocking to reduce stuck prompt-build waits.

## [2.1.10] - 2026-05-01

### Fixed
- Added `patches/apply-plur1bus-user-hotfix.sh` for OpenClaw `2026.4.29` latency regressions around tool preparation, prompt building and embedded runs.
- Preserved plur1bus and ActiveMemory while reusing the active Gateway plugin registry and applying `toolsAllow` before plugin tool factories run.
- Exposed heavy built-in OpenClaw media/web tools as lazy descriptors.
- Retired the older direct ActiveMemory fast-path patch as a no-op because it could bypass the plur1bus plugin path on newer OpenClaw builds.
- Installer remote mode now transfers the user hotfix script together with `apply-memory-patches.sh`.
- Installer refreshes the OpenClaw plugin registry after direct plugin copies.
- `memory-doctor.mjs` falls back to installed `memory-lancedb-stock` dependencies when the Git checkout has no local `node_modules`.

## [2.1.9] - 2026-05-01

### Fixed
- Aligned README and plugin README displayed release version with the manifest after the OpenClaw `>=2026.4.29` minimum-version clarification.

## [2.1.8] - 2026-05-01

### Fixed
- Made the minimum required OpenClaw version explicit in GitHub-visible docs.
- Added installer preflight detection via `openclaw --version`; detected versions below `2026.4.29` abort before touching config or files.
- Updated requirements language to avoid implying OpenAI-only embeddings.

## [2.1.7] - 2026-05-01

### Fixed
- Made `install-memory-system.sh` explicitly user-driven for both existing installations and fresh installs.
- Existing installations default to preserving the full `memory-lancedb-namespaced` provider/model config.
- Added explicit choices for memory config and ActiveMemory config.
- Fresh installs derive defaults from the target OpenClaw config where possible instead of hardcoding chat-model features.
- Embedding setup asks for provider endpoint, model and vector dimensions when not preserving existing config.

## [2.1.0] - 2026-05-01

### Added
- Provider-neutral installer flow with OpenRouter embedding model discovery and dimension preflight.
- LanceDB per-agent isolation, Auto-Recall, Auto-Capture, TTL GC, conflict logging, optional merging, optional reranking and memory health tooling.
