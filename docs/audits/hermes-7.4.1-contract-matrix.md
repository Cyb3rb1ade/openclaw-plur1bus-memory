# Hermes 7.4.1 — Incremental contract matrix `v7.4.0..v7.4.1`

Porting window: `v7.4.0..v7.4.1` (two commits, peeled tag commit
`1fe03695632e1efc6357f21157037184257b8956`). The complete 7.4.0 baseline is
documented in `docs/audits/hermes-7.4.0-contract-matrix.md`.

Legend: **JS** = included directly in the shipped OpenClaw package · **PY** =
reachable Python port required and implemented · **NR** = demonstrably not
reachable in Hermes, documented without a compatibility shim.

| Upstream commit | Files | Contract | OpenClaw path | Reachable Hermes path | Status | Regression test |
|---|---|---|---|---|---|---|
| `fff59e9` (merged by `1fe0369`) | `index.js`, `lib/neo-arch.js`, `tests/neo-embedding-drain-budget.test.js` | Run Neo embedding maintenance after capture with the remaining hook budget; honor abort/deadline boundaries; persist progress and report `stoppedEarly` | OpenClaw `agent_end` capture scheduler and Neo `embedding-queue.jsonl` drain | None: Hermes lifecycle uses Python `MemoryProvider` hooks and has no Neo JavaScript queue or drain worker | JS + NR | `tests/neo-embedding-drain-budget.test.js` |
| `fff59e9` | `openclaw.plugin.json` | Ship the contemporaneous OpenClaw schema with the fix | OpenClaw manifest validation | Hermes reads only its provider/plugin manifests; the merged schema remains available to OpenClaw consumers of the Hermes npm channel | JS + NR | schema and package gates |

## Reachability evidence

- `plur1bus-hermes/` and `plur1bus-controls/` contain no embedding queue, drain
  worker, or `agent_end` hook implementation.
- The Hermes runtime captures and recalls directly through its Python provider;
  adding a queue API solely for name parity would create an unreachable shim.
- The shared JavaScript package contains the exact upstream runtime change, so
  OpenClaw consumers of `7.4.1-hermes` receive the fix.

## Preserved boundaries

- No Hermes LanceDB migration or productive data path is introduced.
- Provider, endpoint, and model selection remain operator-owned.
- Jina remains optional and license-gated; local E5/BGE remains the fallback.
- Controls, retrieval, installer discovery, and launch scheduling are unchanged.
- Publication uses the separate `hermes` channel and must not move npm
  `latest`.
