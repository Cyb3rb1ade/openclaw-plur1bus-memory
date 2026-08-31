# Known issues and 7.5.1 backlog

This file records non-blocking findings that are deliberately not reopening the
PLUR1BUS 7.5.0 source freeze. Runtime claims remain limited to the exact
OpenClaw `2026.9.1-beta.1` target.

## Deferred findings

- `lib/memory-request-context.js` / OpenClaw plugin contexts — positive isolation between two independently authenticated users is not testable because OpenClaw `2026.9.1-beta.1` does not project its trusted-proxy `authenticatedUserProfile` into `OpenClawPluginToolContext` or `PluginHookAgentContext`; PLUR1BUS continues to fail closed when a trusted user principal is absent, so this is a capability/coverage gap rather than a cross-user access bypass.
- Automatic capture policy — default `agent-private` memories intentionally remain visible to the same agent across workspaces; only explicit `workspace` scope is workspace-partitioned, so automatic workspace isolation must not be claimed and the default-scope semantics should be revisited in 7.5.1.
- `lib/memory-request-context.js` and the `/plur1bus` command registration — the trusted command-provider allowlist covers Telegram, Discord, Slack, Mattermost, and cron, but not WebChat; the native `skill_proposal_changed` hook removes WebChat as a requirement for Workshop synchronization, while WebChat command parity remains backlog work.
- `lib/obsidian-bridge.js` — a genuinely non-terminating manual or filesystem I/O operation can keep bridge shutdown pending; this is intentionally fail-closed because OpenClaw's outer lifecycle deadline aborts replacement instead of starting a concurrent owner, but cancellation-aware I/O remains desirable.
- Provider fallback verification — controlled primary-load failure has historical evidence, but natural download corruption, remote outage, and mid-inference runtime failure have not been exercised end-to-end; no general natural-outage fallback claim is made.
- Obsidian runtime verification — the registered inbound apply surface and the complete installed-runtime command path have not been re-run on the frozen commit; unit and earlier harness evidence do not substitute for the deferred runtime matrix.
- Transitive dependencies — npm may warn that `boolean@3.2.0` and `node-domexception@1.0.0` are deprecated; the lockfile audit has not identified a vulnerability caused by these warnings, and replacing transitive packages belongs in a separately planned dependency update.
- Historical host invariant — an earlier, incorrectly isolated lab process accessed `/root/.openclaw` and migrated the production state database; the production repair is outside this repository freeze, and whole-engagement host integrity therefore cannot be claimed even if later isolated runs are clean.

## Closed findings retained for traceability

- Invalid-candidate and stale-provider cleanup leaks in re-embedding were fixed by `6f11ff3`; they are not open release blockers.
- Re-embedding wording and official PLUR1BUS 7.4.10 ancestry wording were corrected by `947be94` and `46b1977`.
- Shared `/tmp/_tombstones` test-fixture races were isolated by `d703497`, `7e7a308`, and their focused stress evidence; they do not change product semantics.
