# Live Upgrade: OpenClaw 2026.5.12 and PLUR1BUS 3.2.0

Date: 2026-05-15 Europe/Berlin

## Verdict

Live upgrade completed.

- OpenClaw: `2026.5.7 (eeef486)` -> `2026.5.12 (f066dd2)`
- PLUR1BUS: `memory-lancedb-namespaced` `2.1.32` -> `@cyb3rb1ade/plur1bus-memory` `3.2.0`
- Gateway: active, HTTP health returns `{"ok":true,"status":"live"}`
- Backup: `/root/.openclaw-backups/pre-2026-5-12-plur1bus-3-2-0-20260515-002201`

## Safety Gates

Passed:

- Gateway was stopped before live mutation.
- Full backup was created before install work, including config, install records, extensions, and LanceDB namespaced memory.
- Obsolete `memorySearch` direct-key scan for #68664/#68685 returned no hits before and after the update.
- Provider/index preservation passed with no violations:
  - `baseDbPath` stayed `~/.openclaw/memory/lancedb-namespaced`
  - effective embedding provider stayed `openai-compatible`
  - embedding model stayed `text-embedding-3-large`
  - dimensions stayed `3072`
  - Cohere reranker config stayed `rerank-v3.5`, `candidates=20`
  - no local E5/GTE provider was activated
- Existing LanceDB dimensions were checked: 39 agent DBs matched `3072`.
- No reindex, DB deletion, DB path change, or local model migration was performed.

## Install Evidence

PLUR1BUS package checks passed:

- `node --check extensions/memory-lancedb-namespaced/index.js`
- `node --check extensions/memory-lancedb-namespaced/lib/providers/openclaw-memory-embedding-adapters.js`
- `node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js`: 11 tests passed
- `npm pack ./extensions/memory-lancedb-namespaced`: produced `cyb3rb1ade-plur1bus-memory-3.2.0.tgz`
- Tarball contained runtime files only and no `.env`, keys, model caches, review artifacts, or `/root` paths.

OpenClaw 2026.5.12 CLI note:

- `openclaw plugins install npm-pack:/tmp/...tgz` failed with `npm pack metadata read produced incomplete package metadata`.
- Direct `.tgz` install with the locally built npm-pack artifact succeeded.
- OpenClaw persisted the install as `source: "archive"` even though the artifact was produced by `npm pack`.

## Runtime Evidence

Pre-start gates passed:

- `openclaw plugins inspect memory-lancedb-namespaced --json`: pass
- `openclaw plugins inspect memory-lancedb-namespaced --json --runtime`: pass
- `openclaw plugins inspect memory-core --json --runtime`: pass
- `openclaw plugins doctor`: no hard errors
- `plugins.entries.memory-lancedb-namespaced.hooks.allowConversationAccess = true`
- `memory-core` remained configured as the memory slot owner.
- PLUR1BUS runtime kind: `extension`
- PLUR1BUS typed hooks: `agent_end`, `before_prompt_build`, `gateway_start`, `gateway_stop`
- PLUR1BUS memory embedding providers: `plur1bus-openai`, `plur1bus-openai-compatible`, `plur1bus-e5-small`
- PLUR1BUS dependency status: required and optional dependencies installed

Gateway evidence:

- `systemctl --user is-active openclaw-gateway.service`: `active`
- `ExecStartPre=/root/.openclaw/patches/apply-media-patch.sh`: exit 0
- Gateway journal showed `memory-lancedb-namespaced: registered`.
- Gateway journal showed `plur1bus-neo: service ready`.
- `curl http://127.0.0.1:18789/health`: `{"ok":true,"status":"live"}`
- `openclaw gateway probe`: WebSocket reachable and admin-capable; read probe timed out once during startup load.

## Caveats

- ClawSweeper for `2026.5.7 -> 2026.5.12` reported a large broad range: 5200 commits, 365 findings, and 1955 unreviewed. This was not treated as a clean gate. The live mitigation focused on the known #68664/#68685 config-migration hazard plus the existing PLUR1BUS 3.2 compatibility evidence.
- The systemd unit description and `OPENCLAW_SERVICE_VERSION` environment still mention `2026.5.7`, but `openclaw --version` and the running CLI are `2026.5.12`.
- Functional `memory_store` write smoke was not run; no deliberate memory write was performed during the upgrade. Provider/dimension checks and gateway runtime registration passed.
- Two old pending delivery retries failed due Telegram voice caption length. That is unrelated to the OpenClaw/PLUR1BUS upgrade.
