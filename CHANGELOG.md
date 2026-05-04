## [2.1.21] - 2026-05-04

### Fixed
- Added the versioned OpenClaw `2026.5.3-1` compat patch and kept the existing `2026.4.29` path as a separate wrapper instead of reusing the old hotfix blindly.
- Replaced the removed `openclaw plugins deps --json` update check with explicit local runtime dependency and manifest contract validation.
- Added `contracts.tools` metadata for `memory-lancedb-namespaced` so OpenClaw `2026.5.3-1` no longer rejects its registered tool diagnostics.
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
