# PLUR1BUS v3.2.1 Mainline and ClawHub Release

Date: 2026-05-15

## Verdict

PLUR1BUS v3.2.1 is published as a patch release over v3.2.0. It updates runtime recall
prompting and documentation so agents treat returned PLUR1BUS memories as
their accessible memory context for the current agent/workspace, while `origin`
remains provenance/evidence metadata and not an ownership signal.

No database migration is required from v3.2.0.

## Package

- package name: `@cyb3rb1ade/plur1bus-memory`
- package version: `3.2.1`
- OpenClaw plugin id: `memory-lancedb-namespaced`
- OpenClaw target: `2026.5.12`
- `openclaw.build.openclawVersion`: `2026.5.12`
- `openclaw.build.pluginSdkVersion`: `2026.5.12`
- `openclaw.compat.pluginApi`: `>=2026.5.12-beta.6`
- `openclaw.compat.minGatewayVersion`: `2026.5.12-beta.6`
- source commit: `ef139522654ab7ab0ec4060d411b35f832b5fc38`
- git tag: `v3.2.1`

## Changes

- Runtime `<relevant-memories>` prompt now says returned memories are accessible
  agent/workspace memory context, not instructions.
- Runtime `<plur1bus-recall>` prompt now says `origin`/provenance describes
  evidence source, not memory ownership.
- MemoryPromptSupplement now explicitly points agents to `agentId`, `storedBy`,
  `scope`, and namespace metadata for ownership/visibility decisions.
- README, plugin README, and `how-to-memory-perfect.md` document the same
  SOUL.md-compatible rule.
- Unit coverage now asserts the Neo recall prompt includes the ownership
  semantics.

## Guardrails

- PLUR1BUS remains an OpenClaw augment/extension plugin.
- `memory-core` remains the memory slot owner.
- No `kind:"memory"` was added.
- No `registerMemoryCapability` default path was added.
- Provider bridge remains unchanged:
  - `plur1bus-openai`
  - `plur1bus-openai-compatible`
  - `plur1bus-e5-small`
- Existing data, LanceDB tables, KNOWLEDGE.md, turn journal, candidates,
  BehaviorCards, curation state, and embedding queues are unchanged.

## Validation

Static and unit checks:

- `node --check extensions/memory-lancedb-namespaced/index.js`: pass
- `node --check extensions/memory-lancedb-namespaced/lib/neo-arch.js`: pass
- `node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js`: pass
- `npm pack ./extensions/memory-lancedb-namespaced`: pass
- package artifact: `cyb3rb1ade-plur1bus-memory-3.2.1.tgz`
- package size: `50622` bytes

## ClawHub

- publisher identity: `Cyb3rb1ade`
- dry-run: pass
- package publish: pass
- package: `@cyb3rb1ade/plur1bus-memory@3.2.1`
- source repo: `Cyb3rb1ade/openclaw-plur1bus-memory`
- source ref: `main`
- source commit: `ef139522654ab7ab0ec4060d411b35f832b5fc38`
- release id: `rd751a8ckvk227vtqy1s3354w586sx0t`
- published install smoke: not rerun for this patch; v3.2.0 managed install smoke remains applicable because v3.2.1 only changes runtime prompt text, docs, and version metadata.

## GitHub Release

- tag: `v3.2.1`
- release asset: `cyb3rb1ade-plur1bus-memory-3.2.1.tgz`
- status: pass
- release URL: `https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/releases/tag/v3.2.1`
- asset URL: `https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/releases/download/v3.2.1/cyb3rb1ade-plur1bus-memory-3.2.1.tgz`

## Known Caveats

- Local E5 remains experimental until a real local model load/embed smoke is
  green.
- Local GTE reranker remains experimental/blocked until a real local reranker
  smoke is green.
- PLUR1BUS does not take over the memory slot. `memory-core` remains Slot-Owner.
