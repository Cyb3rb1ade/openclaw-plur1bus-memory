# Known issues and 7.5.1 backlog

This file records non-blocking findings that are deliberately not reopening the
PLUR1BUS 7.5.0 source freeze. Runtime claims are limited to what the recorded
evidence shows: a full runtime matrix and upgrade test on OpenClaw 2026.8.2,
source-level verification of the 2026.8.1 floor, and a bounded smoke run on
2026.9.1-beta.1 (see docs/compatibility-openclaw.md).

## Deferred findings

- `lib/memory-request-context.js` / OpenClaw plugin contexts — positive isolation between two independently authenticated users is not testable because OpenClaw `2026.9.1-beta.1` does not project its trusted-proxy `authenticatedUserProfile` into `OpenClawPluginToolContext` or `PluginHookAgentContext`; PLUR1BUS continues to fail closed when a trusted user principal is absent, so this is a capability/coverage gap rather than a cross-user access bypass.
- Automatic capture policy — default `agent-private` memories intentionally remain visible to the same agent across workspaces; only explicit `workspace` scope is workspace-partitioned, so automatic workspace isolation must not be claimed and the default-scope semantics should be revisited in 7.5.1.
- `lib/memory-request-context.js` and the `/plur1bus` command registration — the trusted command-provider allowlist covers Telegram, Discord, Slack, Mattermost, and cron, but not WebChat; the native `skill_proposal_changed` hook removes WebChat as a requirement for Workshop synchronization, while WebChat command parity remains backlog work.
- `lib/obsidian-bridge.js` — a genuinely non-terminating manual or filesystem I/O operation can keep bridge shutdown pending; this is intentionally fail-closed because OpenClaw's outer lifecycle deadline aborts replacement instead of starting a concurrent owner, but cancellation-aware I/O remains desirable.
- Provider fallback verification — controlled primary-load failure has historical evidence, but natural download corruption, remote outage, and mid-inference runtime failure have not been exercised end-to-end; no general natural-outage fallback claim is made.
- OpenClaw 2026.9.1-beta.1 — supported as a source-verified forward-compatibility target only. The bounded runtime smoke (plugin load, recall, capture, one re-embedding switch) was not executed for 7.5.0; it needs the beta's version and integrity as image build arguments and a version override in the laboratory's evidence gate and image pin (estimated one to one and a half hours).
- Transitive dependencies — npm may warn that `boolean@3.2.0` and `node-domexception@1.0.0` are deprecated; the lockfile audit has not identified a vulnerability caused by these warnings, and replacing transitive packages belongs in a separately planned dependency update.
- Historical host invariant — an earlier, incorrectly isolated lab process accessed `/root/.openclaw` and migrated the production state database; the production repair is outside this repository freeze, and whole-engagement host integrity therefore cannot be claimed even if later isolated runs are clean.
- `index.js` scheduled jobs (`rem-dream`, `consolidate-daily`, `skill-miner`) — since 5311ce7 their `workspace` and `user` partitions read only the shared pools under `.plur1bus-shared/`, which are populated solely by `/share`. Rows that `memory_store` writes with `scope: workspace` (or `user`) into the agent table are therefore covered by none of these jobs' partitions. Observed on OpenClaw 2026.8.2: three workspace-scoped rows in the agent table, an empty shared pool, and `rem-dream` reporting `too_few_memories, count: 0` for both partitions. Whether such agent-table rows should be read by the agent's own partition or migrated into the pool is a design decision — the routing is security-tested in `tests/release-731-runtime-callsite-security.test.js` — and is not changed in 7.5.0. The command payload now reports `reason`, `count`, `runKey` and `patternsFound` per partition so the outcome is visible instead of hidden behind the first partition's fields.

## Closed findings retained for traceability

- Invalid-candidate and stale-provider cleanup leaks in re-embedding were fixed by `6f11ff3`; they are not open release blockers.
- Re-embedding wording and official PLUR1BUS 7.4.10 ancestry wording were corrected by `947be94` and `46b1977`.
- Shared `/tmp/_tombstones` test-fixture races were isolated by `d703497`, `7e7a308`, and their focused stress evidence; they do not change product semantics.

## Host behaviour worth knowing (not defects in 7.5.0)

- Removing a Telegram account through `config.patch` makes OpenClaw 2026.8.2
  restart the gateway in-process (`config change requires gateway restart
  (channels)`, SIGUSR1, HTTP server back after about three seconds). Five to
  seven seconds after the removal the restarted process still logs
  `[default] starting provider` for the removed account and sets its command
  menu before the new config takes effect, so the bot API must still be
  reachable at that moment. The container reports healthy for about a second
  before the restart begins, so a health probe alone does not prove the
  restart is over.
- A LanceDB table handle without a read consistency interval keeps the
  version it was opened with; 7.5.0 connects with `readConsistencyInterval: 0`
  (see CHANGELOG). Before that fix a reader opened before a write never saw
  the write until reopened: the gateway's own rem-dream run missed three rows
  committed eight seconds earlier for more than two minutes, while a fresh
  process saw them after 1.3 s.
- OpenClaw 2026.8.2 requires package lifecycle scripts: an install with
  `--ignore-scripts` fails with `package lifecycle is incomplete` and
  `EROFS ... .openclaw-lifecycle-lock`. 2026.8.1 does not.
- OpenClaw hands plugin commands `entry?.sessionId || randomUUID()` (2026.8.1
  and 2026.8.2 alike): in a chat with no persisted session every command
  carries a fresh id. 7.5.0 binds the persisted session instead. Edge kept on
  purpose: a `vault-confirm prepare` issued before the chat's first agent turn
  is refused at confirm with `mismatchedFields: ["conversationPrincipal"]`;
  repeat `prepare`. Pinned by `tests/vault-confirmation-first-turn-edge.test.js`.
- Plugins cannot enumerate the secret store (`listSecrets` is not in the
  plugin-sdk) nor write to it (`buildPluginSecretRefSetupPlan` demands an
  exec-backed provider config).
- OpenClaw has no reranking concept; PLUR1BUS supplies it entirely.
- Memory diagnostics: RSS thresholds derive from Node's heap limit and the
  process memory limit and have no config surface (default 1.09/1.64 GiB,
  raised via `--max-old-space-size`); RSS growth is a hard-coded 1 GiB per
  window, which loading a local embedding model exceeds by design; local
  inference on the gateway thread produces `liveness warning` diagnostics.
  None of these occur with the recommended OpenAI + Cohere setup.

## Recall observations (backlog, not 7.5.0 defects)

- `minScore` and `forgetThreshold` default to 0.3 while `1/(1+distance)` cannot
  fall below 1/3: the floor never filters. Practically inert because ranking,
  the reranker and the recommended embedding models carry the result; visible
  only with local E5 and no reranker. Calibrate per embedding profile from a
  golden set before changing it.
- A bare UUID is not a semantic query; there is no lexical/exact retrieval
  path. A hybrid path (exact id and metadata, lexical for rare tokens, vector
  for meaning, one reranked pool) is the 7.5.1 candidate.
- The runtime matrix asserts the behaviour of ten paths; the additive layers
  (emotion tiers, knowledge promotion, afterthoughts, persona voice, dream echo,
  meta-cognition, temporal context) are covered by the source suite only.

## Laboratory findings (harness, not product)

- The skill-workshop stage reported its local-mirror check as blocked on a
  missing chat credential. The real cause was the actor tier defect above: the
  mirror could never finish, whatever the channel. The stage now reads the
  local record and fails when the activation stays unfinished.

- Every stage needs a cleanup that can run without a healthy gateway; a
  synthetic Telegram channel left configured after its credential file was
  removed poisoned all following stages. Fixed by declaring the shrinking array
  paths in the restore patch and by keeping the driver in the lab-owned fixture
  directory instead of a sticky `/tmp`.
- The lab still lacks a cleanup routine for finished runs; per-run containers,
  volumes and build cache blocked new runs several times.
- The `rem-dream` gate of the Obsidian stage was never reached before the
  2026.8.2 runs and assumed candidates the fixture never produced: every row
  was `workspace`-scoped and the only `agent-private` row was the invalidated
  negative fixture. The stage now stores three `agent-private` rows through the
  real Gateway `memory_store` immediately before the run and asserts the
  deterministic partition contract (agent-private runs, workspace skips);
  silent `set -e` aborts now name the failing line through an ERR trap.
