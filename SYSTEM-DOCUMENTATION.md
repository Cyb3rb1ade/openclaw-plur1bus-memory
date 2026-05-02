# System Documentation

Operational notes for plur1bus on OpenClaw `2026.4.29` and newer.

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
- `apply-plur1bus-user-hotfix.sh` for OpenClaw `2026.4.29` prompt/tool/subagent/heartbeat regressions.
- Bundled runtime-deps race guard.

The runtime-deps guard prevents repeated `npm install` runs against the same `~/.openclaw/plugin-runtime-deps/openclaw-<version>-<hash>` directory after all required packages are already present. This avoids `ENOTEMPTY` rename failures that can otherwise stop Telegram, Discord or `memory-core` from registering.

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

For Kimi-only deployments, every OpenClaw cron `payload.kind == "agentTurn"` should set:

```json
"model": "kimi-coding/kimi-for-coding"
```

## Session Start

OpenClaw stores session overrides below:

```text
~/.openclaw/agents/<agentId>/sessions/sessions.json
```

If a deployment is Kimi-only, existing session entries should be migrated to:

```json
{
  "modelProvider": "kimi-coding",
  "model": "kimi-for-coding",
  "modelOverride": "kimi-for-coding"
}
```

Historical `systemPromptReport.provider/model` fields are diagnostic metadata only, but updating them avoids misleading status/debug output after a provider migration.

## Kimi-only / No Fallback

plur1bus does not force a chat model. A deployment can use OpenAI, Kimi, Claude-compatible providers, local providers or a strict Kimi-only policy.

Strict Kimi-only policy means:

- `agents.defaults.model.primary = "kimi-coding/kimi-for-coding"`.
- `agents.defaults.model.fallbacks = []`.
- Every `agents.list[]` model is the same object-form primary with empty fallbacks.
- Every cron `agentTurn` payload uses `kimi-coding/kimi-for-coding`.
- Existing session overrides are migrated.
- No automatic fallback to other chat providers is configured.

`active-memory` may run Kimi instant mode (`thinking: "off"`) to reduce latency and cost. That changes Kimi execution mode, not the provider.

## Native OpenClaw memorySearch

`agents.defaults.memorySearch` is OpenClaw's native workspace indexer. It is independent from plur1bus.

For Kimi-only/no-OpenAI-token setups, it is safe to disable native memorySearch:

```json
"memorySearch": {
  "enabled": false,
  "fallback": "none"
}
```

This does not disable plur1bus Auto-Recall/Auto-Capture. Those continue through `memory-lancedb-namespaced` and its configured embedding provider.

Do not switch native `memorySearch` to a local provider unless the required runtime dependency such as `node-llama-cpp` is intentionally installed and tested. Otherwise OpenClaw may add large runtime dependencies and slow gateway startup.

## Runtime-Deps Cache Repair

Check bundled plugin runtime dependencies:

```bash
openclaw plugins deps --json
```

Healthy state:

```json
{
  "missing": [],
  "conflicts": []
}
```

If startup logs show `ENOTEMPTY` under `plugin-runtime-deps`, first ensure no `npm install` is running, then re-run the patch and restart OpenClaw:

```bash
bash ~/.openclaw/patches/apply-memory-patches.sh
systemctl --user restart openclaw-gateway
```

Avoid deleting the runtime-deps cache while OpenClaw or npm is still running.
