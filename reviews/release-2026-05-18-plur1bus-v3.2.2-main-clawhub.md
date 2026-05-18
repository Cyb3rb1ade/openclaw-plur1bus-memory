# PLUR1BUS v3.2.2 Mainline and ClawHub Release

Date: 2026-05-18

## Verdict

PLUR1BUS v3.2.2 is published as the stable v3.2.x patch release validated
against OpenClaw 2026.5.18. The release keeps PLUR1BUS as an OpenClaw-native
augment/extension plugin and does not take over the `memory-core` slot.

No database migration is required from v3.2.1.

## Package

- package name: `@cyb3rb1ade/plur1bus-memory`
- package version: `3.2.2`
- OpenClaw plugin id: `memory-lancedb-namespaced`
- OpenClaw validation target: `2026.5.18`
- source commit: `3a61e4c0833954184c4ce00c9d3de077d4b02ad7`
- git tag: `v3.2.2`

## Compatibility Audit

- audit artifact: `reviews/openclaw-2026-05-18-stable-plur1bus-v3.2.2-beta.1.md`
- target OpenClaw tag: `v2026.5.18`
- target OpenClaw commit: `50a2481652b6a62d573ece3cead60400dc77020d`
- exact npm target: `openclaw@2026.5.18`
- stable compatibility verdict: `pass`
- PLUR1BUS breaking changes found: `false`
- first-class plugin readiness: `pass`
- managed npm-pack install lane: `pass`

## Guardrails

- PLUR1BUS remains an OpenClaw augment/extension plugin.
- `memory-core` remains the memory slot owner.
- No `kind:"memory"` takeover was added.
- No default `registerMemoryCapability` path was added.
- Existing tools remain present:
  - `memory_store`
  - `memory_recall`
  - `memory_forget`
  - `knowledge_update`
- Existing hook/supplement surfaces remain present:
  - `agent_end`
  - `before_prompt_build`
  - MemoryPromptSupplement
  - MemoryCorpusSupplement
- Provider bridge remains present:
  - `plur1bus-openai`
  - `plur1bus-openai-compatible`
  - `plur1bus-e5-small`

## Validation

Static, unit, packaging, and runtime checks:

- `node --check extensions/memory-lancedb-namespaced/index.js`: pass
- `node --check extensions/memory-lancedb-namespaced/lib/neo-arch.js`: pass
- `node --check extensions/memory-lancedb-namespaced/lib/providers/openclaw-memory-embedding-adapters.js`: pass
- `node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js`: pass
- unit tests: `117` pass
- `npm pack --dry-run --json`: pass
- `npm pack --json`: pass
- final OpenClaw 2026.5.18 managed npm-pack install: pass
- `plugins inspect --json --runtime`: pass
- `plugins doctor`: pass

## ClawHub

- publisher identity: `Cyb3rb1ade`
- dry-run: pass
- package publish: pass
- package: `@cyb3rb1ade/plur1bus-memory@3.2.2`
- source repo: `Cyb3rb1ade/openclaw-plur1bus-memory`
- source ref: `v3.2.2`
- source commit: `3a61e4c0833954184c4ce00c9d3de077d4b02ad7`
- release id: `rd74qqtkaaj769kd58ka6pqbxh86yvdr`
- artifact: `cyb3rb1ade-plur1bus-memory-3.2.2.tgz`
- artifact kind: `npm-pack`
- artifact size: `50796`
- artifact sha256: `7571f91a73930fd9b1b76bd47d6645daa78ad170b2ee0e2539b0e16e51f40ee6`
- npm shasum: `dc2ba7bde687d8b9060f6893eda6ce451b2772ba`
- npm integrity: `sha512-oINrs69WvqUSacVOhci0ycfZ87HTBDAKkoj/nIKonAJgaSv+B/1IpBBY/NIbWShzYNAbZPNaNXmnu6+JqouURA==`
- ClawHub scan status at publish verification: `pending`

## GitHub Release

- tag: `v3.2.2`
- status: pass
- release URL: `https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/releases/tag/v3.2.2`
- release asset: `cyb3rb1ade-plur1bus-memory-3.2.2.tgz`
- asset URL: `https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/releases/download/v3.2.2/cyb3rb1ade-plur1bus-memory-3.2.2.tgz`
- asset size: `50796`

## Known Caveats

- Provider-backed memory tool runtime smokes need a real OpenAI/OpenAI-compatible
  key, a local E5 smoke, or a deterministic mock provider. Without one, those
  smokes remain `blocked`, not OpenClaw breakings.
- Local E5 remains experimental until a real local model load/embed smoke is
  green.
- Local GTE reranker remains experimental/blocked until a real local reranker
  smoke is green.
