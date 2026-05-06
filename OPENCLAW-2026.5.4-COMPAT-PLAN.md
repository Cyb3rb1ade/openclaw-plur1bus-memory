# OpenClaw 2026.5.4/2026.5.5 Compat Report

Date: 2026-05-06

## Current State

- Local OpenClaw: `2026.5.5` (`b1abf9d`).
- plur1bus release: `v2.1.25`.
- GitHub `origin/main`: update commit pending at the time this report was edited.
- Clawsweeper script in `/root/.openclaw/scripts/clawsweeper-gate.sh` matches the repo copy.
- Local `how-to-memory.md` exists in this repo but is gitignored. It was last refreshed after the 5.4 compatibility work and remains outside the public release artifact.
- No file literally named `meta-patch.sh` was found in `/root/openclaw-memory-system` or `/root/.openclaw/patches`. If the intended file is `apply-media-patch.sh`, the live copy is `/root/.openclaw/patches/apply-media-patch.sh`; it is outside the public plur1bus repo and must be audited separately from the memory patch chain.

## Test Results

- `openclaw plugins doctor`: memory plugins registered; only hook-only compatibility info for `before-compact-save` and `tts-status-inject`.
- Runtime dependency checks passed for `memory-lancedb-stock` LanceDB and runtime stub.
- `memory-doctor.mjs provider-check`: passed outside the sandbox; `text-embedding-3-large`, 3072 dimensions, all 39 agent DBs matched.
- `memory-doctor.mjs stats`: completed after cron hardening, total 13,135 memories, about 11.4 GB of LanceDB data.
- `systemctl --user status openclaw-gateway`: service active after the final 2026.5.5 restart.
- `openclaw --version`: `OpenClaw 2026.5.5 (b1abf9d)`.
- `openclaw cron list`: both repaired jobs now report `ok` after manual validation runs.
- `how-to-memory.md`: present but ignored by Git; maintained locally outside the public release artifact.

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

## 2026.5.5 Clawsweeper Result

Command:

```bash
/root/.openclaw/scripts/clawsweeper-gate.sh "OpenClaw 2026.5.4 (325df3e)" 2026.5.5 --no-block
```

Result:

- 54 commits in range.
- 0 clean reports.
- 54 unreviewed commits with no report.

The first gate attempt exposed a local gate issue: installed `2026.5.4` was visible as `OpenClaw 2026.5.4 (325df3e)` but was not resolvable as a GitHub tag or npm `gitHead`. `clawsweeper-gate.sh` now resolves the short commit hint from `openclaw --version` via the GitHub commits API.

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

Conclusion: the local patch chain was not the final update blocker. Production is now on `2026.5.4`; future OpenClaw updates must still use the guarded `update-openclaw.sh --check` path first because Clawsweeper found broad upstream risk in this range.

## 2026.5.5 Local Compatibility Work

The existing `apply-openclaw-20260504-compat.sh` patch was extended to accept `2026.5.5`. Clean tarball validation passed against `openclaw@2026.5.5`; all expected anchors applied and the patched bundle files passed `node --check`.

The production update initially installed `2026.5.5`, but the live ExecStartPre copy under `/root/.openclaw/patches` still routed only `2026.5.4` to the versioned compat patch. That routing was synchronized with the repo, the patch chain was re-run, and the gateway was restarted.

Final verification:

- `openclaw --version`: `OpenClaw 2026.5.5 (b1abf9d)`.
- `systemctl --user status openclaw-gateway`: active.
- Gateway journal: `[gateway] ready`.
- `openclaw plugins doctor`: memory plugins registered; only expected hook-only compatibility info.
- `memory-doctor.mjs provider-check`: passed outside the sandbox; 39 agent DBs matched 3072 dimensions.
- `openclaw cron list`: active production jobs show `ok`.
- Live bundle marker scan found the `plur1bus-openclaw-20260504-*` markers in the 2026.5.5 runtime files.

## 2026-05-05 Cron Hardening

Two post-update cron issues were traced to local routing/state, not plur1bus memory structure:

- `daily-gas-weather-briefing` failed on 2026-05-04 because the run fell through to `openai-codex/gpt-5.5-pro`, which is not supported by the active Codex ChatGPT account. The job is pinned to `kimi-coding/kimi-for-coding`, `payload.fallbacks` is `[]`, and `thinking` is `off`.
- `proactive-agent:heartbeat` failed because a non-critical `proactive-tracker.md` edit failure was treated as the whole cron result. The job prompt now treats already-applied, unnecessary, or rejected tracker edits as warnings when the checklist and final report still complete.

The proactive tracker and recurring-pattern notes now record that gas storage automation exists through `daily-gas-weather-briefing`; the latest failure was model routing, not missing AGSI data.

Manual validation:

- `proactive-agent:heartbeat`: `status=ok`, provider/model `kimi-coding/kimi-for-coding`, Telegram delivery succeeded.
- `daily-gas-weather-briefing`: `status=ok`, provider/model `kimi-coding/kimi-for-coding`, Telegram delivery succeeded.

## Live Bug-Reporting Plan

1. File/update an upstream OpenClaw issue for Active Memory hook timeout mismatch.
   - Evidence from local logs: `active-memory` starts with `timeoutMs=8000`, but `before_prompt_build` fails after `3000ms`.
   - Link Clawsweeper commit report `59b5058`.
   - Ask for hook timeout headroom or an earlier internal watchdog deadline.
2. File/update an upstream issue for `2026.5.4` release risk if new upstream regressions appear.
   - Include Clawsweeper summary counts and the two high findings.
   - State that local production is patched and running, but 180 unreviewed commits remain a documented risk for the next update gate.
3. Keep plur1bus-specific issue separate.
   - Track local 5.4 compat patch work in this repo.
   - Do not mix upstream OpenClaw reports with local deployment config.

## Local Git Plan

Review and commit future compat files in small, auditable changes:

- `patches/apply-openclaw-20260504-compat.sh`
- `patches/apply-memory-patches.sh`
- `scripts/update-openclaw.sh`
- `HOW-TO-UPDATE.md`
- `SYSTEM-DOCUMENTATION.md`
- `README.md`
- local ignored `how-to-memory.md`, or intentionally retire it in favor of tracked `how-to-memory-perfect.md`

Keep explicit validation:

- Fail if the target package version is unsupported.
- Fail if a versioned compat patch silently skips all target files.
- Save Clawsweeper summary into the update preflight output.

## plur1bus GitHub Plan

1. Push only after a successful guarded update check and local plugin diagnostics.
2. Tag `v2.1.25` after the 2026.5.5 support commit lands.
3. Release notes must say:
   - OpenClaw `2026.5.5` support is validated.
   - Which old local patches are retired because upstream fixed them.
   - Which local patches remain necessary.
   - Clawsweeper high/medium risks reviewed or accepted.
4. Do not publish a release that only bumps docs while the 5.4 patch is still version-gated to skip.

## Recommended Next Action

For the next OpenClaw update, start with the guarded update check:

```bash
OPENCLAW_UPDATE_TARGET=<target-version> /root/openclaw-memory-system/scripts/update-openclaw.sh --check
```

Only run the real update after the check path validates the target tarball, patch anchors, plugin contracts, memory doctor, Clawsweeper risk notes, and service restart plan.
