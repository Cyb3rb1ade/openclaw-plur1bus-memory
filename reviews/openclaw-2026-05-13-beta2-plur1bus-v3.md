# OpenClaw 2026.5.12-beta.2 PLUR1BUS v3 Compatibility Review - 2026-05-13

## Target Snapshot

- Release source: https://github.com/openclaw/openclaw/releases/tag/v2026.5.12-beta.2
- Release: `v2026.5.12-beta.2`, prerelease, published `2026-05-12T22:15:42Z`.
- Beta2 commit: `fdb6e92ff57fce02be6d967d915623dd1d327fdb`.
- Previous beta: `v2026.5.12-beta.1` at `1824464bf23e37b63eedce75f5c87f9ff9df1fae`.
- Current `origin/main` at review time: `f96cfeeb73012465152d3472ff813cfeabc5bfa8`.
- Beta2 delta: 18 commits from beta1 to beta2.
- Main after beta2: 785 commits; treated only as forward-look, not the beta2 compatibility target.
- npm exact preflight: `openclaw@2026.5.12-beta.2` resolves to `2026.5.12-beta.2`.
- npm dist-tag preflight: `openclaw@beta` already resolves to `2026.5.12-beta.3`; the smoke used the exact beta2 version, not the dist-tag.

## Compatibility Decision

PLUR1BUS v3 is compatible with OpenClaw `2026.5.12-beta.2` for loader, manifest, package entry, hook policy, and non-root plugin integration. No PLUR1BUS code fix is required from the beta2 delta.

The only runtime limitation in this pass is functional embedding execution: `memory_store`, `memory_recall`, and `memory_forget` were not counted as passed because no real embedding key or local embedding stub was provided. That is a blocked functional smoke, not an OpenClaw beta2 failure.

## Beta2 Release Notes Classification

| Area | Beta2 note / diff source | PLUR1BUS decision |
| --- | --- | --- |
| Codex auth-profile media tools | Release notes, `84a2060a64`, `22a6717e11`, `a4743ad180` | No direct PLUR1BUS impact; useful pattern for auth-profile-aware dynamic tools, but PLUR1BUS memory tools remain normal plugin tools. |
| Dynamic/per-sender tool policies | Release notes mention canonical channel-scoped sender keys | Smoke-required before live rollout; no repo fix because PLUR1BUS does not bypass OpenClaw tool policy. |
| Gateway token caps | Release notes and `eab66220f8` wire `max_completion_tokens` / `max_tokens` to `streamParams.maxTokens` | No direct memory plugin break; useful for future curation/report jobs that call Gateway OpenAI HTTP. |
| Provider stream diagnostics | Release notes and `23dc2bfcd8` drain split SSE/JSON chunks and bound Azure first-event stalls | No break; reduces false hanging turns before PLUR1BUS `agent_end` capture. |
| Provider error surfacing | Release notes, `985bc40711`, `b86c387d6c` | No break; better failure text when model backends fail before memory capture. |
| `cron.get` | Release notes | Integration opportunity: PLUR1BUS scheduled curation/heartbeat status could use cron inspection later. |
| `memory-wiki` scope hardening | Release notes | Smoke-required for `memory_search corpus=wiki/all`; no PLUR1BUS fix found because PLUR1BUS keeps `memory-core` as slot owner. |
| Bundled metadata / plugin inspector advisory | Release notes | No break; keep using `plugins inspect` / `plugins doctor` as release gates. |
| Plugin SDK subpath deprecations/removals | Release notes | No break found; PLUR1BUS does not import removed SDK subpaths in current code. |
| pnpm 11 / source install behavior | Release notes, `03e4b035f1`, `6115eada6d`, `pnpm-workspace.yaml` | No PLUR1BUS break; testbed installed PLUR1BUS sibling deps with npm in isolated prefix. |

## Runtime Entry And Manifest Boundary

- `openclaw.plugin.json` is used for discovery/config/contracts, not code entrypoint declaration.
- PLUR1BUS manifest contains `id`, `version`, `configSchema`, and `contracts.tools` for `knowledge_update`, `memory_forget`, `memory_recall`, and `memory_store`.
- The actual runtime entry is in `extensions/memory-lancedb-namespaced/package.json` via `openclaw.extensions: ["./index.js"]`.
- Beta2 `plugins inspect` accepted this package-level runtime entry and resolved the source to `.../memory-lancedb-namespaced/index.js`.
- No TS-source fallback or manifest-entrypoint fix is required.

## Non-root OpenClaw Integration

- Non-root user: `kimi`, UID/GID `1000/1000`.
- Base: `/tmp/openclaw-beta2-nonroot-qisz30`.
- HOME: `/tmp/openclaw-beta2-nonroot-qisz30/home`.
- Prefix: `/tmp/openclaw-beta2-nonroot-qisz30/prefix`.
- OpenClaw installed through `install-cli.sh --prefix ... --version 2026.5.12-beta.2 --no-onboard --json`.
- `OPENCLAW_ALLOW_ROOT` was not used for OpenClaw commands.
- `openclaw --version`: `OpenClaw 2026.5.12-beta.2 (fdb6e92)`.
- Pre-install `plugins doctor`: no plugin issues.
- PLUR1BUS was linked from a copied full repo under `/tmp`, not from `/root`.
- Sibling deps were installed under `extensions/memory-lancedb-stock/node_modules` before runtime inspect.
- Initial link used a world-writable repo copy and Beta2 correctly blocked that plugin candidate. Permissions were tightened to remove group/world write bits from the plugin path; this is a useful testbed hardening signal, not a PLUR1BUS break.
- Runtime inspect after isolated config showed typed hooks `agent_end`, `before_prompt_build`, `gateway_start`, `gateway_stop`, command `plur1bus`, no diagnostics, and hook policy `allowConversationAccess=true`, `allowPromptInjection=true`, `before_prompt_build=90000`, `agent_end=60000`.
- Post-config `plugins doctor`: no plugin issues.
- Runtime config set `baseDbPath` explicitly to `/tmp/openclaw-beta2-nonroot-qisz30/home/.openclaw/memory/lancedb-namespaced`.
- Runtime HOME scan found no `/root`, `/usr/local`, `/opt`, or `OPENCLAW_ALLOW_ROOT` references. A source test fixture in the copied repo contains `/root/.openclaw/workspace-neo`; it is not runtime config.

## Beta2 Commit Classification

| Commit | Decision | Reason |
| --- | --- | --- |
| `fdb6e92ff5` | no-direct-impact | Auth test typing only. |
| `7f0fc0bab4` | no-direct-impact | Canvas bundle hash only. |
| `8f212d0b6f` | smoke-required | Release/package metadata bump across bundled extensions; validates inspector and package surface. |
| `b86c387d6c` | no-direct-impact | Provider internal error formatting; helpful but no memory plugin API change. |
| `23dc2bfcd8` | smoke-required | Provider stream handling plus memory-core schema flattening; run memory_search corpus smokes before live rollout. |
| `985bc40711` | no-direct-impact | Visible fallback errors for auto-reply; no PLUR1BUS loader/API break. |
| `eab66220f8` | integration-opportunity | Gateway OpenAI HTTP token caps may help future PLUR1BUS curation/report calls. |
| `22a6717e11` | no-direct-impact | Release-note-only Codex media auth-profile entry. |
| `a4743ad180` | no-direct-impact | Codex migration/app-server readiness changes; no PLUR1BUS import dependency. |
| `1df4df6eed` | no-direct-impact | Docker auth profile mount. |
| `ca8bc5500d` | no-direct-impact | Onboarding auth check. |
| `930046df04` | no-direct-impact | Onboarding accepts Codex auth. |
| `03e4b035f1` | smoke-required | Matrix no longer runtime-installs deps from parent cwd; confirms source install policy tightened. |
| `6115eada6d` | smoke-required | Baileys/pnpm install policy note; source install behavior should be watched. |
| `84a2060a64` | no-direct-impact | Codex dynamic tools receive auth profile store; possible future pattern only. |
| `bc6090502c` | no-direct-impact | CI live rerun workflow. |
| `d3a8a45119` | no-direct-impact | CI advisory wrapper shell. |
| `b12cd4358d` | no-direct-impact | Docker CLI backend live test noninteractive. |

## Deeper Integration Backlog

| Surface | Benefit | Risk | Decision |
| --- | --- | --- | --- |
| `session_end` shutdown/restart | Flush or close PLUR1BUS turn state on gateway stop/restart. | Double capture if combined with `agent_end`. | Backlog; no beta2 compatibility need. |
| `cron.get` | Inspect PLUR1BUS scheduled curation/heartbeat jobs by id. | Could promote cron behavior into memory evidence accidentally. | Backlog with no capture side effects. |
| Per-sender tool policies | Restrict memory tools for public/sandboxed senders. | Misconfigured policies could hide memory tools. | Backlog; document policy-aware smokes before live rollout. |
| Plugin SDK session actions / `scheduleSessionTurn` | Native scheduling for curation and follow-up memory work. | New SDK dependency and migration burden. | Backlog only. |
| Active model metadata in plugin factories | Better diagnostics and provider-specific memory policy. | Could couple PLUR1BUS to host model internals. | Backlog only. |
| Provider stream diagnostics | More reliable failure/capture boundary around provider stalls. | None for PLUR1BUS if treated as host behavior. | Use as operational signal, not plugin code change. |

## Verification

- `node --check extensions/memory-lancedb-namespaced/index.js`: pass.
- `node --check extensions/memory-lancedb-namespaced/lib/neo-arch.js`: pass.
- `bash -n scripts/install-memory-system.sh`: pass.
- `node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js`: 9/9 pass.
- `npm pack ./extensions/memory-lancedb-namespaced`: pass, shasum `ff857c53953dc85fd8bf07688d64c03394739f08`; tarball removed.
- Non-root Beta2 install, inspect, runtime inspect, and doctor: pass.
- Functional embedding smokes: blocked without real test key or local embedding stub.
