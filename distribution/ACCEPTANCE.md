# Distribution candidate acceptance — 2026-09-06

Candidate: **7.12.0-hermes.2 / 7.12.0.post2**. This is not a publication record.

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
- Automatic maintenance scheduler setup on Windows/Linux; the existing helper
  targets macOS launchd. The jobs CLI is included, services are not auto-created.
- Windows uses inherited private-home ACLs, not POSIX mode guarantees. Windows
  file flush/write-through is not claimed to be identical to directory fsync
  under power failure or on network shares.

Release gate: run `.github/workflows/hermes-distribution.yml` against the exact
reviewed commit, inspect all five OS/architecture results and artifacts, complete
the intended signing/interactive acceptance, then make an explicit publication
decision. Do not overwrite `.1` assets or move stable/latest channels.

Local logs/artifacts are outside the source tree in
`/Users/cyberblade/Documents/GitHub/plur1bus-distribution-qa-20260906/`.
