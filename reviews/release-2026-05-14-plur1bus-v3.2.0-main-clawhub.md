# PLUR1BUS v3.2.0 Mainline and ClawHub Readiness

Date: 2026-05-14

## Verdict

PLUR1BUS v3.2.0 is promoted to `main`, v2 is preserved on `legacy/v2`, and the ClawHub code-plugin release is published.

The real ClawHub publish was performed after explicit user confirmation. No tag was created or pushed.

## Branches and Commits

- v2 preserved branch: `legacy/v2`
- v2 commit: `fd36dcce2c7e58962fb098179dfdeb643b31f43a`
- v2 evidence: `main` and tag `v2.1.32` both pointed to this commit before promotion.
- v3.2 source branch: `neo-arch-openclaw-current-compat`
- v3.2 release commit: `ba342a15e34de9951cd4a68ad15deee5d9cc6db7`
- main promotion: fast-forward, no force push.
- main release commit used for ClawHub dry-run: `ba342a15e34de9951cd4a68ad15deee5d9cc6db7`
- final documented main commit: `1aa59d9fefe38dbc2cbf57d45f84f297a0375e49`

## Package

- package name: `@cyb3rb1ade/plur1bus-memory`
- package version: `3.2.0`
- OpenClaw plugin id: `memory-lancedb-namespaced`
- OpenClaw target: `2026.5.12`
- `openclaw.build.openclawVersion`: `2026.5.12`
- `openclaw.build.pluginSdkVersion`: `2026.5.12`
- `openclaw.compat.pluginApi`: `>=2026.5.12-beta.6`
- `openclaw.compat.minGatewayVersion`: `2026.5.12-beta.6`

## Guardrails

Pass:

- PLUR1BUS remains an OpenClaw augment/extension plugin.
- `memory-core` remains the memory slot owner.
- No `kind:"memory"` in PLUR1BUS.
- No memory capability registration literal remains in the plugin tree.
- No `autoSelectPriority`.
- No `allowExplicitWhenConfiguredAuto`.
- Provider bridge remains declared and runtime-visible:
  - `plur1bus-openai`
  - `plur1bus-openai-compatible`
  - `plur1bus-e5-small`

## Validation

Static and unit checks:

- `node --check extensions/memory-lancedb-namespaced/index.js`: pass
- `node --check extensions/memory-lancedb-namespaced/lib/providers/openclaw-memory-embedding-adapters.js`: pass
- `node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js`: pass, 11 tests
- `npm pack ./extensions/memory-lancedb-namespaced`: pass

OpenClaw stable `2026.5.12`:

- install-cli isolated prefix: pass
- link lane `plur1bus-3-2-0-stable-link`: pass
- npm-pack lane `plur1bus-3-2-0-stable-tarball`: pass
- `memory-core` slot owner: pass
- PLUR1BUS runtime kind: `extension`
- provider bridge runtime-visible: pass
- no model cache after inspect/register: pass

OpenClaw beta `2026.5.12-beta.8` recheck after metadata update:

- install-cli isolated prefix: pass
- link lane `plur1bus-3-2-0-beta8-link`: pass
- npm-pack lane `plur1bus-3-2-0-beta8-tarball`: pass
- `memory-core` slot owner: pass
- PLUR1BUS runtime kind: `extension`
- provider bridge runtime-visible: pass
- no model cache after inspect/register: pass

## ClawHub

Publisher identity:

- `clawhub whoami`: `Cyb3rb1ade`

Pre-mainline dry-run:

- folder dry-run: blocked by CLI path/ClawPack handling, `Path must be a folder or ClawPack .tgz`
- tarball dry-run: pass
- source ref: `neo-arch-openclaw-current-compat`
- source commit: `ba342a15e34de9951cd4a68ad15deee5d9cc6db7`

Final main dry-run:

- tarball dry-run: pass
- source ref: `main`
- source commit: `1aa59d9fefe38dbc2cbf57d45f84f297a0375e49`
- family: `code-plugin`
- name: `@cyb3rb1ade/plur1bus-memory`
- version: `3.2.0`
- tag advertised by dry-run: `latest`

Publish:

- publish result: pass
- source ref: `main`
- source commit: `1aa59d9fefe38dbc2cbf57d45f84f297a0375e49`
- package: `@cyb3rb1ade/plur1bus-memory@3.2.0`
- ClawHub publish id: `rd71zvvz3k3qcsg6j2kn3an6ys86qv4s`

Published install smoke:

- install command source: `clawhub:@cyb3rb1ade/plur1bus-memory`
- OpenClaw version: `2026.5.12`
- profile: `plur1bus-3-2-0-clawhub-published`
- install: pass
- `plugins inspect --json`: pass
- `plugins inspect --json --runtime`: pass
- `plugins doctor`: pass
- `memory-core` slot owner: pass
- PLUR1BUS runtime kind: `extension`
- provider bridge runtime-visible: pass
- no model cache after inspect/register: pass
- security audit: pass command execution; config warnings are profile-level, and the plugin code warning is the known static `node:fs` heuristic at `index.js:31`.

## Known Caveats

- Local E5 remains experimental until a real local model load/embed smoke is green.
- Local GTE reranker remains experimental/blocked until a real local reranker smoke is green.
- OpenClaw `capability embedding providers --json` may expose less than `plugins inspect --json --runtime`; runtime inspect is the pass criterion for PLUR1BUS provider visibility in this release.
- PLUR1BUS does not take over the memory slot. `memory-core` remains Slot-Owner.

## Publish and Tag Status

- publish result: `pass`
- tag result: `not-run`

Stop state: published. Tag remains uncreated/unpushed pending separate approval.
