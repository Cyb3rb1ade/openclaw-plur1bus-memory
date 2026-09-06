# Distribution candidate acceptance — 2026-09-06

Candidate: **7.12.0-hermes.2 / 7.12.0.post2**. This is not a publication record.

## Model/migration addition

The installer now exposes explicit target-model planning, preparation/probes,
backed-up staged re-embedding, full metadata validation and separate activation.
Reranker-only changes and empty-store initialization do not re-embed memories.
Named profiles create their own override even if none existed before.

New tests exercise real LanceDB migrations with stub embedding vectors, reject
missing backups, changed metadata, stale approvals and active runtime leases,
and preserve the original database. Actual installed-wheel QA also invokes the
installer's reranker plan/activation path in a temporary home on macOS and Linux.
These tests do not constitute a real-model quality benchmark or a productive
data migration. No target model/profile was inferred for the user's live Hermes.
Legacy OpenClaw imports remain an explicit separate CLI workflow.

Updated execution logs: `python-model-migration-final.log` and
`linux-model-migration.log` in the external QA directory below. Native Windows
execution/signing and publication gates remain open as listed below.

## Initial distribution evidence

Implemented: one shared installer, manifest verification, explicit profile/home/
venv selection, optional activation, dependency-conflict gate, forced same-version
wheel refresh, per-file backup journals, guarded rollback, portable launchers,
macOS assistant package and Windows one-file build recipe. Optional host build
remains separate. No production memory, model, profile or installed Hermes binary
was changed during distribution QA.

Local evidence:

- macOS ARM64 / Python 3.11: 530 Python tests + 55 subtests passed, including
  provider, Controls, dashboard/host-helper and installer suites.
- Linux ARM64 / Python 3.12 container: first candidate 503 tests + 55 subtests
  passed, then real wheel installation, LanceDB capture/recall and file rollback.
  Newer source/final-artifact rechecks are recorded in the external QA logs.
- Node: 4,287 tests, 4,211 passed, 0 failed, 76 conditional skips; lint passed.
- Portable ZIP/Tar and unsigned macOS PKG built. Expanded PKG payload: all 90
  manifest file checksums matched, no privileged postinstall scripts. pkgbuild
  printed four `write: Permission denied` messages despite exit 0; payload
  inspection passed, but this is not a macOS Installer.app/Gatekeeper acceptance.
- Actual installation and rollback use temporary test homes/venvs. Embeddings
  are stubbed for the LanceDB smoke, while native Python dependency imports are
  real. No model download, quality benchmark or live production conversation
  is represented by this test.

Not yet certified:

- Native Windows x64 executable build, process-lock behavior and full runtime
  suite; Windows ARM64 is outside the initial matrix.
- macOS Intel, Linux x64 and actual WSL2 host behavior; matrix definitions are
  not successful executions.
- Installer.app interactive flow, Windows interactive console wizard,
  Authenticode, Apple Developer signing/notarization and public release assets.
- Native scheduler execution on Windows/Linux/WSL. The helper now generates
  per-user launchd/systemd/Task Scheduler definitions and explicitly loads them;
  unit tests exercise identity isolation, argument escaping, no-clobber writes,
  unavailable-manager refusal and OS-owned maintenance locks. No productive
  scheduler was registered during this work. Definitions are not native QA.
- Windows uses inherited private-home ACLs, not POSIX mode guarantees. Windows
  file flush/write-through is not claimed to be identical to directory fsync
  under power failure or on network shares.

Release gate: run `.github/workflows/hermes-distribution.yml` against the exact
reviewed commit, inspect all five OS/architecture results and artifacts, complete
the intended signing/interactive acceptance, then make an explicit publication
decision. Do not overwrite `.1` assets or move stable/latest channels.

Local logs/artifacts are outside the source tree in
`/Users/cyberblade/Documents/GitHub/plur1bus-distribution-qa-20260906/`.
