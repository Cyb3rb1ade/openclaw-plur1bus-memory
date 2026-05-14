# OpenClaw 2026.5.12 Stable Compatibility Review for PLUR1BUS v3.2

Date: 2026-05-14

## Verdict

PLUR1BUS v3.2.0-beta.1 is compatible with OpenClaw 2026.5.12 in the tested static, unit, link-lane, and managed npm-pack lane surfaces.

No PLUR1BUS code change was required. No release or ClawHub metadata was changed in this pass. `openclaw.build.openclawVersion` and `openclaw.build.pluginSdkVersion` remain at `2026.5.12-beta.8`; moving them to `2026.5.12` should be a separate change followed by fresh pack, link-lane, npm-pack-lane, and ClawHub dry-run evidence.

## Target

- OpenClaw npm latest: `2026.5.12`
- OpenClaw tag: `v2026.5.12`
- OpenClaw release commit: `f066dd2f31c231f38fbcaacd6f6dfce0801143b3`
- Baseline: `v2026.5.12-beta.8`
- Baseline commit: `097daf917d98f20678e3ac39ce6b7fa1ebf96e62`
- Release range: `v2026.5.12-beta.8..v2026.5.12`
- Release commits reviewed: `7`
- PLUR1BUS commit tested: `70f8c2b1fc5979e458ccfae122b5aaef70991830`
- PLUR1BUS package: `@cyb3rb1ade/plur1bus-memory@3.2.0-beta.1`
- OpenClaw plugin id: `memory-lancedb-namespaced`

## Static and Pack Checks

Passed:

- `node --check extensions/memory-lancedb-namespaced/index.js`
- `node --check extensions/memory-lancedb-namespaced/lib/providers/openclaw-memory-embedding-adapters.js`
- `node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js`
- `npm pack ./extensions/memory-lancedb-namespaced`

Unit result: 11 tests passed, 0 failed.

Tarball contents were limited to the plugin runtime package:

- `package.json`
- `openclaw.plugin.json`
- `README.md`
- `index.js`
- `lib/`
- `lib/providers/openclaw-memory-embedding-adapters.js`

No `.env`, API keys, model caches, review artifacts, or `/root` paths were present in the plugin tarball.

## Isolated OpenClaw Harness

Base: `/tmp/plur1bus-oc2026512-ChdWBA`

Install path:

- `install-cli.sh`
- exact version `2026.5.12`
- prefix binary `/tmp/plur1bus-oc2026512-ChdWBA/prefix/bin/openclaw`
- version output: `OpenClaw 2026.5.12 (f066dd2)`

All OpenClaw commands were run as non-root user `kimi` with isolated `HOME`, `USERPROFILE`, `OPENCLAW_HOME`, `XDG_*`, `TMPDIR`, `NPM_CONFIG_PREFIX`, and `NPM_CONFIG_CACHE`.

No bare `openclaw` command was used.

## Link Lane

Profile: `plur1bus-2026-5-12-v32-link`

Result: pass.

Evidence:

- `plugins install --link` installed `memory-lancedb-namespaced`.
- Initial link attempt was blocked by a world-writable temp source path; this was a harness-permission issue and was fixed by removing world-write from the temporary source tree.
- `plugins inspect memory-lancedb-namespaced --json` passed.
- `plugins inspect memory-lancedb-namespaced --json --runtime` passed.
- `plugins doctor` returned `No plugin issues detected.`
- Runtime kind: `extension`
- Runtime hooks: `agent_end`, `before_prompt_build`, `gateway_start`, `gateway_stop`
- `policy.allowConversationAccess`: `true`
- `agents.defaults.memorySearch.provider`: `plur1bus-e5-small`
- Runtime provider ids:
  - `plur1bus-openai`
  - `plur1bus-openai-compatible`
  - `plur1bus-e5-small`

The link lane needed plugin dependencies installed in the temporary source tree before runtime import. This did not change tracked PLUR1BUS files.

## Managed npm-pack Lane

Profile: `plur1bus-2026-5-12-v32-tarball`

Result: pass.

Evidence:

- `npm pack` was run in the isolated tarball lane.
- Managed install used `plugins install "npm-pack:/tmp/plur1bus-oc2026512-ChdWBA/artifacts/cyb3rb1ade-plur1bus-memory-3.2.0-beta.1.tgz"`.
- OpenClaw recorded `artifactKind: "npm-pack"` and `artifactFormat: "tgz"`.
- `plugins inspect memory-lancedb-namespaced --json` passed.
- `plugins inspect memory-lancedb-namespaced --json --runtime` passed.
- `plugins doctor` returned `No plugin issues detected.`
- Runtime kind: `extension`
- Runtime hooks: `agent_end`, `before_prompt_build`, `gateway_start`, `gateway_stop`
- `policy.allowConversationAccess`: `true`
- `agents.defaults.memorySearch.provider`: `plur1bus-e5-small`
- Runtime provider ids:
  - `plur1bus-openai`
  - `plur1bus-openai-compatible`
  - `plur1bus-e5-small`

## Memory Slot and Provider Bridge

Pass:

- PLUR1BUS stays `kind: "extension"`.
- PLUR1BUS does not set `kind: "memory"`.
- PLUR1BUS does not call `registerMemoryCapability`.
- `memory-core` remains the selected memory slot owner.
- `memory-core` runtime inspect shows `kind: "memory"` and `memorySlotSelected: true`.
- PLUR1BUS provider ids are visible in both link and npm-pack runtime inspect.
- Setting `agents.defaults.memorySearch.provider = "plur1bus-e5-small"` did not require setting PLUR1BUS to `kind:"memory"`.
- No E5 model cache was created under the isolated link or tarball profile homes during inspect/runtime registration.

Capability CLI note:

- `openclaw capability embedding providers --json` returned only the built-in `local` provider in this release.
- This is an inspect/CLI visibility limitation, not a PLUR1BUS runtime registration failure, because `plugins inspect --json --runtime` exposes all three PLUR1BUS provider ids.

## ClawSweeper

Command:

`/root/openclaw-memory-system/scripts/clawsweeper-gate.sh 2026.5.12-beta.8 2026.5.12 --no-block`

Result:

- Commit range: 7 commits
- Known clean findings: 0
- Unreviewed findings: 7
- No ClawSweeper blocker was emitted, but all 7 release commits required local classification.

## Commit Classification

| Commit | Subject | Classification | PLUR1BUS impact |
| --- | --- | --- | --- |
| `df70248eae15` | `ci(release): retry ClawHub publish verification errors` | `integration-opportunity` | No runtime impact. Useful for PLUR1BUS release pipeline expectations because ClawHub verification now retries transient errors. |
| `c230b08e7451` | `fix(telegram): avoid worker postMessage lint suppression` | `no-direct-impact` | Telegram worker lint/runtime cleanup only. |
| `cfab2228cb7b` | `fix(doctor): respect runtime message tool grants` | `smoke-required` | Doctor output changed around runtime message grants. PLUR1BUS `plugins doctor` was re-smoked and passed. |
| `31f0c9b82f54` | `Fix/weixin catalog update 2.4.3 (#81730)` | `no-direct-impact` | External Weixin catalog only. |
| `7a0548ee96d8` | `docs(changelog): mention Weixin catalog bump` | `no-direct-impact` | Changelog only. |
| `2f27dcbb9f55` | `fix(config): stabilize heartbeat target help` | `no-direct-impact` | Config help/schema baseline change only; PLUR1BUS config set/get still passed in both lanes. |
| `f066dd2f31c2` | `chore(release): prepare 2026.5.12` | `smoke-required` | Version bump across bundled packages including memory packages. Link and managed npm-pack lanes passed against the final release build. |

## Release Notes Surface Check

OpenClaw 2026.5.12 release notes mention broader surfaces that were already part of the beta train and remain relevant for PLUR1BUS:

- Plugin install externalization and runtime dependency cones: no PLUR1BUS break observed; managed npm-pack lane passed.
- Doctor/runtime message grants: no PLUR1BUS break observed; doctor passed.
- Plugin SDK memory-core alias restored: compatible with PLUR1BUS staying out of the memory slot.
- Models config/auth structured SecretRefs: no inspect/register secret resolution was needed by PLUR1BUS.
- Gateway/session history message sequence and rich reply/channel surfaces: no direct PLUR1BUS memory plugin regression observed in install/inspect/doctor lanes.
- Agents/subagents model precedence: no direct PLUR1BUS install/runtime regression observed.
- OpenAI-compatible schema fixes: no direct PLUR1BUS provider bridge regression observed in registration surfaces.

## Current `main` Opportunity Scan

`main` is ahead of the stable release by a large unreleased range, so it was not used for Go/No-Go. A targeted log scan showed relevant future integration opportunities:

- parseable plugin JSON output
- hardening git-ref plugin checkout
- installed memory tool owner preference
- runtime graph install scanning
- managed peer repair and preservation
- plugin SDK hook type exports
- plugin list JSON fast path
- manifest-only plugin listing
- provider/embedding JSON wrapping fixes

Recommended follow-up: when these land in a tagged OpenClaw release, rerun the same isolated link and npm-pack lanes and consider adopting any new public SDK surface only if PLUR1BUS remains augment-only and loses no v3.1/v3.2 behavior.

## Security Audit Note

OpenClaw install warned that the plugin has one suspicious code pattern. `openclaw security audit --json` is global, not plugin-scoped in 2026.5.12, and reported default isolated-profile gateway warnings:

- loopback gateway auth missing
- trusted proxies not configured

These are harness configuration warnings, not PLUR1BUS package findings. `plugins doctor` passed in both lanes.

## Final Go/No-Go

Go for compatibility with OpenClaw 2026.5.12:

- Static/unit/pack: pass
- install-cli exact stable lane: pass
- Link lane: pass
- npm-pack managed tarball lane: pass
- `memory-core` slot owner: pass
- PLUR1BUS kind extension: pass
- no `registerMemoryCapability`: pass
- provider bridge visible in runtime inspect: pass
- capability CLI visibility: limited to built-in provider, documented
- no model download during inspect/register: pass
- no v3.1/v3.2 functional regression found in tested surfaces

Do not publish/tag from this review alone. If stable build metadata is changed from `2026.5.12-beta.8` to `2026.5.12`, rerun pack, beta/stable harnesses, and ClawHub dry-run on the final commit/artifact.
