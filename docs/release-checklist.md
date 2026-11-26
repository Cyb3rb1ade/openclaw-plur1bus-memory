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

Published automatically. The `github-packages` job in
`.github/workflows/plugin-release.yml` runs on the tag push after
`github-release`, with the automatic `GITHUB_TOKEN` (`packages: write`, no
secret), and publishes the same tarball as the GitHub Release to
`https://npm.pkg.github.com`. A tag push always runs on the stable channel and
publishes under the dist-tag `latest`; only a `workflow_dispatch` with channel
`beta` publishes under `beta`. `latest` only moves up to a plain `x.y.z`: on the
stable channel the job refuses a prerelease (`x.y.z-beta.1`, `x.y.z-hermes.0`,
also as a tag push) and a version below the highest `x.y.z` already on GitHub
Packages (a backport). The job passes `--tag` explicitly, which turns off npm's
own checks for exactly these two cases, so it makes them itself.
Before publishing it checks the workflow artifact against `SHA256SUMS` and that
file against the release asset; afterwards it reads `dist.integrity` back and
compares it with the tarball's sha512. A version that is already on GitHub
Packages is skipped when it holds this exact tarball and fails the job
otherwise; published versions are immutable. A dry run publishes nothing.

- [ ] `github-packages` is green in the tag run; its log ends with `published …`
      or `… already on GitHub Packages with this tarball`
- [ ] Fresh disposable OpenClaw install from the GitHub Packages artifact

The tag must sit on a `main` commit whose workflow already contains the job; a
tag push runs the workflow file of the tagged commit.

If the job fails:

1. `cannot read @cyb3rb1ade/plur1bus-memory on GitHub Packages`: open the
   package settings, "Manage Actions access", and add
   `Cyb3rb1ade/openclaw-plur1bus-memory` with role **Write**.
2. `publishing … failed; on E403 …`: if the log shows `E403`, the repository
   has only role Read under "Manage Actions access"; change it to **Write**.
   For any other npm error read the log first.
3. `already on GitHub Packages with another tarball`: stop. Someone published
   different bytes under this version; it cannot be replaced. Find out where
   they came from before doing anything else.
4. `is a prerelease on the stable channel` or `would move latest backwards`:
   nothing reached GitHub Packages, and a re-run fails the same way. Publish by
   hand (below) under the version's own dist-tag: `beta` for a beta, the line's
   name for a side line (for example `hermes`), `release-x.y` for a backport.
   Not `x.y` or `vx.y`: npm rejects a dist-tag that parses as a version range.
   The tag push also created a normal GitHub Release; mark a prerelease with
   `gh release edit "v$VERSION" --prerelease`.
5. Otherwise, or after fixing (1) or (2): use **Re-run failed jobs** in the
   Actions run. Do not re-run all jobs: `github-release` then fails because the
   release exists, and `github-packages` is skipped.

Last resort, by hand: publish the GitHub Release asset itself, never a locally
packed tarball, by absolute path and through a dedicated userconfig. The
`--@cyb3rb1ade:registry` flag outranks any npmrc that routes the scope
elsewhere (for example to ClawHub); `--registry` alone does not. The userconfig
is the two-line file the "Publish to GitHub Packages" step writes (the scope
registry and the auth entry that names the token variable), so the token never
touches the disk.

```bash
VERSION=x.y.z
dir=$(mktemp -d)   # absolute; npm reads `release/x.tgz` as a GitHub shorthand
tgz="$dir/cyb3rb1ade-plur1bus-memory-$VERSION.tgz"
gh release download "v$VERSION" --repo Cyb3rb1ade/openclaw-plur1bus-memory \
  --pattern "cyb3rb1ade-plur1bus-memory-$VERSION.tgz" --pattern SHA256SUMS --dir "$dir"
(cd "$dir" && sha256sum -c SHA256SUMS)
# Write "$dir/gpr.npmrc" with umask 077: the two lines the printf in the
# "Publish to GitHub Packages" step of .github/workflows/plugin-release.yml writes.
gpr() { NODE_AUTH_TOKEN=$(gh auth token) npm --userconfig "$dir/gpr.npmrc" \
  --@cyb3rb1ade:registry=https://npm.pkg.github.com "$@"; }
# A plain x.y.z above the highest one: no --tag, so npm's own checks stay on.
# Anything else gets its own dist-tag: --tag beta, --tag hermes, --tag release-7.20.
gpr publish "$tgz" --ignore-scripts
gpr view "@cyb3rb1ade/plur1bus-memory@$VERSION" dist.integrity
echo "sha512-$(openssl dgst -sha512 -binary "$tgz" | base64 -w0)"   # must match
rm -rf "$dir"
```

The `gh` login needs the `write:packages` scope.

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

## Installers and feed

Installers, bootstraps and the install feed live in [PLUR1BUS-Host-Addons](https://github.com/Cyb3rb1ade/PLUR1BUS-Host-Addons).

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
