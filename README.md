# PLUR1BUS — Memory plugin for OpenClaw v6 Engram

PLUR1BUS turns OpenClaw into an agent with long-term memory: a per-agent isolated LanceDB store as the source of truth, a mirrored Obsidian vault as a human-readable view, and a small set of background jobs that classify, consolidate, and (when warranted) notify.

**Current version: 6.8.12** — Publishes the verified 6.8.11 security-hardening line with refreshed docs, lockfile/manifest alignment, and ClawHub source metadata. See [CHANGELOG](CHANGELOG.md) for full history.

## What it does

Each agent gets its own LanceDB namespace under `{baseDbPath}/{agentId}/` and a matching Obsidian vault folder for browsing. The plugin captures conversation-derived memory cards automatically, runs a daily consolidator and a critical-push classifier as cron-driven background jobs, and exposes a small set of Telegram commands so the user can inspect, edit, or toggle behaviour without leaving the chat.

### New in v6.8.x — Code-review hardening

- **i18n sync** — 752 missing translation keys added for new OpenClaw channel wizards (IRC, Feishu, NextcloudTalk, Google Chat).
- **TypeScript optional dep** — `typescript` is now declared as an `optionalDependency` so the code-index feature works out of the box without forcing TS on all users.
- **Installer fixes** — `buildInstallLogEvent` now correctly passes `featureMode` instead of hardcoding `"preserve"`; dry-run vs. remote-target warnings are properly distinguished; dead code removed.
- **Installer performance** — 9 sequential `jq` subprocess calls consolidated into batch `eval`+`@sh` extracts.
- **Neo worker drain** — Missing `await` on `drainEmbeddingQueue()` caused the unresolved Promise to be serialised as `{}` in `postMessage`; callers now receive correct drain results.
- **Auto-capture robustness** — `statSync` race condition fixed (file deleted between `readdirSync` and `statSync`); `addQueryVector` null-return guard added.
- **ts-source-indexer** — O(n) `symbols.find()` in AST visitor replaced with a `Map` for O(1) lookup.
- **Manifest sync** — `openclaw.plugin.json` version aligned with `package.json`.
- **Security hardening** — `scope: "user"` writes now require an authenticated user identity (`user` scope is owner-bound) and are filtered in recall/visibility checks.

### New in v6.8.0 — Release readiness, code context, and runtime packaging

- **Media diarization context** — Async diarization merge pipeline, manual speaker mapping, contextual speaker-name proposals, and no biometric enrollment.
- **Emotional-state injector packaged** — Tracked `.openclaw/extensions/emotional-state-injector/` files are included in the npm tarball; runtime activation still requires the OpenClaw plugin entry/allow config and a gateway restart.
- **Performance follow-up** — Legacy auto-capture duplicate checks are batched, duplicate lookup can use ANN multi-query search when available, JSON hot-path writes are queued asynchronously, and high-cost prompt work is narrowed.
- **Optional code index** — Local JS/TS index generation writes `.plur1bus/code-index.json` and can render bounded `<code-context>` query output.

### Experimental code index

PLUR1BUS can build a local JS/TS code index without CocoIndex:

```bash
npm run code-index -- /path/to/workspace
npm run code-index -- /path/to/workspace --query "/plur1bus code-index"
```

The index is written to `.plur1bus/code-index.json` and contains normalized files, symbols, import/call/register edges, and symbol chunks. `--query` prints a bounded `<code-context>` block from the generated index. It uses the TypeScript Compiler API through the optional `typescript` dependency and keeps the PLUR1BUS schema independent of the parser implementation.

### New in v6.7.x — Multi-Namespace, Temporal Continuity & Source Sync

- **Multi-Namespace Pool** — Each agent gets its own isolated LanceDB namespace; cross-agent recall stays opt-in.
- **Temporal Continuity Context** — Auto-injected time-anchor block lets the agent orient itself after gaps or compactions without hallucinating dates.
- **Conflict Summary Management** — Contradiction detector now emits structured conflict summaries; `/plur1bus obsidian conflicts build` renders them as Obsidian pages.
- **`/plur1bus start` onboarding** — Single command walks new users through feature-profile confirmation and vault setup.
- **Auto-capture schema sync** — `scripts/auto-capture-lancedb.mjs` gains `workspaceKey` field; schema migration is backward-compatible and idempotent.
- **Internal-turn skip guard** — `shouldSkipAutoRecallForInternalTurn` prevents feedback loops when the gateway injects synthetic cron messages.

### New in v6.6.0 — Meta-Cognition

- **Self-reflection on recall quality** — Precision, Recall, F1 computed from user feedback (`/mf +/-/~`). Coverage-gap detection finds topics with few or weak memories.
- **Threshold-based reflection trigger** — Auto-runs when `sessionThreshold` (default: 50) or `intervalDays` (default: 7) is reached. Optional LLM-generated natural-language report.
- **Persistent state** — Reflection state stored in `_meta-cognition-state.json` per workspace.

### New in v6.5.0 — Proactive Nudges

- **Embedding-based pattern detection** — Clusters similar turns by cosine similarity over embedding centroids.
- **Cluster persistence** — Clusters survive restarts, stored per workspace/agent.
- **Cooldown mechanism** — Rate-limited to avoid spam (default: 24h per workspace).
- **Configurable thresholds** — `minClusterSize`, `similarityThreshold`, `maxNudgesPerDay`.

### New in v6.4.0 — Emotion Tier-Config

- **Budget-Gate per tier** — Tier-1 (regex), Tier-2 (heuristic), Tier-3 (LLM) independently enable/disable.
- **Configurable model per tier** — Use `gpt-4o-mini` for Tier-3 or bring your own via `baseUrl`/`apiKey`.
- **Feature-Toggle** — Lock `emotionTier` to a specific tier or use `auto` for dynamic escalation.
- **Graceful degradation** — Falls back from Tier-3 to Tier-2 when no API key is available.

### New in v6.3.0 — Explainability & GC

- **Explainability** (`--explain` flag for `/memory`) — Human-readable rationale per result: score breakdown, boost factors, temporal relevance.
- **Garbage Collection job** — Background cleanup of expired/stale memories with configurable retention policies.
- **Feedback Analyzer** — Background analysis of `/mf` feedback for recall-quality improvement.

### New in v6.2.0 — Correction-as-Recall

- **`/correct` treated as recall event** — After `safeUpdate()` inserts the corrected card, `applyRetrievalReinforcement` refreshes `lastRetrievedAt`, increments `retrievalCount`, and boosts `memoryStrength`.
- **Null guard** — If `getById(newId)` races or fails, reinforcement is silently skipped; the correction itself is never rolled back.

### New in v6.1.4 (Consolidation)

- **ACL / Access Control** — Agent- and workspace-scoped memory access. `searchByTopic`, `getCard`, and recall pipeline filter by ACL. Unauthorized access is logged.
- **Feedback loop (`/mf`)** — Thumbs-up/down/neutral feedback on any memory result. Persisted per workspace.
- **Temporal reasoning** — Queries like "last month", "3 days ago", "Q2 2026" parsed to concrete date ranges before boost/rerank.
- **Collaborative memory (`/share`)** — Copy any card into a workspace-shared pool with ACL protection.
- **Query refinement** — Automatic query rewrite on poor first results, merged and deduplicated.

### New in v6.1.2 (Engram — Recall Hardening)

- **Recall hardening** — `maxPromptMemories` (default 12), dedup threshold 0.78, acronym recognition, `canonicalMaxItems` (default 5).
- **Typ-based half-life** — `halfLifeDaysMap`: transient (60d), episodic (180d), longContext/project (600d).
- **Performance** — LRU+TTL embedding cache, semantic recall compression, adaptive recall tiers, graph-index traversal, reinforcement loop.
- **Security** — SQL-escaping, ACL hardening for destructive commands, path-traversal protection, filter-parser injection resistance.

### New in v6 (Base)

- **Semantic long-input handling** — `/memory`, `/forget`, `/correct` accept any length. >6k chars are semantically compressed; >100k chars prompts for file/vault source.
- **Feature activation profiles** — On first start proposes a `recommended` profile (all features active, Obsidian/reviews marked `pending_setup`). Core memory works immediately; advanced features require explicit confirmation.
- **Proposal-only merging** — Daily compaction detects duplicates, generates merge proposals in `merge-proposals.jsonl`, **never auto-applies**.
- **Conflict resolver** — Scans for contradictions, emits `recommendation` (`review_only` or `apply_via_safe_reconsolidation`), **never modifies** memory directly.
- **Reranker timeout & fallback** — Configurable timeout (default 5s) with automatic fallback to vector-only ranking.
- **schicht15 deduplication** — KNOWLEDGE.md promotions tracked per workspace+agent. Double-promotion prevented via `memoryId` + optional `contentHash`.
- **Obsidian bridge apply mode (safe)** — `mode: "apply"` creates per-file backups, manifest (beforeHash/afterHash), and audit-log entry. Vault path confirmation required before first write.
- **Rate-limited background jobs** — Daily consolidation capped at 1×/day/agent; REM dreaming at 1×/week.

## Recall boosters (additive)

These features run **after** normal recall and only append results; they never replace the primary recall result and never write memory data.

### Semantic Lens

Reads a precomputed `.plur1bus/semantic-lens-index.json` from the workspace and adds a small number of community/bridge/faded memories that normal recall may have missed.

- Default: `enabled: false` in schema.
- Caps: `maxLensMemories: 3`, `maxBridgeMemories: 2`, `maxFadedMemories: 1`, `maxCommunities: 2`.
- Hard timeout: 50 ms; fallback returns base recall unchanged.
- No live graph recompute, no second recall path, no writes.

### Conversation Reactivation Recall (CRR)

MVP reactivation hook that appends a `<memory-reactivation>` block when a conversation appears to resume after an idle gap, a compaction, or a continuation signal.

- Default: `enabled: false` in schema; `visibleHints: false`.
- Triggers: idle threshold (45 min), continuation signal, first substantive message, or post-compaction gap.
- Caps: `maxReactivationMemories: 3`, `maxFadedReactivationMemories: 1`, `maxOpenThreads: 3`, `maxCommunities: 2`.
- Hard timeout: 50 ms; silent fallback on error.
- State is module-level in-memory only; no writes to cards, tags, graph links, records, or quarantine.

### Graph-link managed blocks / semanticDiscovery

Record notes can contain an idempotent managed block (`id="graph-links"`) with wikilink edges. The block is regenerated, not appended, and conflicts with manual edits are reported.

- Tiers: `explicit` (memoryIds/sourceRefs), `type` (type-based rules), `semantic` (precomputed link index).
- Default semantic threshold: 0.78.
- `semanticDiscovery` builds `.plur1bus/link-index.json` from memory mirrors + vectors behind a confirmation gate; it is not auto-applied.

### Technical frontmatter tags

Memory mirrors use technical filter tags, not semantic memory tags:

- `plur1bus/memory`
- `plur1bus/agent/<id>`
- `plur1bus/workspace/<id>`
- `plur1bus/category/<cat>`
- `plur1bus/scope/<scope>`

These tags are used for vault filtering and graph grouping; they do not carry semantic memory content.

## User Commands

| Command | What it does |
| --- | --- |
| `/state` | Status snapshot: memory card count, sync state, last plausibility run, any open issues with reason + fix hint. |
| `/memory <query>` | Search the agent's memory via the recall pipeline. Accepts queries of any length. Add `--explain` for result rationale. |
| `/forget <text>` | Forget a memory card. Archive-first guarantee — the card is JSON-archived before deletion. |
| `/correct <old> zu <new>` | Update a memory card. Archive-first guarantee. Accepts ` zu `, `→`, or `->` as separator. |
| `/mf <id> +` / `-` / `~` | Feedback on a memory result: 👍 positive, 👎 negative, ~ neutral. Persisted per workspace. |
| `/share <id>` | Copy a memory card into the workspace-shared pool. ACL-protected. |
| `/enable <feature>` | Turn on a whitelisted feature (`vaultSync`, `kritischPush`, `dailyConsolidation`). |
| `/disable <feature>` | Turn off the same. Writes atomically into `openclaw.json`; gateway restart required. |
| `/plur1bus setup` | Confirm the recommended feature profile. Required before advanced features can apply changes. |

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
| `/plur1bus internal proactive-check` | Run proactive nudge detection manually. |
| `/plur1bus internal meta-reflect` | Run meta-cognition reflection manually. |

## Installation

Drop into an OpenClaw extensions folder and restart the gateway:

```bash
git clone https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory.git \
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
          "emotion": {
            "tier": "auto",
            "t2": { "enabled": true },
            "t3": {
              "enabled": true,
              "model": "gpt-4o-mini",
              "apiKey": "${OPENAI_API_KEY}",
              "escalationConfidence": 0.85,
              "timeoutMs": 4000
            },
            "moodInfluence": 0.3,
            "intensityHalfLifeFactor": 1.0,
            "temperaments": {
              "bernhardine": { "preset": "warm", "baseline": { "joy": 0.35, "trust": 0.5 }, "sensitivity": 1.5, "decayMultiplier": 1.3 }
            }
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
          "security": {
            "allowChatConfigCommands": true,
            "allowModelDestructiveMemoryOps": true,
            "allowedUserIds": [],
            "allowedChatIds": []
          },
          "runtime": {
            "embeddingCacheEnabled": true,
            "embeddingCacheMaxEntries": 128,
            "embeddingCacheTtlMs": 300000,
            "embeddingCacheScope": "agent"
          }
        }
      }
    }
  }
}
```

All paths default to `$HOME/.openclaw/...` if omitted. `OPENCLAW_CONFIG_PATH` and `OPENCLAW_HOME` env vars override the lookup of the gateway config file used by the toggle commands.

**`emotion.t3`** — the tier-3 emotion classifier needs an OpenAI-compatible chat model. Without any chat model configured the classifier falls back to Tier-2 heuristics: it does **not** label cards, so it never poisons results by marking everything `fakt`.

**`emotion.temperaments`** — per-agent emotional temperament. Ships with generic defaults only (`main` slightly more sensitive, everyone else balanced). Pick a preset via `/plur1bus temperament <preset>` (`ausgewogen`, `warm`, `kühl`, `feurig`, `stoisch`) — requires a gateway restart. Mood always derives from conversation content; the temperament only shapes how strongly and how long it swings. The current mood is written to `.emotional-state.json` (machine-readable, survives restarts) and `.current-mood.txt` (human-readable) in the agent workspace, injected as a mood line into the recall context, stamped on every memory card (`moodContextAtCapture`), and emotionally intense memories decay slower (`intensityHalfLifeFactor`).

**`security.allowedUserIds` / `security.allowedChatIds`** — identity-aware authorization for commands and destructive flows.
- If both lists are empty, non-destructive commands can run in private 1:1 contexts; destructive commands are denied in groups/unknown channels.
- If either list is configured, destructive commands require `userId` membership in `allowedUserIds` (chatId alone is never sufficient), plus `allowedChatIds` when that list exists.
- Whitelists remain stable with `/enable`, `/disable`, `/plur1bus setup`, `/forget`, `/correct` and confirmation flows.

**`security.allowChatConfigCommands`** (default `true`) — disables operator-level config mutating commands (`/enable`, `/disable`, `/plur1bus setup`) when set to `false`. Use this in shared channels if you want a hard stop on chat-driven writes. Writes are still guarded by a file lock.

**`security.allowModelDestructiveMemoryOps`** (default `true`) — keeps model-facing tools `memory_forget` and `knowledge_update` available unless you explicitly disable them.

### Scope-sichere Speicherung

`scope` values now support `agent-private` (default), `workspace` and `user`.
- `agent-private` remains per-agent.
- `workspace` shares by workspace.
- `user` is owner-bound: der aufrufende `userId` wird gespeichert und bei Sichtbarkeit/Mutation geprüft.

**`security.allowModelDestructiveMemoryOps`** (default `true`) — the model-facing tools `memory_forget` and `knowledge_update` mutate persistent memory/knowledge state. Set this flag to `false` if you want a hard opt-out for model-driven destructive memory writes.

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

The recall pipeline runs Query → Embedding → LanceDB Top-N → **Query Refinement** (optional, on poor first results) → **Temporal Filter** (when time expressions detected) → Importance-Boost → optional Rerank (with timeout/fallback) → Inter-Result-Dedup → Canonical-First (KNOWLEDGE.md) → **ACL Filter** (agent/workspace scoped) → optional **Semantic Lens** append → optional **Conversation Reactivation Recall** append → Top results injected into the prompt.

## Development

```bash
npm install
npm test              # node --test, 1,931 tests
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
- **Config keys added** — `reranker.timeoutMs`, `reranker.fallbackOnError`, `merging.autoApply`, `merging.mode`, `obsidianBridge.backupBeforeApply`, `obsidianBridge.auditLog`, `obsidianBridge.requireVaultPathConfirmation`, `morningReview.status`, `eveningReview.status`, `emotion.tier`, `emotion.t2.enabled`, `emotion.t3.enabled`, `emotion.t3.model`, `emotion.t3.apiKey`, `emotion.t3.escalationConfidence`, `emotion.t3.timeoutMs`, `emotion.moodInfluence`, `emotion.intensityHalfLifeFactor`, `emotion.temperaments.<agentId>`.

See `v5_TO_v6_MIGRATION.md` for the full migration guide.

## License

MIT — see [LICENSE](./LICENSE).
