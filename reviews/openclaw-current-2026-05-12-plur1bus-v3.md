# OpenClaw Current PLUR1BUS v3 Compatibility Review - 2026-05-12

## Target Snapshot

- Practical target: OpenClaw `origin/main` at `62fff1f738ab310d9d9f845925c79ee2557af818`.
- GitHub highest beta tag: `v2026.5.12-beta.1` at `1824464bf23e37b63eedce75f5c87f9ff9df1fae`.
- npm `openclaw@beta`: `2026.5.12-beta.1`.
- Baseline tag: `v2026.5.10-beta.5` at `1ba689376acc91f38c2e6b782f3f0f6859b517d8`.
- Merge-base `v2026.5.10-beta.5` vs `v2026.5.12-beta.1`: `f80db586896fba604a45d55bd09c03354b8b600d`.
- Merge-base `v2026.5.12-beta.1` vs `origin/main`: `067e83d121ddb05181b8c97cf8587e591059d6c4`.
- Live OpenClaw was not updated; checks used the temporary clone `/tmp/openclaw-current-2026-05-12` and local ClawSweeper state clone.

## Compatibility Decision

PLUR1BUS v3 needs one repo-side compatibility fix: the installer still accepted OpenClaw `2026.4.29`. It now must enforce `2026.5.10-beta.5+` with beta-aware comparison. No runtime entry, manifest discovery, SDK import, or memory-slot ownership change is required for the current OpenClaw loader snapshot.

Do not mix the new OpenClaw surfaces into this compatibility branch. They are useful backlog items, but not required to keep PLUR1BUS v3 loadable and smoke-testable against current `origin/main`.

## Range Summary

- beta12Only: 1051 commits; reviewed 605, unreviewed 446, findings 29 (high 0, medium 11, low 11, unweighted 7)
- beta5Only: 24 commits; reviewed 0, unreviewed 24, findings 0 (high 0, medium 0, low 0, unweighted 0)
- symmetricBetaDrift: 1075 commits; reviewed 605, unreviewed 470, findings 29 (high 0, medium 11, low 11, unweighted 7)
- mainOnly: 396 commits; reviewed 193, unreviewed 203, findings 5 (high 1, medium 2, low 2, unweighted 0)
- beta12OnlyVsMain: 9 commits; reviewed 0, unreviewed 9, findings 0 (high 0, medium 0, low 0, unweighted 0)
- symmetricReleaseMainDrift: 405 commits; reviewed 193, unreviewed 212, findings 5 (high 1, medium 2, low 2, unweighted 0)
- overviewBeta5ToMain: 1438 commits; reviewed 798, unreviewed 640, findings 34 (high 1, medium 13, low 13, unweighted 7)

## Implemented Fixes

- `scripts/install-memory-system.sh`: raised `MIN_OPENCLAW_VERSION` to `2026.5.10-beta.5`, preserved beta suffix extraction from `openclaw --version`, and replaced `sort -V` with a beta-aware rank comparator where stable releases on the same date compare newer than beta builds.
- `extensions/memory-lancedb-namespaced/__tests__/manifest-schema.test.js`: added static coverage that the installer enforces the v3 beta-aware minimum.
- `CHANGELOG.md`: documented the installer compatibility fix.

## Packaging And Loader Assessment

- PLUR1BUS package runtime entry is `./index.js`, so it does not depend on current OpenClaw's TypeScript source fallback behavior.
- `openclaw.plugin.json` keeps a static tool contract for `knowledge_update`, `memory_forget`, `memory_recall`, and `memory_store`.
- Hook use remains on `agent_end` and `before_prompt_build`; `agent_turn_prepare` is not required by current semantics.
- PromptSupplement and CorpusSupplement are still registered opportunistically when the host exposes those APIs.
- `memory-core` remains slot owner. PLUR1BUS v3 stays additive/augment and does not default to `registerMemoryCapability`.

## Isolated Beta CLI Check

- Installed `openclaw@beta` into `/tmp/openclaw-beta-cli-2026-05-12`; resolved version was `OpenClaw 2026.5.12-beta.1 (1824464)`.
- Used isolated `HOME=/tmp/openclaw-beta-home-2026-05-12` and profile `plur1bus-compat`; no live OpenClaw files were updated.
- `plugins doctor` was clean before PLUR1BUS install.
- `plugins install --link /root/openclaw-memory-system/extensions/memory-lancedb-namespaced` accepted the local package. A first runtime load without embedding config failed only because `OPENAI_API_KEY` was absent.
- With `OPENAI_API_KEY=dummy` and the installer-equivalent hook policy (`allowConversationAccess=true`, `allowPromptInjection=true`, `before_prompt_build=90000`, `agent_end=60000`), `plugins inspect --runtime` reported typed hooks `agent_end`, `before_prompt_build`, `gateway_start`, and `gateway_stop` with no diagnostics, and `plugins doctor` reported no plugin issues.

## High/Medium ClawSweeper Findings

| Sev | Commit | Area | Decision | Subject |
| --- | --- | --- | --- | --- |
| medium | 5171c2654a | plugin-loader-sdk | smoke-required | fix(models/auth): preserve primary when login omits --set-default |
| medium | f142bb0d6b | plugin-loader-sdk | smoke-required | test(extensions): type mocked calls explicitly |
| medium | 678b2510b2 | other | no-direct-plur1bus-impact | fix: abort generic no-progress tool loops |
| medium | 530b892f06 | gateway-exec-security | no-direct-plur1bus-impact | feat(tools): add per-sender tool policies (#66933) |
| medium | a17277d9b4 | other | no-direct-plur1bus-impact | test: verify auto-reply payloads |
| medium | efc8641393 | gateway-exec-security | no-direct-plur1bus-impact | fix: add channel status filtering (#80706) |
| medium | ce2eb4c367 | plugin-loader-sdk | smoke-required | fix: Fix the build: annotate provider-http test-helper exports for portable dts (#80781) |
| medium | f7ab8c26b1 | plugin-loader-sdk | smoke-required | fix(codex): scale context engine projection (#80761) |
| medium | db57da50c9 | other | no-direct-plur1bus-impact | fix: reintroduce partial-fragment drop for clean timeouts |
| medium | e1795256d5 | other | no-direct-plur1bus-impact | fix(docker): avoid external Dockerfile frontend pull |
| medium | 7624b0d16d | plugin-loader-sdk | smoke-required | fix(imessage): surface Full Disk Access probe failures |
| medium | 50f4440c96 | gateway-exec-security | no-direct-plur1bus-impact | Enforce inline shell wrapper payload matching [AI] (#80978) |
| high | 65d7232218 | gateway-exec-security | blocker-for-live-update | fix: detect carried exec command forms [AI] (#81000) |
| medium | 9ac4272b35 | gateway-exec-security | no-direct-plur1bus-impact | fix: harden safe-bin argument validation [AI] (#80999) |

## PLUR1BUS-Relevant Commit Classes

- Plugin loader/install/runtime entry changes: smoke-required, but no package fix because PLUR1BUS declares a JavaScript runtime entry.
- Memory/memory-core/QMD changes: smoke-required for `memory_search corpus=all/wiki/memory`, `memory_store`, `memory_recall`, `memory_forget`, `knowledge_update`, and auto-capture/auto-recall.
- Session/transcript/sqlite migration changes: no direct v3 blocker for hook-based capture; legacy cron/JSONL fallback should be treated as smoke/backlog rather than promoted behavior.
- Gateway exec approval high/medium findings on current main: blocker for live OpenClaw update safety, but not a PLUR1BUS code compatibility fix.

## Backlog: New OpenClaw Surfaces

| Surface | Benefit | Risk | Decision |
| --- | --- | --- | --- |
| session_end shutdown/restart | Can close/flush PLUR1BUS turn state on clean gateway stop/restart. | Double capture if combined naively with agent_end. | Backlog only; no compatibility gap because current PLUR1BUS capture is agent_end-based. |
| transcript update subscription | Could replace legacy JSONL polling and reduce stale cron fallback assumptions. | Large sqlite transcript migration surface; easy to duplicate captures. | Backlog; do not mix into compat branch. |
| keyed runtime state | Could move sessionWorkspaceKeys and small hook state into OpenClaw-owned persistent keyed stores. | New API adoption creates hard dependency and migration burden. | Backlog; current in-plugin state remains compatible. |
| cron/session wake | Could drain embedding/curation queues without external cron scripts. | Behavior promotion and duplicate capture if wake turns are treated as memory evidence. | Backlog; only smoke cron/heartbeat does not double-capture. |
| task flow | Potential durable long-running curation/dreaming workflow carrier. | New orchestration semantics, not required for plugin load or tools. | Backlog only. |
| public artifacts | Useful for exported memory evidence/reports. | Privacy and provenance policy work needed. | Backlog only. |

## Required Smokes Before Any Live OpenClaw Update

1. Temp-prefix install/doctor against the current OpenClaw snapshot, not the live instance.
2. `memory_store -> memory_recall -> memory_forget`.
3. `knowledge_update` with lock and backup path verification.
4. `agent_end` auto-capture and `before_prompt_build` auto-recall once per turn.
5. PromptSupplement and CorpusSupplement registration; `memory_search corpus=all`, `corpus=wiki`, and `corpus=memory`.
6. Cron/heartbeat check for no behavior promotion or duplicate capture.
7. Gateway exec-approval safety gate if moving the live OpenClaw install to this main snapshot.
