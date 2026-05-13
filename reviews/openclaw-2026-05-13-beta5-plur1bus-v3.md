# OpenClaw v2026.5.12-beta.5 Compatibility Review for PLUR1BUS v3

## Summary

- **Beta target:** `v2026.5.12-beta.5`, commit `2cdd69a303e311da587b7c6a5913fb7ff8039299`.
- **npm target:** `npm view openclaw@2026.5.12-beta.5 version` and `npm view openclaw@beta version` both returned `2026.5.12-beta.5`.
- **Primary local diff:** `v2026.5.12-beta.4...v2026.5.12-beta.5` = 47 commits, 248 files changed.
- **GitHub metadata:** the beta5 release page has detailed notes. Those notes were used as context only; local `git log`, `git diff`, `git show --stat`, and file inspection are the compatibility basis.
- **ClawSweeper:** local gate reported 47 unreviewed commits and 0 clean reports. This is an external review-state signal, not a substitute for local diff review.

Verdict: **Beta5 code review is pass-with-known-risk. Full normal packaged-plugin runtime Go is blocked by OpenClaw beta5's dependency security scanner until PLUR1BUS/OpenClaw gets a trust/allowlist or dependency architecture answer for LanceDB/OpenAI.**

## Evidence Split

- **Own local diff/file analysis:** all commit classifications, Plugin Loader/SDK/Memory/Gateway/Hook/Cron/Session/Installer risk assessment, PLUR1BUS package shape, `npm pack`, unit tests, non-root install/inspect/doctor smokes.
- **GitHub UI/API metadata:** release page exists and includes detailed beta5 notes. No GitHub compare UI was used as a diff replacement.
- **npm preflight:** exact beta5 and beta dist-tag availability only.
- **ClawSweeper state:** 47 unreviewed reports; kept separate from the local analysis.

## Local Findings

### Blocking / High

1. **OpenClaw beta5 scans installed dependency runtime code.**
   - Source: local normal plugin tarball install.
   - Related commits: `8b840b28e5`, `1415c06fc4`, `a8f03295c4`.
   - Impact: direct PLUR1BUS dependencies on `@lancedb/lancedb` and `openai` make normal tarball install fail because OpenClaw flags `child_process` and dynamic-code patterns in dependency files.
   - Result: normal package install is blocked without `--dangerously-force-unsafe-install`.
   - Mitigation needed: OpenClaw-side trusted native dependency policy, known-package scanner allowlist, or a PLUR1BUS dependency split with explicit operator-approved runtime lane.

2. **PLUR1BUS package was not self-contained enough for native install.**
   - Source: local package/file analysis and `npm pack`.
   - Fix applied: `package.json` now declares `main`, runtime `files`, and direct `@lancedb/lancedb`/`openai` dependencies.
   - Fix applied: runtime import now tries direct dependencies first and keeps `memory-lancedb-stock` only as a legacy local fallback.

3. **Plugin registration failed without `OPENAI_API_KEY`.**
   - Source: forced non-root plugin install smoke.
   - Fix applied: missing embedding API key no longer fails plugin register/inspect/doctor. Memory operations still fail clearly when an embedding call actually needs a key.

### Medium / Smoke Required

- Gateway v4 chat delta changes (`deltaText`/`replace`) affect future transcript/incremental capture design, but did not break current `agent_end`/`before_prompt_build` registration.
- Runtime config warning attribution is now plugin-scoped; PLUR1BUS should avoid deprecated `runtime.config.loadConfig/writeConfigFile` paths in future.
- Managed npm peer/dependency repair changed substantially; PLUR1BUS package install/update/uninstall must stay in the smoke set.
- The global root refusal was removed upstream; PLUR1BUS compatibility work must keep enforcing non-root isolation itself.

## PLUR1BUS Status Against Beta5

- `openclaw.plugin.json`: present, contracts list `memory_store`, `memory_recall`, `memory_forget`, `knowledge_update`.
- `package.json.openclaw.extensions`: present as `["./index.js"]`.
- Native surfaces: `registerMemoryPromptSupplement`, `registerMemoryCorpusSupplement`, `agent_end`, `before_prompt_build`, `gateway_start`, `gateway_stop`, `/plur1bus`.
- Default mode remains augment; no default `registerMemoryCapability`; `memory-core` remains slot owner.
- Package after fix: `npm pack --dry-run` contains 11 runtime entries only and no tests.

## Smoke Results

- `node --check index.js`: pass.
- `node --check lib/neo-arch.js`: pass.
- `node --test __tests__/*.test.js`: pass, 9/9.
- `npm pack --dry-run --json`: pass, runtime files only.
- Non-root exact beta5 install-cli lane:
  - User: `kimi`.
  - Version: `OpenClaw 2026.5.12-beta.5 (2cdd69a)`.
  - Result: pass.
- Normal PLUR1BUS tarball install:
  - Result: blocked by beta5 dependency runtime scanner.
- Forced PLUR1BUS tarball install:
  - Result: pass with explicit unsafe-install warning.
  - `openclaw plugins inspect --json --runtime`: pass.
  - `openclaw plugins doctor`: pass.
  - With hook permissions set, runtime hooks include `agent_end`, `before_prompt_build`, `gateway_start`, `gateway_stop`.

Root-write note: all smoke commands used `kimi` and explicit isolated `HOME`, `USERPROFILE`, `OPENCLAW_HOME`, `XDG_*`, `TMPDIR`, `NPM_CONFIG_PREFIX`, and `NPM_CONFIG_CACHE` under `/tmp/openclaw-beta5-smoke-mLd3MS`. The live `/root/.openclaw` tree had concurrent cron/log writes during the same window, so a raw mtime scan of `/root/.openclaw` is polluted and cannot be treated as evidence that the smoke wrote there.

## Commit Classification Summary

- **Blocker:** dependency runtime scanning for packaged PLUR1BUS (`1415c06fc4`, `a8f03295c4`).
- **PLUR1BUS fix required and applied:** runtime entry scan/package cleanup (`8b840b28e5`), package self-containment, secretless register.
- **Smoke required:** plugin dependency repair, runtime config scoping, gateway v4 deltas, exact installer version behavior, root-guard removal.
- **No direct impact:** channel-specific WeCom/WhatsApp/Telegram changes, Gemini config normalization, release/CI/test-only commits.

Full per-commit classification is in `reviews/openclaw-2026-05-13-beta5-high-medium-analysis.json`.

## Forward-Look: origin/main

`origin/main` is not part of the Beta5 Go/No-Go. During this review it advanced to `433bafa55bc725c73557ac7164855264c76c529e`.

Useful future integration options:

- `session_end` with `shutdown`/`restart`: high value for finalizers, medium risk because duplicate-capture guards are required.
- Transcript update APIs such as `onSessionTranscriptUpdate`: high value for incremental capture if kept public/stable.
- `api.runtime.state.openKeyedStore`: useful for leases/idempotency; medium migration risk from JSONL/lockfile state.
- `cron.get` / `scheduleSessionTurn`: useful for Dreaming/Promote/Prune, but only behind a feature flag.
- Per-sender tool policies: high safety value for public/group memory tools.
- `registerMemoryCapability`: not default; only optional future slot-owner mode. `memory-core` remains the default slot owner.

## Go/No-Go

Beta5 code compatibility: **pass with known risk documented**.

Full normal packaged-plugin runtime compatibility: **no-go until the beta5 dependency scan block is resolved without unsafe force**.

Accepted interim state:

- GitHub beta5 code review completed.
- npm exact beta5 install-cli smoke passed.
- PLUR1BUS static/unit/packaging passed after fixes.
- Forced plugin runtime inspect/doctor passed.
- Normal PLUR1BUS tarball install remains blocked by OpenClaw beta5 dependency scanning.
