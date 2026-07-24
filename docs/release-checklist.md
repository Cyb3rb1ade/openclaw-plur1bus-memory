# Release Checklist — PLUR1BUS 7.1.0

> Release title: **PLUR1BUS 7.1.0 - Not just an agent. Yours.**
> Status: **Release candidate**
> Target date: 2026-07-24
> Source baseline: `origin/main` at `f1ec54c` plus release-only metadata and documentation

---

## Scope

- [x] Complete B1–B15 high/medium audit remediation from merged PRs #85 and #86
- [x] B12 Core and B12-P recall/namespace closure
- [x] B13 ownership, ACL, sharing, and legacy-migration closure
- [x] Patched `brace-expansion`/`protobufjs` dependency updates
- [x] `sharp@0.35.3`
- [x] Node.js `>=22.5.0`
- [x] Exact LLM result cache and OpenClaw-default LLM routing
- [x] No new runtime feature or schema migration in the release-preparation commits

## Pre-Release

- [x] Version synchronized: `package.json`, root `package-lock.json`, and `openclaw.plugin.json` = `7.1.0`
- [x] Stable identities preserved: npm package, plugin ID, plugin display name
- [x] Nested emotional-state-injector remains `1.0.0`
- [x] README updated with 7.1.0 highlights and installation sources
- [x] CHANGELOG finalized from `v7.0.0..main`
- [x] Known issues updated; pre-existing reranker scoring issue remains separate
- [x] Git tag, GitHub Release, GitHub Packages version, and ClawHub version `7.1.0` confirmed unused
- [x] GitHub Release/Packages and ClawHub authentication confirmed

## Local Validation

- [x] Clean baseline before release edits: 3,260 tests; 3,259 passed; 0 failed; 1 skipped
- [x] Clean baseline `npm ci --ignore-scripts`: passed
- [x] Clean baseline dependency audit: 0 vulnerabilities
- [ ] Release candidate `npm ci --ignore-scripts`
- [ ] Release candidate `npm audit`
- [ ] Release candidate `npm run lint`
- [ ] Release candidate full serial test suite
- [ ] Release candidate `git diff --check`
- [ ] `npm pack --dry-run --json` content and size review
- [ ] Canonical `.tgz` plus SHA-256 generated
- [ ] Existing installer/updater regressions pass
- [ ] Fresh disposable OpenClaw install from local canonical `.tgz`

## PR and Immutable Source

- [ ] Release branch pushed
- [ ] Release PR opened and every required GitHub check green
- [ ] Release PR merged into `main`
- [ ] Exact merged `main` commit reverified
- [ ] Annotated tag `v7.1.0` created on the verified merge commit and pushed

## GitHub Packages

- [ ] `@cyb3rb1ade/plur1bus-memory@7.1.0` published to `https://npm.pkg.github.com`
- [ ] Published metadata resolves to `7.1.0`
- [ ] Downloaded GitHub Packages artifact verified
- [ ] Fresh disposable OpenClaw install from the GitHub Packages artifact

## GitHub Release

- [ ] Published title is exactly `PLUR1BUS 7.1.0 - Not just an agent. Yours.`
- [ ] Release is non-draft and non-prerelease
- [ ] Canonical `.tgz` and SHA-256 assets attached
- [ ] Downloaded checksum passes
- [ ] Fresh disposable OpenClaw install from the GitHub Release asset

## ClawHub

- [ ] Dry-run from immutable GitHub tag passes
- [ ] `@cyb3rb1ade/plur1bus-memory@7.1.0` published
- [ ] Source repository, tag, and commit linkage verified
- [ ] Artifact digest verified
- [ ] ClawHub scan/moderation state recorded
- [ ] Fresh disposable OpenClaw install of exact ClawHub `7.1.0`

## Compatibility and Rollback

- No manual LanceDB migration is required for an ordinary upgrade.
- Node.js 20 and Node.js 22.0–22.4 must be upgraded before installation.
- Published tags and package versions are immutable and are never overwritten.
- Rollback source: immutable GitHub/ClawHub release `v7.0.0`.
- The pre-existing reranker scoring-quality bug remains a separate follow-up.

## Previous Release

PLUR1BUS v7.0.0 was released on 2026-07-16 at commit `3607b32`, with GitHub
tag `v7.0.0` and ClawHub package
`@cyb3rb1ade/plur1bus-memory@7.0.0`.
