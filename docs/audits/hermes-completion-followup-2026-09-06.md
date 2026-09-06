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

Follow-up: native Windows CI exposed non-portable diary date formatting and
newline translation of opaque retry evidence. Both are fixed, portable code-index
paths are normalized, and test runtimes/caches now close before temporary-directory
cleanup. POSIX-only FIFO/directory-fsync tests are explicitly platform-scoped,
not used to claim equivalent Windows POSIX semantics. Independent contradiction
disclosure now binds both cards to the current gated recall and has its own toggle
and 400-character bound; this is not full graph-policy parity.

The separate native Intel LanceDB workflow builds pinned upstream 0.34.0. Its
first run found stale workspace-version metadata in upstream Cargo.lock; only
that version is corrected, without resolving new third-party versions. Intel
wheel and runtime acceptance remain pending, not certified by the workflow's
existence. The user's requested upstream contribution targets an opt-in native
build, respecting LanceDB's intentional retirement of the default Intel matrix.

Full macOS Python suite: 624 passed plus 55 subtests, no failures. Native desktop
routing/action harness passed with Node's experimental VM-module flag. These are
source/regression results, not visual installed-app acceptance or real-model
quality benchmarking. Linux and exact-artifact evidence are recorded separately
after the final source commit. Newly added tests use temporary data only.

## Native distribution evidence added later in this session

Source `38b50265c90dd2d19d97056895bb73e99ea83020` passed real package and
temporary-install/rollback CI on Linux x64, Linux ARM64, Apple Silicon and Windows
x64, including the Windows executable smoke. Downloaded artifact checksums and
embedded verification source IDs were checked locally. Run:
https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/actions/runs/34049104695 .
Its overall red status is the unresolved Intel dependency job, not hidden failures
on those four successful platforms. macOS local Python regression count at that
checkpoint was 627 plus 55 subtests. These are unsigned candidate artifacts.

The subsequent optional Intel-wheel bundler/installer changes add explicit
approved-hash and wheel-metadata validation, target-interpreter architecture
selection, and same-version native-wheel replacement. They are a new source
checkpoint and do not inherit an exact-artifact certificate from the prior CI run.
Upstream contribution: https://github.com/lancedb/lancedb/pull/4140 (draft pending
native build/runtime evidence). Intel ML dependencies are a separate open gate;
PyTorch must not be silently downgraded to bypass it.

## Still not claimed

Native-storage follow-up (2026-09-07): Windows ARM CI run `34060568686`
passed pinned Arrow 25.0.1 and LanceDB 0.34.0 builds plus fresh installed-wheel
validation. The same checksum-verified wheels then passed in the user's native
Parallels ARM64 guest: 19 PE binaries, insert/additive schema/filtered ANN/reopen,
Parquet and compute. Native Hermes dependencies separately passed CLI, AES-GCM
and ConPTY `read(4096)` tests in a staged ARM64 venv; the default upstream x64
venv was not replaced. Neither result is full PLUR1BUS model/UI acceptance.

The portable builder now accepts the reviewed ARM wheel **pair** with individual
approved hashes, exact wheel metadata and PE architecture checks. Read-only
installation planning selects them only for standard-ABI native CPython 3.13
on Windows ARM64. Existing Intel selection remains compatible. Distribution
regressions: 59 passed on macOS; 56 passed and 3 symlink-privilege fixtures skipped
in the actual Windows ARM guest. Both real ARM wheel artifacts pass the new
builder checks. NumPy/PyTorch-independent native ML provisioning, BGE ONNX,
complete native application packaging and the remaining gates below are still open.

Real fresh-Hermes preflight found two further installer issues: uv-created venvs
omit pip, and Windows' default CP1252 pipe encoding rejects Unicode config text.
Read-only preview now fingerprints installed distributions via Python metadata;
only confirmed apply may run bundled ensurepip, with a journal/log. Python pipes
use explicit UTF-8 on both ends. A real plan against the user's staged ARM Hermes
venv and unmodified config passed, selecting both ARM wheels and reporting pip
bootstrap required without creating any install receipt/backup. Regression suite:
87 passed on macOS; 83 passed and 4 symlink-privilege skips in the ARM guest.
Windows ARM uses native NumPy 2.3.0; Intel macOS and Windows ARM no longer pull
PyTorch implicitly. Transformer extras/config remain available, not removed or
silently downgraded; native ONNX use requires its explicit supported model config.

The full upstream automatic semantic-compaction/rewrite policy, complete
graph/entity/cognition selector/configuration parity, arbitrary vault discovery
and mirror conflict resolution, cold-start proactive route ownership and general
automatic reaction/outcome hooks are not made complete by these changes.
Snapshot relocation across machines is not supported; explicit external includes
are required. Native Windows/WSL/other-architecture, signing, interactive installer,
productive installed-runtime and publication gates remain separate.

Do not remove the parity gate or label the port complete solely because the
implemented native variants and regression suites pass.
