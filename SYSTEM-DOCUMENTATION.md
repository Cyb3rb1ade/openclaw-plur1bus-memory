# System Documentation

Operational notes for plur1bus on OpenClaw `2026.4.29` and newer. The local patch chain is validated for OpenClaw `2026.5.4` via `patches/apply-openclaw-20260504-compat.sh`.

## Services

OpenClaw is normally started as a user systemd service:

```bash
systemctl --user status openclaw-gateway
systemctl --user restart openclaw-gateway
journalctl --user -u openclaw-gateway -n 200 --no-pager
```

The local production setup uses an `ExecStartPre` patch chain. `apply-memory-patches.sh` is safe to run repeatedly and must stay idempotent because OpenClaw bundle file names change between releases.

## Patch Chain

`patches/apply-memory-patches.sh` applies:

- Stuck-session abort guard.
- memory-core Cohere rerank patch.
- Retired active-memory fast-path no-op so plur1bus is not bypassed.
- Versioned plur1bus compatibility patches:
  - `apply-openclaw-20260429-compat.sh` wraps the historical `apply-plur1bus-user-hotfix.sh`.
  - `apply-openclaw-20260503-compat.sh` keeps only 2026.5.3-1 local fixes: ActiveMemory empty-result fallback, short hook budget, isolated lanes, heartbeat backpressure, non-blocking `boot-md`, non-empty hidden flush prompt and subagent announce caps.
  - `apply-openclaw-20260504-compat.sh` carries those local fixes forward for 2026.5.4 and resolves the hashed `lanes-*.js` import dynamically.
- Bundled runtime-deps race guard.

The runtime-deps guard prevents repeated `npm install` runs against the same `~/.openclaw/plugin-runtime-deps/openclaw-<version>-<hash>` directory after all required packages are already present. This avoids `ENOTEMPTY` rename failures that can otherwise stop Telegram, Discord or `memory-core` from registering.

`toolsAllow` prefiltering and `hooks.allowConversationAccess` schema support are upstream in OpenClaw `2026.5.3-1+`; the 5.3/5.4 compat patches deliberately do not reapply the old selection/pi-tools/tool-factory patches.

## Operational Risk Register

ClawSweeper findings are part of the operating state for this deployment. The `2026.5.3-1` -> `2026.5.4` gate reported 527 upstream commits, 104 findings and 180 unreviewed commits.

High findings from that gate:

- `bc0b54e`: missing beta.3 `server-close` compatibility alias. Not currently a plur1bus blocker, but keep it visible for gateway/session-close regressions.
- `b37fba7`: ClawHub publish workflow references a missing npm runtime-check script. Not runtime-critical for this host, but relevant before publishing plugin packages.

Instance-relevant medium findings:

- `59b5058`: Active Memory partial timeout recovery can still be cut off by the outer hook timeout. Keep local active-memory timeout caps and run `openclaw plugins doctor` after updates.
- `25b30c9`: bundled runtime tools may bypass narrow runtime allowlists. Keep cron and plugin allowlists explicit for sensitive jobs.
- `d253392`: explicit web providers can be filtered before restrictive allowlists widen. Recheck web provider routing after OpenClaw updates.

## Cron

The installer writes user-cron entries, not root-wide `/etc/crontab` entries:

```bash
crontab -l
```

Expected plur1bus maintenance:

- `memory-gc.mjs` daily for TTL cleanup.
- Optional migration/bridge scripts only when explicitly installed.

OpenClaw cron jobs are separate and live in:

```text
~/.openclaw/cron/jobs.json
```

For provider-specific deployments, OpenClaw cron `payload.kind == "agentTurn"` jobs may carry explicit model overrides. plur1bus does not require or change those overrides:

```bash
jq '[.jobs[] | select(.payload.kind? == "agentTurn") | {name, model:.payload.model, fallbacks:.payload.fallbacks, thinking:.payload.thinking}]' ~/.openclaw/cron/jobs.json
```

Production cron jobs that must stay on `kimi-coding/kimi-for-coding` should set `payload.fallbacks` to `[]`. Without that explicit empty list, OpenClaw may use `agents.defaults.model.fallbacks`; on this host that can route failed cron turns to a Codex model that is not supported by the active ChatGPT auth account.

## Session Start

OpenClaw stores session overrides below:

```text
~/.openclaw/agents/<agentId>/sessions/sessions.json
```

If a deployment changes chat providers, existing session entries may contain stale provider/model overrides:

```bash
jq '.sessions[]? | {id, modelProvider, model, modelOverride}' ~/.openclaw/agents/<agentId>/sessions/sessions.json
```

Historical `systemPromptReport.provider/model` fields are diagnostic metadata only, but updating them avoids misleading status/debug output after a provider migration. The plur1bus installer preserves existing session/model routing unless the user explicitly reconfigures it.

## Chat Provider Neutrality

plur1bus does not force a chat model. A deployment can use any chat provider supported by OpenClaw. Provider-specific model routing belongs to the OpenClaw agent/session/cron configuration, not to the memory plugin.

Memory-internal embeddings and optional LLM features are configured separately. Existing provider/model settings are preserved by default; fresh installs ask the user before writing memory-related provider settings.

## Native OpenClaw memorySearch

`agents.defaults.memorySearch` is OpenClaw's native workspace indexer. It is independent from plur1bus.

It is safe to disable native memorySearch when the deployment does not want OpenClaw's built-in workspace indexer:

```json
"memorySearch": {
  "enabled": false,
  "fallback": "none"
}
```

This does not disable plur1bus Auto-Recall/Auto-Capture. Those continue through `memory-lancedb-namespaced` and its configured embedding provider.

Do not switch native `memorySearch` to a local provider unless the required runtime dependency such as `node-llama-cpp` is intentionally installed and tested. Otherwise OpenClaw may add large runtime dependencies and slow gateway startup.

## Runtime-Deps Cache Repair

Check local plugin runtime dependencies. On OpenClaw `2026.5.3-1+`, `openclaw plugins deps --json` is no longer available, so validate the local dependency files directly and then run plugin diagnostics:

```bash
test -f /root/.openclaw/extensions/memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js
test -f /root/.openclaw/extensions/memory-lancedb-stock/node_modules/openai/index.js
test -f /root/.openclaw/extensions/memory-lancedb-stock/index.js
openclaw plugins doctor
```

Healthy state: all `test -f` checks pass and `plugins doctor` has no `contracts.tools` diagnostics for the local memory plugins.

If startup logs show `ENOTEMPTY` under `plugin-runtime-deps`, first ensure no `npm install` is running, then re-run the patch and restart OpenClaw:

```bash
bash ~/.openclaw/patches/apply-memory-patches.sh
systemctl --user restart openclaw-gateway
```

Avoid deleting the runtime-deps cache while OpenClaw or npm is still running.
