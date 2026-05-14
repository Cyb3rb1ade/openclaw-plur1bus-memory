# OpenClaw 2026.5.12-beta.8 vs PLUR1BUS v3.2

Date: 2026-05-14

PLUR1BUS target: `memory-lancedb-namespaced@3.2.0-beta.1`

OpenClaw target:

- npm exact: `openclaw@2026.5.12-beta.8`
- npm beta dist-tag: `2026.5.12-beta.8`
- tag: `v2026.5.12-beta.8`
- commit: `097daf917d98f20678e3ac39ce6b7fa1ebf96e62`
- baseline range: `v2026.5.12-beta.6..v2026.5.12-beta.8`

## Go / No-Go

Status: **go with documented limits**.

No PLUR1BUS code change is required for beta8 compatibility. The isolated link and `npm-pack:` managed tarball lanes both load PLUR1BUS as `kind: "extension"`, keep `memory-core` as the memory slot owner, register the v3.2 memory embedding provider bridge at runtime, and pass `plugins doctor`.

Important correction: the actual beta6-to-beta8 range has **78 commits**, not the stale planned value of 75. ClawSweeper confirms 78 unreviewed commits, and all 78 were classified in the JSON artifact.

Remaining limits:

- `openclaw capability embedding providers --json` lists only `local`; `plugins inspect --json --runtime` shows the three PLUR1BUS providers in both lanes. This is an inspect/capability-CLI visibility limit, not a runtime registration failure.
- Local E5 remains experimental; no real local model smoke or model download was run.
- Remote memory operation smoke remains provider/key blocked; no OpenAI or OpenAI-compatible test key was used.
- Security audit on the isolated tarball profile reports missing loopback gateway auth. That is expected for the throwaway profile and is not a PLUR1BUS install/runtime blocker.

## Evidence

Static and package checks:

- `node --check extensions/memory-lancedb-namespaced/index.js`: pass
- `node --check extensions/memory-lancedb-namespaced/lib/providers/openclaw-memory-embedding-adapters.js`: pass
- `node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js`: pass, 11 tests
- `npm pack ./extensions/memory-lancedb-namespaced`: pass
- tarball includes `lib/providers/openclaw-memory-embedding-adapters.js`
- tarball contains no model cache

Isolated beta8 install:

- install path: `install-cli.sh --prefix "$BASE/prefix" --version 2026.5.12-beta.8 --no-onboard --json`
- version check: `OpenClaw 2026.5.12-beta.8 (097daf9)`
- all lane OpenClaw commands were executed through `runuser -u kimi -- env ... "$BASE/prefix/bin/openclaw"`
- bare `openclaw` was not used

Lane A, link:

- profile: `plur1bus-beta8-v32-link`
- install: pass
- runtime inspect: pass
- `plugins doctor`: pass
- hook policy: `allowConversationAccess=true`, `allowPromptInjection=true`, `before_prompt_build=90000`, `agent_end=60000`
- typed hooks: `agent_end`, `before_prompt_build`, `gateway_start`, `gateway_stop`
- provider IDs in runtime inspect: `plur1bus-openai`, `plur1bus-openai-compatible`, `plur1bus-e5-small`

Lane B, `npm-pack:` managed tarball:

- profile: `plur1bus-beta8-v32-tarball`
- install: `plugins install npm-pack:/tmp/plur1bus-v32-beta8-eReoBI/artifacts/memory-lancedb-namespaced-3.2.0-beta.1.tgz`
- install metadata: `artifactKind: "npm-pack"`
- runtime inspect: pass
- `plugins doctor`: pass
- typed hooks: `agent_end`, `before_prompt_build`, `gateway_start`, `gateway_stop`
- provider IDs in runtime inspect: `plur1bus-openai`, `plur1bus-openai-compatible`, `plur1bus-e5-small`
- managed dependencies installed: `@lancedb/lancedb`, `openai`, optional `@huggingface/transformers`
- no model cache directory found under the tarball profile

## Hard Invariants

Pass:

- PLUR1BUS manifest has no `kind: "memory"`.
- PLUR1BUS runtime inspect reports `kind: "extension"`.
- `registerMemoryCapability` is not used.
- `contracts.memoryEmbeddingProviders` contains exactly:
  - `plur1bus-openai`
  - `plur1bus-openai-compatible`
  - `plur1bus-e5-small`
- `contracts.tools` remains:
  - `knowledge_update`
  - `memory_forget`
  - `memory_recall`
  - `memory_store`
- `memory-core` inspect reports `kind: "memory"` and `memorySlotSelected: true`.
- `memory-core` owns `memory_search` and `memory_get`.
- PLUR1BUS remains an augment plugin and does not take the memory slot.

## Beta8 Review

ClawSweeper:

- command: `/root/openclaw-memory-system/scripts/clawsweeper-gate.sh 2026.5.12-beta.6 2026.5.12-beta.8 --no-block`
- result: 78 unreviewed, no blocking gate failure
- classification after local review:
  - blocker: 0
  - plur1bus-fix-required: 0
  - smoke-required: 9
  - no-direct-impact: 59
  - integration-opportunity: 10

Release-note-specific surfaces:

| Surface | Result | PLUR1BUS impact |
| --- | --- | --- |
| Plugin-owned runtime entrypoint scan | pass | `npm-pack:` install and doctor pass; warning is non-blocking |
| Managed peer reconciliation | pass | managed npm root installed required and optional deps |
| Prefer npm-installed memory-lancedb | pass | no conflict; `memory-core` remains slot owner |
| `memory-core` SDK alias restored | pass | use `memory-host-core` for future work, not deprecated alias |
| Structured env SecretRefs | pass | Provider bridge does not resolve secrets on inspect/register |
| Transcript `messageSeq` | pass | no break; future Turn Journal ordering opportunity |
| Rich reply payloads | pass | no break; future capture evidence opportunity |
| Subagent default model precedence | pass | no current PLUR1BUS lane break; review future subagent jobs |
| OpenAI-compatible array schema fix | pass | no PLUR1BUS schema failure observed |

## Integration Backlog

- `memory-host-core`: use only the vendor-neutral SDK surface if PLUR1BUS needs deeper memory-host integration. Do not depend on the deprecated `memory-core` alias.
- `messageSeq`: evaluate for Turn Journal order and duplicate prevention once exposed through plugin event payloads.
- Rich reply payload capture: preserve `presentation`, `interactive`, and `channelData` as evidence later without reducing text capture.
- Subagent session maintenance: useful only if PLUR1BUS migrates long-running jobs to native OpenClaw subagents.
- Explicit run timeout forwarding: useful for future native cron/subagent deep maintenance jobs.

## Functional Regression Notes

Pass:

- Provider bridge runtime registration.
- Auto-Capture hook registration after explicit `allowConversationAccess=true`.
- Auto-Recall hook registration after explicit `allowPromptInjection=true`.
- Link lane and `npm-pack:` managed tarball lane.
- First-class plugin packaging evidence through `npm-pack:` install.

Blocked by test inputs, not beta8:

- Local E5 real embedding smoke: no model download/model execution performed.
- Remote memory operation smoke: no test key or deterministic OpenAI-compatible harness used.

Observed but not blocking:

- `plugins inspect --runtime` lists plugin command `plur1bus`, but `openclaw plur1bus` is not a top-level CLI command in beta8. `plugins doctor` passes, so this is not counted as an OpenClaw beta8 breaking.
