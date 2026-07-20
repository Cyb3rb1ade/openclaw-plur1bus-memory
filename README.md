# PLUR1BUS — Memory plugin for OpenClaw

PLUR1BUS turns OpenClaw into an agent with long-term memory: a per-agent isolated LanceDB store as the source of truth, a mirrored Obsidian vault as a human-readable view, and a small set of background jobs that classify, consolidate, and (when warranted) notify.

**Current version: 7.0.0** — Publishes the humanization line through the GitHub tag `v7.0.0`; the package metadata and manifest are aligned to `7.0.0`. See [CHANGELOG](CHANGELOG.md) for full history.

## What it does

Each agent gets its own LanceDB namespace under `{baseDbPath}/{agentId}/` and a matching Obsidian vault folder for browsing. The plugin captures conversation-derived memory cards automatically, runs a daily consolidator and a critical-push classifier as cron-driven background jobs, and exposes a small set of Telegram commands so the user can inspect, edit, or toggle behaviour without leaving the chat.

### New in v7.0.0 — Humanization: persona voice, afterthoughts, dream echoes

- **Persona voice with auto-applied evolution** — each agent gets a seeded idiolect as a managed workspace block; the weekly `persona-evolve` job now applies refinements directly (bounded: 12-bullet cap, seed-end boundary) instead of the old propose/accept flow.
- **Afterthoughts & dream echoes** — delayed follow-ups after open-ended conversations and nightly-dream surfacing on first daily contact, both budgeted by a shared adaptive proactive governor.
- **Recall confidence hedging & style directives** — uncertain recall is phrased as uncertain; mood, opinion, ask-back, and timezone-aware time-of-day directives shape replies.
- **Multi-agent feature-cron automation** — bound agents automatically get `persona-evolve`/`afterthought` cron pairs via postinstall, `/plur1bus setup crons`, doctor hint, or deferred gateway-start bootstrap.
- **Telegram reaction rules (managed block)** — AGENTS.md files with reaction guidance get the fixed Telegram reaction set plus current-`message_id` targeting rules patched in automatically.
- **Afterthought `NO_REPLY` contract** — skip runs reply with OpenClaw's silent token; existing crons are migrated automatically.

### New in v6.9.10 — Maintenance progress and dedupe hardening

- **Candidate status updates survive content dedupe** — promote/demote/prune/tombstone updates are append-preserved while ordinary candidate captures remain content-deduped.
- **Capped memory dynamics are resumable** — retrieval-ledger caps store partial entry progress, and daily decay rotates with a persisted cursor instead of repeatedly touching the first rows.
- **LanceDB vector wrappers normalize safely** — Arrow-style vector wrappers are converted before update writes to avoid schema failures during consolidation.

### New in v6.9.x — Runtime fixes, cron provisioning, and emotional dynamics

- **REM-Dream cron provisioning** — New installs now provision the `rem-dream` cron job correctly instead of shipping the handler without a scheduler binding.
- **`/state` command fix** — The top-level status command no longer crashes on an out-of-scope `ctx` reference.
- **Emotion config-schema sync** — The strict schema now accepts the documented emotional-dynamics keys used by 6.9.x configs.
- **Generic temperament defaults** — Shipped defaults no longer bake in agent-specific personalities; per-agent temperament belongs in user config.
- **Emotional dynamics** — Mood persistence, temperament presets, decay modulation, and stronger mood-congruent recall boosts landed in the 6.9.0 line.

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
- **`/plur1bus start` onboarding** — Read-only status and onboarding guidance for feature profiles and vault setup.
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
- **Configurable model per tier** — An absent model uses the effective OpenClaw agent model; `gpt-4o-mini` is only an explicit override example.
- **Feature-Toggle** — Lock `emotionTier` to a specific tier or use `auto` for dynamic escalation.
- **Graceful degradation** — Falls back from Tier-3 to Tier-2 when neither a native OpenClaw route nor a complete direct override is available.

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
| `/plur1bus setup` | List the available profile choices without changing configuration. |
| `/plur1bus setup safe` | Explicitly apply the Safe profile; core capture/recall stays usable and additional mutators remain off. |
| `/plur1bus setup recommended` | Explicitly apply Recommended while preserving existing opt-outs and write-safety gates. |
| `/plur1bus start` | Show read-only status and onboarding guidance; it does not change configuration. |

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
| `/plur1bus internal afterthought` | Run the delayed follow-up job manually (see below). |

### Afterthoughts (delayed follow-ups)

When the last conversation ended 30–120 minutes ago with an open outcome (the user asked for details, or the topic was dropped mid-thread), the plugin can compose a short, casual follow-up message ("Mir ist zu … noch eingefallen…"). This is gated by the shared proactive governor budget, capped at one per day, and skipped for any topic already surfaced as an open thread today. Recommended cron: every 30 minutes, run `/plur1bus internal afterthought` and deliver the result — if the JSON has a `text` field, send exactly that text as the message; if `skipped` is `true`, reply with exactly `NO_REPLY` (OpenClaw's silent-reply token — the gateway suppresses delivery of token-only replies, which is far more reliable than asking the model to output nothing).

Setting this cron up (plus the weekly `persona-evolve` cron) is automatic on multi-agent installations — see below.

#### Multi-agent feature-cron automation

`node scripts/setup-feature-crons.mjs` discovers every **bound** agent on the installation via `openclaw agents list --json` and plans a `persona-evolve` + `afterthought` cron pair for each one — zero manual follow-up needed after adding a new agent, even with dozens of subagents configured. The script is idempotent and exit-0 no matter what (missing CLI, unreachable gateway, partial failures — all best-effort, all safe to re-run), so it can run from any of these channels:

- **`npm install`/`npm postinstall`** — fires when the plugin is installed via `npm install` (e.g. `npm install -g @cyb3rb1ade/plur1bus-memory`).
- **Gateway startup (deferred bootstrap)** — a `gateway_start` handler in `index.js` schedules a one-off, non-blocking run 90 seconds after every gateway start (long enough for the `openclaw` CLI to be able to talk to the now-running gateway). This is the channel that actually covers the *documented* install path (`git clone` + `rsync` into `~/.openclaw/extensions/...`, which never runs `npm install`) as well as ClawHub installs, whose lifecycle hooks aren't guaranteed to run `npm` either — so it's the one channel that's install-method-agnostic. Throttled to at most once per ~20h (tracked via the same marker file the doctor/status hint reads, `.feature-crons-setup.json` under `baseDbPath`) so a gateway that restarts frequently doesn't repeatedly re-spawn the setup script; a plugin version bump forces an earlier re-run. Disable with `"featureCronSetup": { "auto": false }` in the plugin config.
- **Manual** — `/plur1bus setup crons` (optionally `--agent <id>`/`--account <acct>` to force single-agent mode).

The `/plur1bus doctor` and `/plur1bus status` feature-cron hint is **condition-derived**, not "have we shown this before": it reads the marker file and only surfaces a hint when setup has never run, ran under an older plugin version, or ran but couldn't create everything it planned (some crons are still pending — e.g. no delivery target could be derived). It's silent once a current-version run reports nothing left to create.

- **Bound-agent rule**: only agents with `bindings > 0` (i.e. an actual chat channel routes to them) get feature crons. Subagents (`bindings === 0` — researchers, deep-divers, and other internal-use-only agents) are deliberately excluded; they have no chat to receive an automatic persona evolution or an afterthought delivery, and running these jobs against them would be pure compute waste.
- **One agent per workspace**: PLUR1BUS state for these jobs (persona voice, proactive-governor budget, afterthought dedup state, …) is keyed by workspace directory, not agent id. If two bound agents share a workspace, only one gets the crons (tiebreak: `isDefault` first, then most bindings, then alphabetically-first id) to avoid two crons double-firing against the same state files.
- **Per-agent job names**: `plur1bus persona-evolve <agentId>` and `plur1bus afterthought <agentId>`, each running with `--agent <agentId>`. `persona-evolve` schedules are staggered 5 minutes apart per agent (starting Sunday 04:15) so N agents' weekly evolution jobs don't all fire at the same instant.
- **Delivery derivation for `afterthought`**: the setup script looks at each agent's *other* existing crons for a delivery target (`delivery.mode !== "none"` with a `to`), preferring jobs already named `plur1bus …`. If every candidate target agrees on channel + destination, the new `afterthought` cron is created **enabled**, delivering to that same target. If targets conflict, or the agent has no delivery-capable crons yet, it's created **disabled** with a hint showing the exact `openclaw cron edit`/`enable` commands to wire delivery manually — it never guesses or delivers to nobody.
- **Legacy installs**: a pre-multi-agent, non-suffixed `plur1bus persona-evolve` / `plur1bus afterthought` job (from an earlier version of this plugin) is treated as already satisfying the default agent's spec — it's left alone, not duplicated, when you upgrade.
- **Fallback**: if `openclaw agents list --json` fails, is unparseable, or yields no bound agents, the script falls back to the previous single-default-agent behavior (prints a note) — the exit-0, never-fail-an-install contract holds either way. Passing `--agent <id>`/`--account <acct>` explicitly always forces single-agent mode, same semantics as before.

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

Minimal config block in `openclaw.json`. This is an explicit override example:
the named `gpt-4o-mini` value and its credential are illustrative user choices,
not PLUR1BUS defaults.

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
            "embeddingCacheScope": "agent",
            "llmResultCacheEnabled": true,
            "llmResultCacheTtlMs": 86400000,
            "llmResultCacheMaxEntries": 256,
            "llmResultCachePersist": false,
            "llmResultCacheMaxBytes": 67108864,
            "llmResultCacheMetrics": true
          }
        }
      }
    }
  }
}
```

All paths default to `$HOME/.openclaw/...` if omitted. `OPENCLAW_CONFIG_PATH` and `OPENCLAW_HOME` env vars override the lookup of the gateway config file used by the toggle commands.

### OpenClaw chat-LLM routing

Chat models are selected per owning feature. If an optional feature `model` is
absent, PLUR1BUS uses the effective OpenClaw agent model and sends no `model`
property. Features never inherit `merging.model`, its endpoint, credential, or
headers. Existing feature/profile activation, budgets, confirmation gates,
rate limits, and fail-soft behavior remain unchanged; Safe produces zero
PLUR1BUS native/direct chat calls.

The four selection modes are `openclaw-default` (native with no model),
`openclaw-override` (feature-local model through OpenClaw), `direct-override`
(feature-local model plus direct transport), and `unavailable`. `failed` is the
stable diagnostic outcome when a selected transport rejects. Provider/model
metadata returned by OpenClaw may be recorded without credentials, prompts, or
headers. Native routes bypass the PLUR1BUS result cache; complete direct routes
retain exact caching.

Direct transport without a feature-local model fails closed and sends no
request. A configured credential that is unresolved is unavailable; it never
falls through to native OpenClaw host credentials and does not abort plugin
registration. `runtime.llm.complete` missing or unavailable is fail-soft and
does not select a hard-coded model.

A session-bound command capability omits `agentId`. Global hook, tool, and
background calls retain the target agent and require entry-level
`llm.allowAgentIdOverride:true`. A model-only native override requires
`llm.allowModelOverride:true` and obeys `allowedModels`. Installer `preserve`
never grants LLM trust, and neither Safe nor Recommended adds those entry-level
bits.

`runtime.llm.complete` resolves the effective primary selection and does not
execute the configured model fallback array in the installed runtime. PLUR1BUS
neither claims nor emulates a host fallback chain.

### LLM result cache

PLUR1BUS caches only exact, agent-scoped results from an explicit allowlist of deterministic internal LLM transformations. The default in-memory cache uses a 24-hour absolute TTL (`llmResultCacheTtlMs: 86400000`, clamped to 60 s–7 d) and holds 256 entries per plugin registration (`llmResultCacheMaxEntries`, clamped to at most 10,000). Optional prompt-free SQLite persistence is off by default; when enabled with `llmResultCachePersist`, it stores hashed keys, results, usage metadata, and timestamps under the memory database path without storing plaintext prompts, credentials, or headers. `llmResultCacheMaxBytes` defaults to 67,108,864 bytes and is clamped to at most 1 GiB; clamped values log a warning.

The six runtime settings are `llmResultCacheEnabled` (default `true`), `llmResultCacheTtlMs` (default `86400000`), `llmResultCacheMaxEntries` (default `256`), `llmResultCachePersist` (default `false`), `llmResultCacheMaxBytes` (default `67108864`), and `llmResultCacheMetrics` (default `true`). Missing values come from the manifest; an explicit `false` remains authoritative.

Operational notes:

- Persistence requires Node ≥ 22.5 for the built-in `node:sqlite` module; on older Node versions the cache transparently falls back to memory-only.
- Persistence stores LLM response text as plaintext (directory `0o700`, file `0o600` under the memory database path). Responses may contain condensed memory content — enable persistence only where that is acceptable.
- Integrated call sites send `temperature: 0` for determinism, and `llm-call.js` now actually forwards `temperature` to the provider (previously the setting was silently ignored). Existing configs that set `temperature` therefore change their effective provider behavior.

Non-goals and bypasses:

- Ordinary main-chat/model responses and calls with a missing or unknown cache purpose always remain live. That includes weather requests such as `wie wird das Wetter morgen?`.
- Live or creative wiki, critical classifier/push, dream narrative, dream echo, afterthought, persona voice, and overlay paths are not cached.
- Direct Tier-3 API-client calls and emotion calls without a real agent scope are not cached.
- The cache does not perform semantic matching, share results across agents, cache rejected upstream calls, or replace provider-side prompt caching.

The `/state` status section reports cache hit rate, memory/persistent hits, persistence state, and avoided input/output tokens. It intentionally reports token counts, not money.

**`emotion.t3`** — the tier-3 emotion classifier uses the effective OpenClaw
agent model when its model is absent. A complete feature-local direct override
may instead provide its own model and transport. If neither route is available,
the classifier falls back to Tier-2 heuristics: it does **not** label cards, so
it never poisons results by marking everything `fakt`.

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

### Feature profiles

Core memory (capture, recall, search) works from manifest-safe defaults without profile confirmation. Argument-less setup only lists the choices, and start is read-only status/onboarding guidance:

```bash
# In Telegram
/plur1bus setup
/plur1bus start
```

Apply a profile only by naming it explicitly:

```bash
/plur1bus setup safe
/plur1bus setup recommended
```

An explicit selection records `setupProfile` and `featuresConfirmedAt`. Recommended enables additional features while retaining merge and Obsidian safety gates; vault discovery alone never counts as confirmation.

## Architecture

LanceDB is the authoritative store: every memory card lives there first, indexed per agent for isolation. The Obsidian bridge mirrors cards into a Markdown vault so the user can read, link, and edit them with normal tools; LanceDB stays the source of truth and the bridge re-syncs on changes.

A daily consolidation job detects duplicates and generates merge proposals (never auto-applies). A critical-push classifier (run via the OpenClaw-managed cron as `/plur1bus internal classify-recent`) labels recently captured cards by sensitive entity type (person, relationship, birthday, money/account, health, access/password) using the configured chat model, and — when a per-agent daily threshold (`maxPerDay`) is not yet exceeded — emits a short confirmation message per critical card. The plugin SDK currently exposes no outbound send API, so these messages are returned in the job result (`pushMessages`) for the cron carrier agent to deliver; once the SDK gains a reply-send hook, the same `telegramSend` path delivers them directly. The per-day counter is enforced across runs, and each card is classified exactly once, so no card is pushed twice.

The recall pipeline runs embedding → LanceDB vector search → optional query refinement → temporal filter → canonical `KNOWLEDGE.md` search → score/status processing → graph spread and hydration → budget allocation → optional rerank → deduplication → ACL filtering → finalization. The caller may then append bounded Semantic Lens and Conversation Reactivation Recall results; neither replaces the primary recall.

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
- **Explicit profile selection** — Missing values use manifest-safe defaults. Use `/plur1bus setup safe` or `/plur1bus setup recommended` only when you intentionally want to persist a profile; `/plur1bus setup` and `/plur1bus start` are non-mutating.
- **Merging is proposal-only** — `merging.autoApply` defaults to `false`. Merge candidates are written to `merge-proposals.jsonl` instead of being applied automatically. Set `autoApply: true` to restore 5.x behavior.
- **Obsidian bridge apply mode** — New `mode: "apply"` with safety gates (backups, audit log, vault path confirmation). Default is `mode: "augment"` (read-only). Confirm vault path explicitly before first write.
- **Command input handling** — Hard length limits removed. Very long inputs are semantically compressed; beyond 100k chars use a file or vault source.
- **Config keys added** — `reranker.timeoutMs`, `reranker.fallbackOnError`, `merging.autoApply`, `merging.mode`, `obsidianBridge.backupBeforeApply`, `obsidianBridge.auditLog`, `obsidianBridge.requireVaultPathConfirmation`, `obsidianBridge.morningReview.status`, `obsidianBridge.eveningReview.status`, `emotion.tier`, `emotion.t2.enabled`, `emotion.t3.enabled`, `emotion.t3.model`, `emotion.t3.apiKey`, `emotion.t3.escalationConfidence`, `emotion.t3.timeoutMs`, `emotion.moodInfluence`, `emotion.intensityHalfLifeFactor`, `emotion.temperaments.<agentId>`.

See `v5_TO_v6_MIGRATION.md` for the full migration guide.

## License

MIT — see [LICENSE](./LICENSE).
