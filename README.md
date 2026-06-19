# PLUR1BUS — Memory plugin for OpenClaw

<p align="center">
  <a href="https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/releases/tag/v6.7.0"><img src="https://img.shields.io/badge/version-6.7.0-blue.svg" alt="Version 6.7.0"></a>
  <img src="https://img.shields.io/badge/license-MIT-brightgreen.svg" alt="MIT License">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js ≥ 20">
  <img src="https://img.shields.io/badge/OpenClaw-%3E%3D2026.5.12--beta.6-orange.svg" alt="OpenClaw ≥ 2026.5.12-beta.6">
  <img src="https://img.shields.io/badge/ESM-only-blueviolet.svg" alt="ESM only">
</p>

<p align="center">
  <strong>Turns every conversation into lasting knowledge.</strong><br>
  Per-agent isolated memory, Obsidian vault sync, and a full cognitive layer for OpenClaw agents.
</p>

---

## What it does

Each agent gets its own LanceDB namespace under `{baseDbPath}/{agentId}/` and a matching Obsidian vault folder for browsing. The plugin captures conversation-derived memory cards automatically, runs a daily consolidator and a critical-push classifier as cron-driven background jobs, and exposes Telegram commands so you can inspect, edit, or toggle behaviour without leaving the chat.

## Features

- **Auto-capture & recall** — conversation turns are classified and embedded automatically; recalled memories are injected into the prompt at session start
- **Per-agent isolation** — each agent writes to `{baseDbPath}/{agentId}/`; ACL prevents cross-agent leakage
- **Obsidian bridge** — live mirror of every memory card into a human-readable Markdown vault; `mode: "apply"` with per-file backups, manifests, and audit logs
- **Temporal continuity** — idle-gap detection and conversation-reactivation recall bring relevant context back after breaks or compaction
- **Semantic recall pipeline** — hybrid vector + BM25 → optional reranker → temporal filter → importance boost → dedup → canonical-first injection
- **Emotion classification** — three-tier system (regex → heuristic → LLM), budget-gated per tier with graceful fallback
- **Meta-cognition** — precision/recall/F1 computed from `/mf` feedback; coverage-gap detection; optional LLM-generated reflection report
- **Graph layers** — semantic discovery, provenance graph, managed wikilink blocks in Obsidian notes
- **Proactive nudges** — embedding-based pattern clustering with cooldown, notifies the agent about recurring topics
- **Skill mining** — extracts reusable workflow patterns from conversation history
- **Daily consolidation** — duplicate detection, merge proposals (never auto-applied for high-risk merges)
- **Morning / evening reviews** — scheduled reflection jobs
- **SoulPatch** — agent identity layer synced into the Obsidian vault
- **Full Experience defaults** — all core features enabled on fresh install; existing installs preserve configured values

See [CHANGELOG.md](./CHANGELOG.md) for per-version details.

---

## Installation

### Via ClawHub (recommended)

```bash
clawhub package install @cyb3rb1ade/plur1bus-memory
systemctl --user restart openclaw-gateway
```

### From source

```bash
git clone https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory.git \
  ~/.openclaw/extensions/memory-lancedb-namespaced
cd ~/.openclaw/extensions/memory-lancedb-namespaced
npm install --omit=dev
systemctl --user restart openclaw-gateway
```

Then complete setup in chat:

```
/plur1bus start
```

---

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
          "runtime": {
            "embeddingCacheEnabled": true
          },
          "temporalContext": {
            "enabled": true
          },
          "obsidianBridge": {
            "enabled": true,
            "mode": "apply",
            "vaultPath": "~/.openclaw/vault",
            "reviewRoot": "plur1bus",
            "backupBeforeApply": true,
            "auditLog": true,
            "requireVaultPathConfirmation": false,
            "allowDotObsidianWrite": false,
            "dashboardLayer": { "enabled": true },
            "semanticGraph": {
              "enabled": true,
              "writeDerivedEdges": true,
              "mutateMemory": false
            },
            "provenanceGraph": { "enabled": true },
            "soulPatch": {
              "enabled": true,
              "createIfMissing": true,
              "backup": true,
              "force": false,
              "migrateLegacy": false
            }
          },
          "emotion": {
            "tier": "auto",
            "t2": { "enabled": true },
            "t3": {
              "enabled": true,
              "model": "gpt-4o-mini",
              "apiKey": "${OPENAI_API_KEY}"
            }
          },
          "dailyConsolidation": { "enabled": true },
          "merging": {
            "enabled": true,
            "mode": "safe-versioned",
            "autoApply": true,
            "autoApplyRisk": "low-only",
            "backupBeforeApply": true,
            "auditLog": true
          },
          "metaCognition": {
            "enabled": true,
            "llmReport": true,
            "llmReportMode": "budgeted",
            "fallbackOnError": true
          },
          "skillMiner": { "enabled": true },
          "morningReview": { "enabled": true },
          "eveningReview": { "enabled": true },
          "reranker": {
            "enabled": true,
            "timeoutMs": 5000,
            "fallbackOnError": true
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

All paths default to `$HOME/.openclaw/...` if omitted. `OPENCLAW_CONFIG_PATH` and `OPENCLAW_HOME` env vars override the gateway config lookup.

### Notes

**`emotion.t3`** — Tier-3 needs an OpenAI-compatible chat model. Without one it falls back to Tier-2 heuristics and never poisons results by labelling everything `fakt`.

**`security.allowChatConfigCommands`** (default `true`) — `/enable`, `/disable`, `/plur1bus setup` write `openclaw.json`. On a shared channel set this to `false` and edit the config directly instead; writes are file-locked so concurrent toggles can't clobber each other.

### Full Experience policy

Fresh installs enable all PLUR1BUS core features by default. Normal updates preserve existing configured values and only add new missing core features as enabled defaults. Opt out with `/disable <feature>` or edit the config directly. To reapply the full core selection:

```
/plur1bus setup recommended --full
```

Non-interactive installs (`--non-interactive` / `--accept-defaults`) do not prompt. They preserve current values, enable missing core defaults, skip confirm-gated risky actions, and leave an operational notice asking you to run `/plur1bus start`.

---

## Commands

### Core commands

| Command | What it does |
| --- | --- |
| `/plur1bus start` | Complete installation; shows active features, safety gates, Obsidian/review/dashboard status |
| `/state` | Status snapshot: card count, sync state, last plausibility run, open issues with fix hints |
| `/memory <query>` | Search via the recall pipeline. Any length. Add `--explain` for per-result score rationale |
| `/forget <text>` | Archive-first deletion of a memory card |
| `/correct <old> zu <new>` | Update a memory card (archive-first). Accepts ` zu `, `→`, or `->` as separator |
| `/mf <id> +` / `-` / `~` | Feedback on a recall result: 👍 positive, 👎 negative, ~ neutral |
| `/share <id>` | Copy a card into the workspace-shared pool (ACL-protected) |
| `/enable <feature>` | Turn on a whitelisted feature (`vaultSync`, `kritischPush`, `dailyConsolidation`) |
| `/disable <feature>` | Turn off the same; writes atomically into `openclaw.json` |
| `/plur1bus setup` | Confirm the recommended feature profile |

### `/plur1bus` subcommands

| Command | What it does |
| --- | --- |
| `/plur1bus skills review` | Show open skill proposals |
| `/plur1bus skills approve <id>` | Approve a skill proposal |
| `/plur1bus skills reject <id>` | Reject a skill proposal |
| `/plur1bus skills list` | Show active skills |
| `/plur1bus skills show <id>` | Show proposal details |
| `/plur1bus reminders list` | List active reminders |
| `/plur1bus reminders cancel <id>` | Cancel a reminder |
| `/plur1bus obsidian dashboards build` | Build Obsidian dashboard pages |
| `/plur1bus obsidian conflicts build` | Build conflict report pages |
| `/plur1bus doctor` | Run diagnostics and show runtime status |
| `/plur1bus internal proactive-check` | Run proactive nudge detection manually |
| `/plur1bus internal meta-reflect` | Run meta-cognition reflection manually |

---

## Recall pipeline

```
Query → Embedding → LanceDB Top-N
  → Query Refinement (optional, on poor first results)
  → Temporal Filter (when time expressions detected)
  → Importance-Boost
  → Rerank (optional, with timeout/fallback)
  → Inter-Result-Dedup
  → Canonical-First (KNOWLEDGE.md)
  → ACL Filter (agent/workspace scoped)
  → Semantic Lens append (optional)
  → Conversation Reactivation Recall append (optional)
  → Top results injected into prompt
```

### Recall boosters

These run **after** normal recall. They only append results; they never replace the primary result and never write memory data.

| Booster | Default | Description |
| --- | --- | --- |
| **Semantic Lens** | `false` | Adds up to 3 community/bridge/faded memories from a precomputed index. 50 ms hard timeout. |
| **Conversation Reactivation Recall** | `false` | Appends a `<memory-reactivation>` block on idle gap / compaction signal. 50 ms hard timeout. |
| **Graph-link blocks** | config-dependent | Managed wikilink edges in Obsidian notes; regenerated, not appended. |

### Recall safety

Recalled memories are rendered as **historical evidence**, not current user requests. A memory containing an old imperative (download, send, delete, install, purchase, network action) must not trigger that action unless the current visible turn asks for it explicitly.

The recall block uses escaped metadata attributes and wraps recalled text in `quoted-evidence` elements so prompt boundaries stay explicit even when old memory text contains tool-like markup.

---

## Architecture

LanceDB is the authoritative store: every memory card lives there first, indexed per agent for isolation. The Obsidian bridge mirrors cards into a Markdown vault so you can read, link, and edit them with normal tools; LanceDB stays the source of truth and the bridge re-syncs on changes.

A daily consolidation job detects duplicates and generates merge proposals (never auto-applies high-risk or meaning-changing merges). A critical-push classifier labels recently captured cards by sensitive entity type (person, relationship, birthday, money/account, health, access/password) and — when a per-agent daily threshold is not yet exceeded — emits a short confirmation message per critical card. The per-day counter is enforced across runs; each card is classified exactly once.

### Obsidian vault tags

Memory mirrors use technical filter tags, not semantic memory tags:

```
plur1bus/memory
plur1bus/agent/<id>
plur1bus/workspace/<id>
plur1bus/category/<cat>
plur1bus/scope/<scope>
```

These are used for vault filtering and graph grouping; they carry no semantic memory content.

---

## Development

```bash
npm install
npm test              # node --test, 1,106 tests
```

No build step. ESM-only. Tests are unit-level and DB-free; the LanceDB adapter is mocked behind a thin interface.

---

## Migration from 5.x

Version 6.x is a major upgrade. If you ran 5.x:

- **Schema migration** — LanceDB table schema is auto-migrated on first `init()`. New columns: `status`, `versionNumber`, `previousVersion`, `supersededBy`, `updateSource`, `updateEvidence`, `reconsolidationConfidence`, `versionCreatedAt`, `updatedAt`. Migration is idempotent and non-destructive.
- **Feature choices are config-as-truth** — Existing `enabled: false` values stay disabled during normal updates. Missing new core features default on and can be opted out.
- **Merging auto-apply is low-risk only** — `merging.autoApply` defaults to `true` with `autoApplyRisk: "low-only"`. High-risk or meaning-changing merges remain proposals.
- **Obsidian bridge apply mode** — Default is `mode: "apply"` with managed writes, backups, manifests, audit logs, and `.obsidian` writes blocked unless explicitly allowed.
- **No vault found — bridge stays enabled but inert** — If no `vaultPath` is configured and no vault is auto-detected, the bridge activates automatically once a path is configured. No directory is created without a configured path.
- **Command input** — Hard length limits removed. Very long inputs are semantically compressed; beyond 100k chars use a file or vault source.

See [`v5_TO_v6_MIGRATION.md`](./v5_TO_v6_MIGRATION.md) for the full migration guide.

---

## License

MIT — see [LICENSE](./LICENSE).
