# Hermes 7.12.47 supplemental upstream delta review

Candidate source is the normal merge commit
`5bd9f0004307de03e1e3670d76bfe1a18ae09676`, whose second parent is the exact
upstream pin `8a148c991123be31bc4f99376c8198447d9bb717` (`v7.12.47`). The active
candidate identifiers are `7.12.47-hermes.0` for JavaScript/dashboard manifests
and `7.12.47` for both Python distributions. This is source-inclusion and
inventory evidence only: it is not native parity, package, signing, guest-runtime,
publication, or production evidence.

The historical 7.12.44 inventory remains pinned to
`a3f48f28ac647e81c5260e8a1dbab7977bf9fb51`; its audit data and validator were
not rewritten. This review is additive and covers the linear upstream delta from
`c59366f637db5b636c2d822351018b88476f37fb` through the new pin.

## Exact 14-path upstream inventory

`git diff --name-only c59366f637db5b636c2d822351018b88476f37fb
8a148c991123be31bc4f99376c8198447d9bb717` yields exactly:

1. `CHANGELOG.md`
2. `index.js`
3. `lib/db-adapter.js`
4. `lib/jobs/daily-consolidation.js`
5. `lib/jobs/memory-dynamics-maintenance.js`
6. `lib/lancedb-optimize.js`
7. `openclaw.plugin.json`
8. `package-lock.json`
9. `package.json`
10. `tests/daily-consolidation-decay-cursor.test.js`
11. `tests/db-adapter-timeouts.test.js`
12. `tests/decay-batch.test.js`
13. `tests/lancedb-optimize.test.js`
14. `tests/release-750-compat.test.js`

## Three release contracts and native status

| Contract | Upstream source/functions | Native candidate path | Status at integration |
| --- | --- | --- | --- |
| Scope-key-correct partition guards and sparse ACL reads | `index.js`: `sameOwnerPartition`, `createOwnerBoundMemoryStore`, `createPartitionScopedDb`, and its `readAclRows` projection; `lib/jobs/memory-dynamics-maintenance.js`: `normalizeDecayPartition`, `decayPartitionWhere`, `rowInDecayPartition` | `plur1bus-hermes/src/plur1bus_hermes/namespaces.py`: `ScopeBinding`, `scope_where_clause`; `plur1bus-hermes/src/plur1bus_hermes/runtime.py`: `_card_matches_scope` and mutation paths | **Pending native delta verification/implementation.** Hermes has its own opaque `scopeKey`/`ownerKey` layout, so OpenClaw field comparisons cannot be copied literally. Existing scoped predicates do not by themselves prove sparse, pre-mutation ACL reads for every native bulk writer. |
| Bounded resumable decay, durable partition-owned progress, and batch efficiency without duplicate decay after partial failure | `lib/jobs/daily-consolidation.js`: `readDynamicsDecayCursor`, `recordDynamicsDecayCursor`, `runConsolidationBody`; `lib/jobs/memory-dynamics-maintenance.js`: `applyDailyDecayToAll`, `buildBatchDecaySql`, `applyDailyDecayBatch` | `plur1bus-hermes/src/plur1bus_hermes/domain.py`: `run_dynamics`, `run_consolidation`; `plur1bus-hermes/src/plur1bus_hermes/jobs.py`: `run_jobs` | **Pending native-safe implementation; not verified parity.** Native `run_dynamics` currently reads a full metadata table and recreates it with `mode="overwrite"`; it has no equivalent durable decay cursor, bounded batch contract, or concurrent-capture-safe per-row update path. Upstream's batch path deliberately performs strength and timestamp as two statements, then falls back to row decay on an exception. A failure after the first statement can therefore expose already-decayed strengths to the fallback. The included happy-path LanceDB test does not close that partial-failure/idempotence risk, and this two-statement/fallback sequence must not be copied into Hermes without a native-safe recovery design. |
| Bounded optimize conflict retries with truthful attempts/deadline reporting | `lib/db-adapter.js`: `optimizeTable`; `lib/lancedb-optimize.js`: `summarizeLancedbOptimize` | `plur1bus-hermes/src/plur1bus_hermes/operator_status.py`: `optimize_runtime_table`; `plur1bus-hermes/src/plur1bus_hermes/jobs.py`: `run_jobs` | **Pending native maintenance task.** The current manual native function makes one synchronous `optimize()` call, reports no attempts/deadline, and daily jobs do not schedule a distinct physical optimization result. Retry, writer exclusion, retention truthfulness, and measured budget semantics require the separate native maintenance plan. |

## Evidence boundary

The merged JavaScript tests exercise the upstream implementations, including a
real LanceDB batch-decay happy path, row-cursor progression, partition behavior,
and retry attempt counts. They establish that the source delta still works in
the merged JavaScript tree. They do not establish that Hermes reaches those
functions, nor that its Python storage layout satisfies the same contracts.
Native maintenance and the previously recorded 7.12.44 gap ledger remain
separate work.
