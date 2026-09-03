> **Überholt seit 7.5.0.** Der Boden liegt jetzt bei Node 22.22.3, der
> Untergrenze von OpenClaw 2026.8.2.
> `node:sqlite` ist erst ab 22.12 ohne `--experimental-sqlite` nutzbar,
> und die Auto-Capture-Tests scheitern auf 22.5 bis 22.11 an der
> Semantik des damaligen Testläufers (gemessen am 03.09.2026).
> Dieses Dokument beschreibt den historischen Stand.

# Node.js 22.5 Runtime Floor Design

**Date:** 2026-07-23

## Goal

Declare Node.js 22.5.0 as the minimum supported PLUR1BUS runtime so that
the optional local Transformers pipelines and the persistent built-in SQLite
embedding cache are available within the supported runtime range.

## Scope

- Set `engines.node` to `>=22.5.0` in `package.json` and synchronize the root
  package metadata in `package-lock.json`.
- Test both the exact minimum version, Node.js 22.5.0, and the current Node.js
  22 release in CI.
- Document Node.js 22.5 or newer as an installation prerequisite in `README.md`.
- Update the existing SQLite cache note to state that persistence is available
  throughout the supported runtime range.

## Non-goals

- Do not add a custom runtime version gate.
- Do not add `engine-strict` or otherwise override package-manager policy.
- Do not change dependencies, PLUR1BUS feature behavior, storage formats, or
  configuration defaults.
- Do not modify archived audit evidence or historical design documents.

## Compatibility

Existing installations on Node.js 20 or Node.js 22.0–22.4 must upgrade Node.js
before installing this PLUR1BUS version. The standard npm `engines` contract
communicates this requirement. CI prevents regressions at both the exact
minimum version and the maintained Node.js 22 line.

## Verification

Run:

1. `npm ci --ignore-scripts`
2. `npm audit`
3. `npm run lint`
4. `node --test --test-concurrency=1 tests/*.test.js test/*.test.js`
5. `git diff --check`

After pushing, require the pull request's dependency review, lint, Node.js
22.5.0 test, and current Node.js 22 test jobs to pass.
