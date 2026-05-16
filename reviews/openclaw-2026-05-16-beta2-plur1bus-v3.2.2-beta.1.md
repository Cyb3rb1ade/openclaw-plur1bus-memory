# PLUR1BUS 3.2.2-beta.1 vs OpenClaw 2026.5.16-beta.2

## Verdict

- Beta2 compatibility: **pass** for package/plugin compatibility.
- First-class plugin readiness: **pass** via managed tarball lane.
- Full functional memory-store runtime: **blocked**, because no real embedding provider key, local E5 smoke, or deterministic mock provider was configured.
- Breakings found: **none directly affecting PLUR1BUS v3.2.2-beta.1**.
- Live OpenClaw touched: **no**.

## Target Snapshot

- OpenClaw npm beta/exact: `2026.5.16-beta.2`.
- OpenClaw tag: `v2026.5.16-beta.2` at `dba00cba6fd2177b1524f080b4b1a6157e287b1f`.
- OpenClaw main forward-look: `e6d04550cac74f9a2b2e80a751443335bbbf0713`, 39 commits ahead of beta2.
- PLUR1BUS tested source: `3.2.2-beta.1` at `c89fff5711b7ca258a109c9424551f2bdd9ea152`.
- Source mode: `git archive HEAD`; dirty patch files were not included.

## Range Review

Local clone source of truth: `/tmp/openclaw-beta2-range-EOOaF6/openclaw`.

- Merge-base beta1/beta2: `6921d9072e91df4761edc37048f990c97774026b`.
- beta2-only commits: 149.
- beta1-only commits: 10.
- symmetric ahead/behind: `10 / 149`.

The beta2-only range touches plugins, package validation, providers, embeddings, gateway, hooks, cron, sessions and transcripts. No commit required a PLUR1BUS code fix. The most relevant compatibility commits were package runtime-file validation, provider/embedding response hardening, plugin dependency repair behavior, cron wait mode, and MCP tool abort-signal forwarding.

## Gates

- `node --check`: pass for `index.js`, `lib/neo-arch.js`, and `lib/providers/openclaw-memory-embedding-adapters.js`.
- `node --test`: pass, 11/11.
- `npm pack --dry-run --json`: pass, 18 files.
- Tarball contains `index.js`, `openclaw.plugin.json`, `package.json`, `lib/`, and provider adapter files.

## Runtime Harness

Harness base: `/var/tmp/openclaw-beta2-plur1bus-v322-JI2ibN`. OpenClaw was installed as `kimi` into `$BASE/prefix`, and all OpenClaw commands used `$BASE/prefix/bin/openclaw --profile ...`. No bare `openclaw` command was used for the runtime lanes.

Initial sandbox constraints prevented a pure unprivileged setup under `/tmp` or `/home/kimi`; the isolated `/var/tmp` base was created with escalated setup and then used with `kimi` for installer and OpenClaw commands.

## Lane A: Linked Plugin

- Install: pass.
- Runtime inspect: pass after setting isolated `hooks.allowConversationAccess=true` and `hooks.allowPromptInjection=true`.
- Tools: `memory_recall`, `memory_store`, `memory_forget`, `knowledge_update`.
- Hooks: `agent_end`, `before_prompt_build`, `gateway_start`, `gateway_stop`.
- Memory embedding providers: `plur1bus-openai`, `plur1bus-openai-compatible`, `plur1bus-e5-small`.
- Doctor: `No plugin issues detected.`

## Lane B: Managed Tarball Plugin

- Install: pass.
- Runtime inspect: pass after setting isolated hook permissions.
- Direct dependencies: pass. `@lancedb/lancedb`, `openai`, and optional `@huggingface/transformers` were installed under the managed extension root.
- Sibling fallback: not used for plugin readiness.
- First-class plugin readiness: pass.

## Findings

- `plugins doctor --json` is not supported in beta2; text doctor passed.
- Runtime inspect blocks `agent_end` for non-bundled plugins until `hooks.allowConversationAccess=true` is set. This is expected policy and PLUR1BUS handles it when configured.
- `openclaw infer embedding providers --json` listed only memory-core `local`; PLUR1BUS provider IDs were visible in plugin runtime inspect. Treat this as a discovery/UI limitation, not a package loading failure.
- OpenClaw security audit warnings were isolated-profile defaults: loopback auth missing, trusted proxies, plugins.allow, permissive tool policy. No live gateway was started.

## ClawSweeper

- Range: 149 commits.
- Clean: 60.
- Skipped: 12.
- Findings: high 0, medium 13, low 8.
- Unreviewed: 56.

No high findings. The relevant medium findings were reviewed against PLUR1BUS plugin/memory/hook surfaces; package runtime-file validation was covered by tarball pack/install, and provider/session hardening did not break PLUR1BUS.

## Integration Opportunities

- `openclaw cron run --wait`: useful for deterministic Dreaming/Promote/Prune test execution.
- MCP plugin tool `AbortSignal`: PLUR1BUS long-running tools/providers should learn cancellation in a follow-up.
- Package runtime-entry validation: already compatible; keep pack file list guarded.
- Provider/embedding response hardening: align PLUR1BUS OpenAI-compatible adapter error handling in a follow-up.

## Go/No-Go

Go for PLUR1BUS `3.2.2-beta.1` package/plugin compatibility against OpenClaw `2026.5.16-beta.2`. Not a full provider-backed memory runtime pass because provider smokes were intentionally blocked without test credentials or local model smoke.
