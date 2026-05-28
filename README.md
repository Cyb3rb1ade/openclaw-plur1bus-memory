# PLUR1BUS — Memory plugin for OpenClaw with autonomous learning + minimal user touchpoints

PLUR1BUS turns OpenClaw into an agent with long-term memory: a per-agent isolated LanceDB store as the source of truth, a mirrored Obsidian vault as a human-readable view, and a small set of background jobs that classify, consolidate, and (when warranted) notify.

## What it does

Each agent gets its own LanceDB namespace under `{baseDbPath}/{agentId}/` and a matching Obsidian vault folder for browsing. The plugin captures conversation-derived memory cards automatically, runs a daily consolidator and a critical-push classifier as cron-driven background jobs, and exposes a small set of Telegram commands so the user can inspect, edit, or toggle behaviour without leaving the chat. The original `/plur1bus_review` approval workflow has been replaced by autonomous classification with an opt-in push for sensitive entity types.

## User Commands

| Command | What it does |
| --- | --- |
| `/zustand` | Status snapshot: memory card count, sync state, last plausibility run, any open issues with reason + fix hint. |
| `/memory <query>` | Search the agent's memory via the same recall pipeline used by the `memory_recall` tool. |
| `/vergiss <text>` | Forget a memory card. Archive-first guarantee — the card is JSON-archived before deletion. |
| `/korrigier <old> zu <new>` | Update a memory card. Same archive-first guarantee. Accepts ` zu `, `→`, or `->` as the separator. |
| `/einschalten <feature>` | Turn on a whitelisted feature (`vaultSync`, `kritischPush`, `dailyConsolidation`). |
| `/ausschalten <feature>` | Turn off the same. Writes atomically into `openclaw.json`; gateway restart required to apply. |

## Installation

Drop into an OpenClaw extensions folder and restart the gateway:

```bash
git clone https://github.com/<your-org>/plur1bus.git \
  ~/.openclaw/extensions/memory-lancedb-namespaced
cd ~/.openclaw/extensions/memory-lancedb-namespaced
npm install --omit=dev
systemctl --user restart openclaw-gateway
```

Or, once published to npm:

```bash
npm install -g @cyb3rb1ade/plur1bus-memory
```

Then add a `plugins.entries["memory-lancedb-namespaced"]` block to your `openclaw.json` (see below).

## Configuration

Minimal config block in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-namespaced": {
        "enabled": true,
        "config": {
          "baseDbPath": "~/.openclaw/memory/lancedb-namespaced",
          "obsidianBridge": {
            "enabled": true,
            "vaultPath": "~/.openclaw/vault"
          },
          "criticalPush": {
            "enabled": true,
            "maxPerDay": 3
          },
          "dailyConsolidation": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

All paths default to `$HOME/.openclaw/...` if omitted. `OPENCLAW_CONFIG_PATH` and `OPENCLAW_HOME` env vars override the lookup of the gateway config file used by the toggle commands.

## Architecture

LanceDB is the authoritative store: every memory card lives there first, indexed per agent for isolation. The Obsidian bridge mirrors cards into a Markdown vault so the user can read, link, and edit them with normal tools; LanceDB stays the source of truth and the bridge re-syncs on changes. A daily consolidation job merges duplicates and tightens summaries; a critical-push classifier scans new cards for sensitive entity types (health markers, security topics, financial entities) and — when a per-agent daily threshold is not yet exceeded — pushes a short notification to the user's Telegram so important context is never silently buried.

## Development

```bash
npm install
npm test              # node --test, 74 tests
```

No build step. ESM-only. Tests are unit-level and DB-free; the LanceDB adapter is mocked behind a thin interface.

## Migration from 4.x

Version 5.0.0 is a rewrite. If you ran 4.x:

- Old commands `/plur1bus_review`, `/plur1bus_morning`, `/plur1bus_evening` are gone. The bundle approval workflow has been replaced by autonomous learning plus the critical-push classifier.
- Config keys removed: `autoApplyLowRisk`, `reviewProfiles`, `bundleCooldownMs`, the entire `review` block. Remove them before restart; the plugin ignores unknown keys but they will no longer have any effect.
- Cron jobs `morning-review` and `evening-review` are gone. Replace them with the three new families: `daily-memory-consolidation-*`, `critical-memory-classifier-*`, `auto-accept-stale-criticals-*`.
- Pending review bundles from 4.x are moved to `/plur1bus/_archive/` on first startup and are not surfaced again. Apply or discard them via the vault before deletion.
- The vault layout changed. User-readable cards now live under `/memory/cards/YYYY/MM/<date>-<slug>.md`. Bot internal state moves to `/sys/` and is not synced. Update your Syncthing `.stignore` to allowlist `/memory`, `/decisions`, `/people`, `/projects` and deny everything else.

## License

MIT — see [LICENSE](./LICENSE).
