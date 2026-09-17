# Hermes 7.12.61 candidate verification

Candidate: `7.12.61-hermes.0` (Python `7.12.61`).
Official upstream: `039329d0c74525448190b0bd2ec3ef3551ed168f`.
Final tested source head: `c5e3d67a647e63fc1f61160bc27ec3c1333a821f`.
Source tree: `01c38c091d2d2099852a7643fca4b54d4002d58c`.
Any later evidence-only commit does not relabel the built artifacts.

[Hermes-only PR #161](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/pull/161)
was merged after all five checks passed, as
`05a2b3d145a08adb009bf3717675e9dd82398ac1`, into the existing Hermes integration
branch `codex/hermes-port-7.12.60` (legacy branch name, now .61 source).
OpenClaw main was not modified by this integration.

## Local gates

- Node 22.23.2: 4,763 tests, 4,687 passed, 76 conditional skips, zero failed;
  849 suites, 86.22% statement/line coverage. Executed on `1ec861ac`; the
  sole subsequent source change is the Python inventory-test correction
  below, with all JavaScript runtime, tests, manifests and lockfiles unchanged.
- Full final native suite: 1,060 passed, 377 subtests passed, two Windows-API
  skips, zero failures. Provider coverage 81% (13,673 statements).
- Both desktop and distributed web UI harnesses passed, including active
  profile scoping, unknown versus measured-zero counts and retained Workshop.
- Hermes host integration: 30 passed using host source with isolated QA
  dependencies; this is not a productive plugin installation.
- Sidecar: nine Python tests passed. Four installer/home-discovery shell suites
  passed. An initial helper collection used the wrong PYTHONPATH; corrected to
  `mtplx-embed/src`, after which all nine passed without source changes.
- Syntax lint, changed Python AST parsing and diff whitespace checks passed.
  No standalone TypeScript/type-check gate applies to the changed plain-JS
  code and Python test/metadata edits; no new type-checker claim is made.
- Full npm audit: zero vulnerabilities. QA pip dependency check passed.
- Changed native test/audit secret-pattern scan: no matching secret patterns;
  this is not an exhaustive security audit.
- npm pack dry run: 633 files, retained native payloads, no prohibited generated
  paths. Both Python wheels contain 7.12.61 metadata and plugin manifests,
  no pycache/pyc (provider: 82 members; controls: 16).
- Clean final portable bundle: source `c5e3d67a`, dirty=false; all 110 payload
  hashes and outer checksums verified. Real wheel installation, LanceDB
  capture/recall with stub embeddings, scoped retrieval-setting activation
  and file rollback passed in a disposable home. No model inference or
  model download is implied.

The initial exploratory package was built while coverage output was untracked
and honestly recorded dirty=true. It is superseded by the clean final bundle
under `distribution-artifacts/7.12.61-hermes.0-verified`, not a release artifact.

## Cross-platform matrix and test correction

The first matrix exposed a defect in the new preservation test, not in the
plugin: comparing raw checkout bytes to Git blobs rejected Windows CRLF.
Commit `c5e3d67a` instead compares canonical Git blob hashes using the checkout
clean filters; binary equality is retained. A separate check accepts CRLF but
rejects an actual runtime mutation. The superseded run was cancelled and the
complete matrix restarted.

[Final native matrix](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/actions/runs/35276101962)
uses GitHub PR merge commit `0d70d87d46b5f89bd8350eae60f42296a3bed615`, whose
tree was checked to equal the source tree above exactly. Do not confuse this
synthetic merge SHA with the local source-head SHA.

| Target | Passed | Subtests | Skips | Build/install/rollback |
| --- | ---: | ---: | ---: | --- |
| macOS ARM64 | 1,060 | 377 | 2 | PASS |
| Linux ARM64 | 1,060 | 377 | 2 | PASS |
| Linux x64 | 1,060 | 377 | 2 | PASS, including fresh CPU-only Torch install |
| Windows ARM64 | 1,053 | 371 | 9 | PASS, EXE smoke and reviewed native storage wheels |
| Windows x64 | 1,053 | 371 | 9 | PASS, EXE smoke |

All five completed artifact sets were downloaded; their source receipts, clean
state, outer SHA256SUMS and every ZIP payload hash were independently verified.
The complete matrix finished successfully with zero failures.

## Scope and publication boundary

No productive Hermes profile, provider, model or memory store was modified.
The candidate is not publicly released, tagged or npm-published. macOS PKG and
Windows EXEs from this CI are explicitly unsigned test candidates (macOS
signature status independently checked); no notarization claim is made.
Fresh native tests and installer smoke do not imply visual Desktop testing
on every OS or real-model inference. Intel macOS is not a release target.
Evidence from earlier versions must not be reused as .61 certification.
CI artifacts expire after 14 days.
