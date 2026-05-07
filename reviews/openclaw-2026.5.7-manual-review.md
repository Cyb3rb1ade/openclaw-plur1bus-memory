# OpenClaw 2026.5.7 Manual ClawSweeper Review

Date: 2026-05-08
Local release: plur1bus memory system v2.1.28
OpenClaw range: `c97b9f79ec43b531a3472c3219ca51efbf7695a3..eeef4864494f859838fec1586bedbab1f8fa5702`
OpenClaw target: `2026.5.7 (eeef486)`

## ClawSweeper State

The local ClawSweeper gate resolved the `2026.5.6 -> 2026.5.7` range to 76
upstream commits. The public `openclaw/clawsweeper-state` data did not contain
review records for this range, so the automated gate reported all 76 commits as
unreviewed.

This document records the local manual review. It clears the local update
decision, but it does not write upstream ClawSweeper state.

## Scope Reviewed

- 76 upstream commits and 300 changed files.
- Focus areas: gateway startup/config validation, plugin setup/install recovery,
  active-memory controls, OpenAI embeddings and Codex routes, agent context and
  compaction, native command authorization, cron status/timer repair, channel
  listing/setup behavior, Telegram delivery, Tavily runtime config, and release
  packaging.

## Local Findings

- No additional OpenClaw dist patch is required beyond the `2026.5.7` dispatcher
  support and the existing `20260504` compatibility patch shipped in v2.1.28.
- The YAAWC Kimi `maxTokens` drift was already found during update verification,
  fixed locally to default to `32768`, and the Docker stack was rebuilt.
- `kimi-claw` remains a non-channel plugin in the local install. Its manifest has
  no `channels`, no `setup`, and no `contracts`, so the upstream external channel
  setup/runtime fixes do not connect it automatically.
- The new Active Memory global toggle guard requires `operator.admin` when a
  gateway client scope is present. The local gateway probe is admin-capable.
- Native command owner enforcement is stricter after `cd070c2a4976`; no local
  cron or Telegram delivery break was observed, but command ownership should be
  watched after future native command changes.
- Channel CLI behavior changed: `openclaw channels list --json` now reports chat
  channels, while `--all` exposes the installable catalog. Local Telegram remains
  configured and installed.
- Cron JSON now includes computed `status`; local cron entries returned `ok`
  status values after an outside-sandbox gateway check.
- Codex OAuth doctor route preservation changes are beneficial for this host and
  do not require a local patch.
- Tavily `SecretRef` runtime config changes only matter if Tavily is enabled;
  the local active web-search path did not need a Tavily patch.

## Verification

- `openclaw --version`: `OpenClaw 2026.5.7 (eeef486)`.
- `openclaw gateway probe` outside the sandbox: reachable, admin-capable, read
  probe ok, app `2026.5.7`.
- `openclaw status`: gateway reachable, systemd user service running, Telegram
  channel OK, app `2026.5.7`.
- `openclaw channels list --json`: Telegram configured with `bernhardine`,
  `default`, and `heisenberg` accounts.
- `openclaw channels list --all --json`: installable channel catalog is exposed.
- `openclaw cron list --json`: computed `status` field present; sampled jobs
  report `status: "ok"`.
- `openclaw plugins doctor`: clean except the known hook-only informational
  entries for local hook plugins.
- `node /root/openclaw-memory-system/scripts/memory-doctor.mjs provider-check`:
  provider and embedding dimensions OK for 39 agents.
- YAAWC Docker services are up and HTTP readiness on `127.0.0.1:3020` passed
  after rebuilding.

## Decision

The `2026.5.7` update is accepted for this host. No extra local code patch is
needed from the 76 unreviewed upstream commits.

Keep the following watchpoints for the next update:

- Active Memory admin-scope enforcement for global toggles.
- Native command owner enforcement for Telegram and cron-triggered commands.
- Channel CLI output shape changes in scripts that parse `openclaw channels list`.
- Event-loop starvation under heavy gateway status calls; outside-sandbox probes
  were healthy, but delayed fetch timers appeared in the gateway log.
- `kimi-claw` connection state remains a separate manifest/setup issue, not
  solved by the upstream external channel setup fix.
