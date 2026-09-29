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
- [x] Node.js `>=22.22.3`
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
- [x] Release candidate `npm ci --ignore-scripts`: passed
- [x] Release candidate `npm audit`: 0 vulnerabilities
- [x] Release candidate `npm run lint`: passed
- [x] Release candidate full serial test suite: 3,259 passed; 0 failed; 1 skipped
- [x] Release candidate `git diff --check`: passed
- [x] `npm pack --dry-run --json` content and size review: 274 files; 892.8 kB packed
- [x] Canonical `.tgz` plus SHA-256 generated
- [x] Existing installer/updater regressions pass: 4 passed; 0 failed
- [x] Fresh disposable OpenClaw install from local canonical `.tgz`: plugin enabled; doctor 0 plugin errors

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

## Distribution (HM1)

Per release, in order. Details of the installer, the feed and its signature:
[`distribution.md`](distribution.md). Nothing here is done by CI on its own:
the feed is signed offline by the owner and published by hand.

- [ ] Dry run of `plugin-release.yml` (dry-run mode): builds the tarball, the installer bundle (`dist-installer/plur1bus-plugin-installer.mjs`), both rendered bootstraps and the **unsigned** `plugin-<channel>.json`; review the job summary (versions, SHA-256, sizes)
- [ ] Real run of `plugin-release.yml`: GitHub Release with the tarball, installer bundle, `install-plugin.sh`, `install-plugin.ps1`, the unsigned feed; attestations; npm publish with provenance if the package is published to npmjs.org
- [ ] `plugin-dist.yml` green on the release commit (five targets, min and latest OpenClaw, upgrade and forced-rollback legs)
- [ ] ClawHub manual publish of `@cyb3rb1ade/plur1bus-memory@<version>` (section "ClawHub" above), **before signing**. If ClawHub's ClawPack digest differs from the tarball's integrity, take it from a test install's record (`clawpackSha256`) and rebuild the feed with `--clawpack-digest <sha256>`. Without a digest in the feed the installer installs the verified GitHub Release tarball instead of ClawHub
- [ ] Owner signs the final feed **offline**, in one pass: `minisign -S -s <channel>.key -m plugin-<channel>.json`, producing `plugin-<channel>.json.minisig`. Same key and procedure as the harness `release.json`; link: the plugin-feed section of the harness `docs/manual-release.md` (to be added by harness Task 12; link placeholder until it exists). Promoting `beta` to `stable` re-signs identical bytes
- [ ] Feed check before publishing: the feed validates (`scripts/dist/build-plugin-feed.mjs` validates against `scripts/dist/plugin-feed.schema.json` when it writes it); `latest` is the new version; release notes exist in German and English; `hosts.openclaw.windowsNativeBeta` is intentional (flip to `false` only after four weeks of green Windows legs); a version below the previous latest was built with `--allow-older` on purpose
- [ ] Publish `plugin/{channel}.json` and `plugin/{channel}.json.minisig` to `https://updates.plur1bus.app/`, and `install-plugin.sh` and `install-plugin.ps1` to `https://plur1bus.app/`; the installer bundle and tarball stay on the GitHub Release. Fetch all of them back and compare SHA-256 with the feed
- [ ] Smoke through the **published** one-liners in a fresh VM or user account per OS: Linux (x64 or arm64), macOS (Apple silicon), Windows native, and Windows with WSL. Each: fresh install, `openclaw plur1bus selftest`, `--update` from the previous release, `--uninstall`
- [ ] Owner's VPS (legacy rsync deploy) only if not yet migrated: first disable the `protect-plur1bus-deploy.sh` cron line and move the script away, then `--adopt-legacy --dry-run`, then `--adopt-legacy` (steps in [`distribution.md`](distribution.md#adopting-an-rsync-deploy-legacy))

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
