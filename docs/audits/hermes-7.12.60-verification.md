# Hermes 7.12.60 candidate verification

Candidate `7.12.60-hermes.0`, upstream `bcb80ccef6ce5ab9e4604cfe923901885cc59d9e`.
Verification is in progress. This document is not a release or installation receipt.

Completed initial gates:

- New native focused regressions: 23 passed, 11 subtests.
- Desktop routing/lifecycle/scoped-action harness: passed.
- Distributed web UI rendering harness: passed (active profile, no foreign rows, zero versus unknown, retained Workshop).
- Full JS suite: 4,744 tests, 4,668 passed, 76 skipped, zero failed; 847 suites.
- Syntax lint and diff whitespace checks: passed.
- npm audit: 4 affected optional JS dependency entries (2 moderate, 2 high), tracked in upstream #150. With optional dependencies omitted: zero.

Final Python/host integration, package verification and platform results will
be recorded after completion. No productive Hermes profile has been changed.
