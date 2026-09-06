# Hermes completion follow-up — 2026-09-06

This records implemented source changes, not a full-parity/publication certificate.
Candidate versions remain 7.12.0-hermes.2 / 7.12.0.post2. No productive profile,
model, memory database or gateway was changed by these regression tests.

## Implemented

- Offline end-user snapshot export, verification and original-path restore:
  explicitly selected data/config/artifact trees, private files, complete
  checksums, retained originals, external interrupted-restore guards and
  resumable staged replacement. See [snapshot instructions](../hermes-snapshot-restore.md).
- Additive recall has at most a 50-ms caller wait and one worker/no queued
  backlog. Slow work is not injected later and cannot mutate primary results.
  Native I/O is not forcibly killed; generation leases remain held until it
  finishes, including primary prefetch that outlives runtime shutdown.
- Persistent embedding/LLM caches prune expired and least-recently-used entries
  toward 90% of their byte admission budget. WAL bytes count; checkpoints do not
  wait on another reader. New caches enable incremental vacuum before schema
  creation. Old non-vacuum databases are not implicitly rebuilt. See SQLite's
  [vacuum/checkpoint semantics](https://www.sqlite.org/pragma.html).
  Corrupt persisted vectors bypass cache and are repaired by valid live results.
  The upstream deterministic LLM purpose allowlist is included; native emotion,
  episode and workshop consumers are wired. Main chat, critical classification,
  dream narrative, LightDream and reflective observation calls remain uncached.
- Opt-in automatic **lossless** store-time merge: `merging.enabled: true` plus
  `merging.autoApply: true`. Private user captures only, no explicit importance
  or TTL, bounded high-similarity candidates, structured LLM compatibility
  decision, disjoint-time rejection, no LLM-written replacement facts. Both
  original texts survive in the replacement. Exact durable input identity,
  lineage, materialization checks and final source revalidation make retries
  idempotent; uncertain writes require repair rather than a second plain insert.
  Feature profiles still do not enable automatic application implicitly.
- Scoped Obsidian note review/import through CLI, Controls, native desktop and
  web dashboard. No browser-selected path or agent. Exact revision plus
  host-session/profile/route-bound single-use approval; stable chunk IDs and
  synchronous verified acknowledgement prevent false completion after failures.
  Changed notes append observations; they do not silently overwrite old facts.
  Scans exclude links, hidden/generated trees and use file/entry/byte budgets.
  `obsidianBridge.enabled: true` + `watch: true` adds hourly pending-change
  reviews to the reviewed maintenance schedule; watching never grants import
  consent. Control-room files now preserve/report manual or foreign content.
- Named-namespace generation activation/recovery, separate certified pointers
  per agent/namespace, repeated migrations, retained sources and metadata checks.
  Migrate an isolated named writer, then combine only namespaces with matching
  certified embedding fingerprints. A single encoder must not compare different
  vector spaces even when their dimension counts match. Installer migration
  supports the same isolated named-writer path. Non-cooperating processes must
  still actually be stopped, not bypassed with an assertion flag.

## Acceptance at this source checkpoint

Full macOS Python suite: 624 passed plus 55 subtests, no failures. Native desktop
routing/action harness passed with Node's experimental VM-module flag. These are
source/regression results, not visual installed-app acceptance or real-model
quality benchmarking. Linux and exact-artifact evidence are recorded separately
after the final source commit. Newly added tests use temporary data only.

## Still not claimed

The full upstream automatic semantic-compaction/rewrite policy, complete
graph/entity/cognition selector/configuration parity, arbitrary vault discovery
and mirror conflict resolution, cold-start proactive route ownership and general
automatic reaction/outcome hooks are not made complete by these changes.
Snapshot relocation across machines is not supported; explicit external includes
are required. Native Windows/WSL/other-architecture, signing, interactive installer,
productive installed-runtime and publication gates remain separate.

Do not remove the parity gate or label the port complete solely because the
implemented native variants and regression suites pass.
