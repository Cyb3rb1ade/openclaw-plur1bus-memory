# PLUR1BUS — Memory plugin for OpenClaw v6 Engram

PLUR1BUS turns OpenClaw into an agent with long-term memory: a per-agent isolated LanceDB store as the source of truth, a mirrored Obsidian vault as a human-readable view, and a small set of background jobs that classify, consolidate, and (when warranted) notify.

**Version 6.0.0** — the Engram release — adds autonomous learning with explicit user control gates: semantic long-input handling, feature activation profiles, proposal-only memory merging, conflict resolution recommendations, and safety-hardened Obsidian bridge apply mode.

## What it does

Each agent gets its own LanceDB namespace under `{baseDbPath}/{agentId}/` and a matching Obsidian vault folder for browsing. The plugin captures conversation-derived memory cards automatically, runs a daily consolidator and a critical-push classifier as cron-driven background jobs, and exposes a small set of Telegram commands so the user can inspect, edit, or toggle behaviour without leaving the chat.

### New in v6

- **Semantic long-input handling** — `/memory`, `/forget`, `/correct` accept inputs of any length. No truncation, no rejection. Very long inputs (>6k chars) are semantically compressed; beyond 100k chars the user is prompted to use a file or vault source.
- **Feature activation profiles** — On first start the plugin proposes a `recommended` profile (all features active, Obsidian/reviews marked `pending_setup`). Core memory works immediately; advanced features require explicit confirmation via `featuresConfirmedAt` before they can apply changes.
- **Proposal-only merging** — The daily memory compaction job detects duplicates and generates merge proposals, but **never auto-applies**. Proposals are written to `merge-proposals.jsonl` and await explicit user approval.
- **Conflict resolver** — A lightweight background job scans for memory contradictions and emits a `recommendation` field (`"review_only"` or `"apply_via_safe_reconsolidation"`). It **never** modifies memory directly.
- **Reranker timeout & fallback** — The recall pipeline reranker has a configurable timeout (default 5s) with automatic fallback to vector-only ranking on timeout or error.
- **schicht15 deduplication** — KNOWLEDGE.md promotions are tracked per workspace+agent in persistent state. Double-promotion is prevented via `memoryId` and optional `contentHash`.
- **Obsidian bridge apply mode (safe)** — When `mode: "apply"` is confirmed, every batch creates per-file backups, a manifest (beforeHash/afterHash), and an audit-log entry. Vault path confirmation is required before the first write.
- **Rate-limited background jobs** — Daily consolidation is capped at 1×/day/agent; REM dreaming is capped at 1×/week. Configurable via `run-state.json`.

## User Commands

| Command | What it does |
| --- | --- |
| `/state` | Status snapshot: memory card count, sync state, last plausibility run, any open issues with reason + fix hint. |
| `/memory <query>` | Search the agent's memory via the same recall pipeline used by the `memory_recall` tool. Accepts queries of any length. |
| `/forget <text>` | Forget a memory card. Archive-first guarantee — the card is JSON-archived before deletion. Accepts long descriptions. |
| `/correct <old> zu <new>` | Update a memory card. Same archive-first guarantee. Accepts ` zu `, `→`, or `->` as the separator. Both old and new text can be long. |
| `/enable <feature>` | Turn on a whitelisted feature (`vaultSync`, `kritischPush`, `dailyConsolidation`). |
| `/disable <feature>` | Turn off the same. Writes atomically into `openclaw.json`; gateway restart required to apply. |
| `/plur1bus setup` | Confirm the recommended feature profile and mark all features as active (or customize which ones). Required before advanced features can apply changes. |

### `/plur1bus` subcommands

| Command | What it does |
| --- | --- |
| `/plur1bus skills review` | Show open skill proposals. |
| `/plur1bus skills approve <id>` | Approve a skill proposal. |
| `/plur1bus skills reject <id>` | Reject a skill proposal. |
| `/plur1bus skills list` | Show active skills. |
| `/plur1bus skills show <id>` | Show proposal details. |
| `/plur1bus reminders list` | List active reminders. |
| `/plur1bus reminders cancel <id>` | Cancel a reminder. |
| `/plur1bus obsidian dashboards build` | Build Obsidian dashboard pages. |
| `/plur1bus obsidian conflicts build` | Build conflict report pages. |
| `/plur1bus doctor` | Run diagnostics and show runtime status. |

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
            "mode": "augment",
            "vaultPath": "~/.openclaw/vault",
            "backupBeforeApply": true,
            "auditLog": true,
            "requireVaultPathConfirmation": true
          },
          "criticalPush": {
            "enabled": true,
            "maxPerDay": 3,
            "model": "${CRITICAL_PUSH_MODEL}"
          },
          "dailyConsolidation": {
            "enabled": true
          },
          "merging": {
            "enabled": true,
            "mode": "safe-versioned",
            "autoApply": false
          },
          "reranker": {
            "enabled": true,
            "timeoutMs": 5000,
            "fallbackOnError": true
          },
          "schicht15": {
            "enabled": true,
            "maxPromotionsPerRun": 0
          },
          "security": {
            "allowChatConfigCommands": true
          }
        }
      }
    }
  }
}
```

All paths default to `$HOME/.openclaw/...` if omitted. `OPENCLAW_CONFIG_PATH` and `OPENCLAW_HOME` env vars override the lookup of the gateway config file used by the toggle commands.

**`criticalPush.model`** — the critical-push classifier needs an OpenAI-compatible chat model to label new cards (it falls back to `merging.model` if unset). Without any chat model configured the classifier is a deliberate no-op: it does **not** label cards, so it never poisons the backlog by marking everything `fakt`.

**`security.allowChatConfigCommands`** (default `true`) — the config-mutating chat commands (`/enable`, `/disable`, `/plur1bus setup`) write `openclaw.json`. The plugin SDK does not expose the message sender's identity to command handlers, so per-user authorization isn't possible. On a **shared channel**, set this to `false` to refuse all chat-driven config changes; edit `openclaw.json` directly instead. Writes are guarded by a file lock so concurrent toggles/setups cannot clobber each other.

### Feature profile confirmation

On first start v6 warns about unconfirmed features. Core memory (capture, recall, search) works immediately. To enable advanced features (Obsidian apply mode, morning/evening reviews, merging), run:

```bash
# In Telegram
/plur1bus setup
```

This sets `featuresConfirmedAt` in the plugin state and marks features as `active`.

## Architecture

LanceDB is the authoritative store: every memory card lives there first, indexed per agent for isolation. The Obsidian bridge mirrors cards into a Markdown vault so the user can read, link, and edit them with normal tools; LanceDB stays the source of truth and the bridge re-syncs on changes.

A daily consolidation job detects duplicates and generates merge proposals (never auto-applies). A critical-push classifier (run via the OpenClaw-managed cron as `/plur1bus internal classify-recent`) labels recently captured cards by sensitive entity type (person, relationship, birthday, money/account, health, access/password) using the configured chat model, and — when a per-agent daily threshold (`maxPerDay`) is not yet exceeded — emits a short confirmation message per critical card. The plugin SDK currently exposes no outbound send API, so these messages are returned in the job result (`pushMessages`) for the cron carrier agent to deliver; once the SDK gains a reply-send hook, the same `telegramSend` path delivers them directly. The per-day counter is enforced across runs, and each card is classified exactly once, so no card is pushed twice.

The recall pipeline runs Query → Embedding → LanceDB Top-N → Importance-Boost → optional Rerank (with timeout/fallback) → Inter-Result-Dedup → Canonical-First (KNOWLEDGE.md) → Top-5 as `<relevant-memories>` injected into the prompt.

## Development

```bash
npm install
npm test              # node --test, 190+ tests
```

No build step. ESM-only. Tests are unit-level and DB-free; the LanceDB adapter is mocked behind a thin interface.

## Recall safety in v6

Recalled memories are rendered as historical evidence, not as current user requests. A memory that contains an old imperative such as a download, send, write, delete, install, purchase, network action, or command must not trigger that action unless the current visible user turn asks for the same action.

The recall block uses escaped metadata attributes and wraps recalled text in `quoted-evidence` elements, so prompt boundaries stay explicit even when old memory text contains tool-like markup.

## Migration from 5.x

Version 6.x is a major upgrade. If you ran 5.x:

- **Schema migration** — LanceDB table schema is auto-migrated on first `init()`. New columns: `status`, `versionNumber`, `previousVersion`, `supersededBy`, `updateSource`, `updateEvidence`, `reconsolidationConfidence`, `versionCreatedAt`, `updatedAt`. Migration is idempotent and non-destructive.
- **Feature confirmation required** — Advanced features now require explicit confirmation via `featuresConfirmedAt`. Run `/plur1bus setup` on first start, or manually set `featuresConfirmedAt` in the plugin state.
- **Merging is proposal-only** — `merging.autoApply` defaults to `false`. Merge candidates are written to `merge-proposals.jsonl` instead of being applied automatically. Set `autoApply: true` to restore 5.x behavior.
- **Obsidian bridge apply mode** — New `mode: "apply"` with safety gates (backups, audit log, vault path confirmation). Default is `mode: "augment"` (read-only). Confirm vault path explicitly before first write.
- **Command input handling** — Hard length limits removed. Very long inputs are semantically compressed; beyond 100k chars use a file or vault source.
- **Config keys added** — `reranker.timeoutMs`, `reranker.fallbackOnError`, `merging.autoApply`, `merging.mode`, `schicht15.maxPromotionsPerRun`, `obsidianBridge.backupBeforeApply`, `obsidianBridge.auditLog`, `obsidianBridge.requireVaultPathConfirmation`, `morningReview.status`, `eveningReview.status`.

See `v5_TO_v6_MIGRATION.md` for the full migration guide.

## Migration from 4.x

If you ran 4.x, see the 5.x release notes. The bundle approval workflow has been replaced by autonomous learning plus the critical-push classifier.

## License

MIT — see [LICENSE](./LICENSE).
