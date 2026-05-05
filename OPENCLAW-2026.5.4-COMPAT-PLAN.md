# OpenClaw 2026.5.4 Compat Plan

Date: 2026-05-05

## Current State

- Local OpenClaw: `2026.5.3-1`.
- npm `latest`: `2026.5.4`.
- Local plur1bus repo base: `main`, `ad6440707358d404acaf017cad957d79f54bb37f`, tag `v2.1.23`; this working tree is being released as `v2.1.24` for OpenClaw `2026.5.4` compatibility.
- GitHub `origin/main`: same commit as local `main`.
- Clawsweeper script in `/root/.openclaw/scripts/clawsweeper-gate.sh` matches the repo copy.
- Local `how-to-memory.md` exists in this repo but is gitignored. It has been refreshed to plur1bus `2.1.24` after the 5.4 compatibility work.
- No file literally named `meta-patch.sh` was found in `/root/openclaw-memory-system` or `/root/.openclaw/patches`. If the intended file is `apply-media-patch.sh`, the live copy is `/root/.openclaw/patches/apply-media-patch.sh`; it is outside the public plur1bus repo and must be audited separately from the memory patch chain.

## Test Results

- `openclaw plugins doctor`: memory plugins registered; only hook-only compatibility info for `before-compact-save` and `tts-status-inject`.
- Runtime dependency checks passed for `memory-lancedb-stock` LanceDB and runtime stub.
- `memory-doctor.mjs stats`: completed, total 13,108 memories, about 11.3 GB.
- `systemctl --user status openclaw-gateway`: service active since 2026-05-04 23:29 CEST.
- `openclaw status`: completed, but gateway probe from the sandbox reports loopback `EPERM`; systemd view confirms the gateway is actually running.
- `how-to-memory.md`: present but ignored by Git and stale at `2.1.20`.

## Clawsweeper Result

Command:

```bash
/root/.openclaw/scripts/clawsweeper-gate.sh "OpenClaw 2026.5.3-1 (2eae30e)" 2026.5.4 --no-block
```

Result:

- 527 commits in range.
- 212 clean.
- 31 skipped.
- 104 findings: 2 high, 66 medium, 21 low, 15 unweighted.
- 180 unreviewed commits with no report.

High findings:

- `bc0b54e`: missing beta.3 `server-close` compatibility alias.
- `b37fba7`: ClawHub publish workflow calls missing `pnpm release:plugins:npm:runtime:check` script.

Relevant medium findings for this instance:

- `59b5058`: Active Memory partial timeout recovery can be cut off by outer hook timeout.
- `25b30c9`: bundled runtime tools can bypass narrow runtime allowlists.
- `d253392`: explicit web providers can be filtered before auto-enable widens restrictive plugin allowlists.

## 2026.5.4 Local Compatibility Work

The old local patch chain was version-gated to `2026.5.3-1`.

Initial dry-run against the `2026.5.4` tarball:

```text
[patch] OpenClaw 2026.5.3-1 compat: package version is 2026.5.4, skipping dist patch
```

The dedicated `patches/apply-openclaw-20260504-compat.sh` now exists. It carries forward the 5.3 local runtime fixes and adapts the upstream-breaking hashed lane import by matching `./lanes-*.js` dynamically instead of pinning the old bundled filename.

Clean tarball validation passed:

```bash
tar -xzf /tmp/openclaw-54-probe-ca1knR/openclaw-2026.5.4.tgz -C "$tmpdir"
OPENCLAW_DIST_DIR="$tmpdir/package/dist" bash patches/apply-openclaw-20260504-compat.sh
OPENCLAW_DIST_DIR="$tmpdir/package/dist" bash patches/apply-openclaw-20260504-compat.sh
node --check <patched runtime files>
```

Conclusion: the local patch chain is no longer the update blocker. Production should still use the guarded `update-openclaw.sh --check` path first because Clawsweeper found broad upstream risk.

## Live Bug-Reporting Plan

1. File/update an upstream OpenClaw issue for Active Memory hook timeout mismatch.
   - Evidence from local logs: `active-memory` starts with `timeoutMs=8000`, but `before_prompt_build` fails after `3000ms`.
   - Link Clawsweeper commit report `59b5058`.
   - Ask for hook timeout headroom or an earlier internal watchdog deadline.
2. File/update an upstream issue for `2026.5.4` release risk.
   - Include Clawsweeper summary counts and the two high findings.
   - State that local production upgrade is blocked by 180 unreviewed commits and the 5.4 patch gate.
3. Keep plur1bus-specific issue separate.
   - Track local 5.4 compat patch work in this repo.
   - Do not mix upstream OpenClaw reports with local deployment config.

## Local Git Plan

1. Optional branch before publishing:

```bash
git -C /root/openclaw-memory-system switch -c compat/openclaw-2026.5.4
```

2. Review and commit the current compat files:

- `patches/apply-openclaw-20260504-compat.sh`
- `patches/apply-memory-patches.sh`
- `scripts/update-openclaw.sh`
- `HOW-TO-UPDATE.md`
- `SYSTEM-DOCUMENTATION.md`
- `README.md`
- local ignored `how-to-memory.md`, or intentionally retire it in favor of tracked `how-to-memory-perfect.md`

3. Keep explicit validation:

- Fail if the target package version is unsupported.
- Fail if a versioned compat patch silently skips all target files.
- Save Clawsweeper summary into the update preflight output.

## plur1bus GitHub Plan

1. Push only after a successful `OPENCLAW_UPDATE_TARGET=2026.5.4 /root/openclaw-memory-system/scripts/update-openclaw.sh --check` and local plugin diagnostics.
2. Tag the next release as `v2.1.24` or later.
3. Release notes must say:
   - OpenClaw `2026.5.4` support is validated.
   - Which old local patches are retired because upstream fixed them.
   - Which local patches remain necessary.
   - Clawsweeper high/medium risks reviewed or accepted.
4. Do not publish a release that only bumps docs while the 5.4 patch is still version-gated to skip.

## Recommended Next Action

Run the guarded update check:

```bash
OPENCLAW_UPDATE_TARGET=2026.5.4 /root/openclaw-memory-system/scripts/update-openclaw.sh --check
```

Only run the real update after the check path validates the 5.4 tarball, patch anchors, plugin contracts, memory doctor, and service restart plan.
