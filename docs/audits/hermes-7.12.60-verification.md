# Hermes 7.12.60 candidate verification

Candidate `7.12.60-hermes.0`, upstream `bcb80ccef6ce5ab9e4604cfe923901885cc59d9e`.
Tested source/package commit: `2aa945f7990bba5f5f84a1db60ddc56799344fc3`.
Any subsequent receipt-only commit does not change or relabel these artifacts.
This document is not a public release or productive installation receipt.

## Local measured gates (macOS ARM, Python 3.12.14, Node 26.8.2)

- New native focused regressions: 23 passed, 11 subtests.
- Desktop routing/lifecycle/scoped-action harness: passed.
- Distributed web UI rendering harness: passed (active profile, no foreign rows, zero versus unknown, retained Workshop).
- Full JS suite: 4,744 tests, 4,668 passed, 76 skipped, zero failed; 847 suites.
- Syntax lint and diff whitespace checks: passed.
- npm audit: 4 affected optional JS dependency entries (2 moderate, 2 high), tracked in upstream #150. With optional dependencies omitted: zero.
- Full committed Python candidate: **1,044 passed, 230 subtests passed, 2 skipped**, no failures; provider statement coverage **81%** (13,575 statements). Skips require real Windows security APIs. Existing LanceDB deprecation warnings remain.
- Hermes host API/installer integration: **30 passed**, using the local host source on PYTHONPATH with isolated QA dependencies, not a productive plugin install.
- mtplx helper: **9 passed**. Four shell suites passed (home discovery, plugin installer, sidecar installer, no-model-provider path).
- Python dependency check: no broken requirements. No TypeScript compiler gate applies to the changed plain-JavaScript runtime.
- Actual bundle install into disposable home: wheel imports, native dependency imports, real LanceDB capture/recall with stub embeddings, reviewed retrieval setting change and file rollback all passed. No model downloads or live inference are claimed by this smoke.
- Both wheels built and inspected: 7.12.60 metadata, plugin manifests present, no pycache/pyc. Provider wheel: 82 members; Controls wheel: 16.
- npm pack inspected: 624 files, all native payload directories present, no prohibited generated/private paths in inventory. npm is the separate OpenClaw distribution, not the Hermes installer.
- Secret-pattern check over changed native/UI source: no matching key patterns. This is not an exhaustive security audit.

The first full Python run exposed two stale version/inventory expectations;
these were aligned without dropping source parity checks. An intermediate
coverage run started before the merge commit recorded a missing-ancestor failure;
the final committed run above supersedes it. Initial dashboard QA lacked
host-only python-multipart/psutil dependencies; they were installed into the
temporary QA environment only. Native regression tests were written and failed
before the corresponding implementation, then passed.

## Cross-platform and artifact boundary

[Native build/install matrix](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/actions/runs/35257658387)
targets the exact source commit above and finished **successfully on all five targets**.

| Native runner | Python tests | Subtests | Skips | Package/install/rollback |
| --- | ---: | ---: | ---: | --- |
| macOS ARM64 | 1,044 passed | 230 passed | 2 | PASS, PKG + portable archives |
| Windows x64 | 1,037 passed | 224 passed | 9 | PASS, EXE smoke + portable archives |
| Windows ARM64 | 1,037 passed | 224 passed | 9 | PASS, EXE smoke + reviewed ARM storage wheels |
| Linux x64 | 1,044 passed | 230 passed | 2 | PASS, also fresh CPU-only Torch installation |
| Linux ARM64 | 1,044 passed | 230 passed | 2 | PASS, portable archives |

Platform-specific skips are retained (Windows excludes POSIX filesystem tests;
POSIX excludes Windows security API tests). Zero failures. All five artifact
sets were downloaded; source receipts, outer SHA256SUMS and every ZIP payload
hash were verified locally. CI artifacts are retained for 14 days, not a
permanent public release channel. Native backend/installer smoke is not a
claim of visually exercising a full Hermes Desktop app on every runner.
Local artifacts are in `distribution-artifacts/`; the macOS candidate PKG is
explicitly unsigned (`pkgutil --check-signature`: no signature). Native CI
packages are likewise test candidates, not signed/notarized public releases.

Standalone local wheel SHA-256:

```text
8610a9c92a17b1e79f6c2d36ce668fce3bb1bb08043e69335a3370c7640b61a7  plur1bus_hermes-7.12.60-py3-none-any.whl
cd39de79fdfdffff0a22bcf125be0762d1c50d50c804121232111e3e1cd1c872  plur1bus_controls-7.12.60-py3-none-any.whl
9e472ff5162ec6cbb64a6918d730cbbce0397c70beb139e021d848790b7dcec0  cyb3rb1ade-plur1bus-memory-7.12.60-hermes.0.tgz
```

No productive profiles, databases, provider/model selection, public tags,
release assets or package dist-tags were modified. No Intel-Mac edition.

## Optional performance proposal, measured separately

Synthetic centroid-only microbenchmark: 500 vectors, 128 dimensions, five
repetitions, medians 274.624 ms for recomputing all member sums versus 2.609 ms
for incrementally maintained sums (about 105x for this isolated operation).
Maximum coordinate difference was 1.943e-15 due to floating-point accumulation.
This is **not** end-to-end speedup or token reduction. Cluster-boundary behavior
and real workload timing must be checked before adopting it. Runtime unchanged;
the user decides whether to implement this and the other documented proposals.

The broader source inventory and intentional native/OpenClaw differences are
in `hermes-7.12.60-delta-review.md`.
