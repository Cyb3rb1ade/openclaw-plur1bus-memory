# PLUR1BUS — Memory plugin for OpenClaw

PLUR1BUS turns OpenClaw into an agent with long-term memory: a per-agent isolated LanceDB store as the source of truth, a mirrored Obsidian vault as a human-readable view, and a small set of background jobs that classify, consolidate, and (when warranted) notify.

**PLUR1BUS 7.8.6 — verified on OpenClaw 2026.8.x and 2026.9.1**

Current source version: **7.8.6**. PLUR1BUS 7.8.6 supports OpenClaw `2026.8.1`
as its primary host target and is additionally verified against OpenClaw
`2026.9.1`; the declared compatibility floor is `openclaw@2026.8.1` and plugin
API `>=2026.8.1`. The package is built and tested against the immutable build
baseline `openclaw@2026.8.2`; see the
[compatibility contract](docs/compatibility-openclaw.md) for the full runtime
matrix and evidence. The upstream source base is the immutable official tag
`v7.4.10`, commit `c0a8a4c28ff1cb9c632e185f21f4502d67d1b605`.

### Web interface

PLUR1BUS registers its own **"PLUR1BUS" tab in OpenClaw's Control UI**
(`/plugins/memory-lancedb-namespaced/control`) — memory health, the workspace
matrix, provider status, and migration progress, all in the browser. It rides
on the OpenClaw Gateway's own port and authentication (no separate port, no
separate login); reach it through however you already reach your Gateway
(loopback, or a Tailscale/VPN front end), then open that tab.

## What it does

By default, each agent gets its own LanceDB store under `{baseDbPath}/{agentId}/` and a matching Obsidian vault folder for browsing. An explicit named-namespace configuration can read the same validated agent from multiple storage namespaces while keeping one active writer. The plugin captures conversation-derived memory cards automatically, runs a daily consolidator and a critical-push classifier as cron-driven background jobs, and exposes a small set of Telegram commands so the user can inspect, edit, or toggle behaviour without leaving the chat.

### New in v7.8.6 — scheduled semantic-link discovery can write

- The `discover-semantic-links` cron called the discoverer without a
  mutation policy, which the policy layer reads as blocked, so scheduled
  discovery never wrote a link. The handler now builds the same
  receipt-bound policy per workspace that the bridge service uses. Without a
  vault receipt it stays blocked by design.
- The vault confirmation flow (`plur1bus-obsidian use/confirm`, gateway
  methods `plur1bus.obsidian.prepare/confirm`) failed with "Invalid agent
  ID": the handlers read the parameters off the host's method context object
  and did not accept the CLI's `session` name. Both are handled now, and the
  agent id falls back to the key's `agent:<id>:` prefix.

### New in v7.8.5 — the Obsidian card sees every agent's vault

- Without a configured `obsidianBridge.workspaces` list the target probe only
  looked at `<OpenClaw home>/workspace`; the vaults in `workspace-<agent>`
  stayed invisible. Every `workspace*` directory is probed now.
- With `requireVaultPathConfirmation: false` the bridge acts without a
  receipt, so a configured target now reads "ready" instead of "not yet
  confirmed", and the card says how many targets are configured.
- The bridge only knows vaults through `obsidianBridge.workspaces` (entries
  with `id`, `agentId`, `path`) or `vaultPath`. The reviews work without it
  through the host's agent workspace; semantic-link discovery and the target
  card do not.

### New in v7.8.4 — the dashboard buttons work inside the host tab

- OpenClaw embeds the plugin tab in an iframe sandboxed with `allow-scripts`
  only, so the browser silently blocked every native form submission there;
  the 7.6.0 switches and the 7.8.0 Compact button only worked in a standalone
  browser tab. A writable page now carries one nonce-bound script that posts
  the form with `fetch` and reloads itself; the result shows up as the usual
  banner. Read-only pages still carry no script. The script intercepts the
  click on the submit button: a sandboxed frame refuses the submission before
  it ever fires the `submit` event (7.8.1 listened there and never ran). The
  action travels as a GET with the single-use token in the query, because the
  host authenticates the frame's cookie for GET only and answers a POST from
  the opaque origin with 401 (7.8.2 hit that). 7.8.4 routes the Compact
  button through the db-adapter, which owns `optimizeTable`; 7.8.3 asked the
  pool's raw store objects and failed.

### New in v7.8.0 — a Compact button per partition, and an installer that reaches its plan

- **Compact behind every LanceDB row.** With `controlUi.writeActions: "all"`,
  each private partition under "Cards by agent" gets a button that runs
  LanceDB's fragment compaction (`table.optimize()`) for that partition in
  the background, one at a time. The adapter had the primitive since August;
  nothing ever called it. The row shows progress and the result.
- **The feature-cron installer no longer times out its own probe.** On large
  installs `openclaw plur1bus-feature-cron --help` takes longer than the old
  five-second budget, so every run took the fail-closed branch and
  safety-disabled the direct jobs. Budget is 30 s now.
- **Ownership rules fixed:** a disabled owned job no longer counts as
  present for non-delivery features (it is re-enabled), operator-named
  consolidations that run the shipped command are not duplicated, the
  singleton collector is recognised on any agent, and `main` is the default
  agent when the host flags none.
- **Memory Health no longer reads "degraded" because of `_neo`.** Reserved
  store directories are skipped by the health scan.

### New in v7.7.0 — dreams on OpenClaw's own Dreams page

- **PLUR1BUS dreams show up in Settings → Memory → Dreams.** Light and REM
  narratives are written into the agent's `DREAMS.md`, in the host's entry
  shape inside its managed diary block. Only the agent's private partition
  writes there; shared partitions never do. `dreaming.narrative.diary` turns
  it off. To give the diary one author, switch the host's own managed dreaming
  off. The host reads that switch from the memory slot owner's entry, so it is
  `plugins.entries.memory-lancedb-namespaced.config.dreaming.enabled: false`,
  not memory-core's flag.
- **The Memory page knows the engine.** PLUR1BUS now registers the memory
  runtime the host expects from the slot owner, so Overview and Scene report
  PLUR1BUS' provider, model, embedding state and card count instead of
  "memory plugin unavailable". Host-side search runs through PLUR1BUS' recall
  pipeline on the agent's private partition only.
- Not reachable from a plugin: the counters under Advanced and the phase chips,
  which read memory-core's internal short-term store and its managed cron.

### New in v7.6.0 — switch providers from the dashboard

The operator tab can now change two things, if you let it. `controlUi.writeActions`
is `off` by default, so nothing changes for an existing install.

- **`reranker`** makes the reranking choice switchable from the page: local BGE,
  local JinaAI (both keyless), Cohere when a key is configured, or off. That is a
  runtime choice with no data migration behind it.
- **`all`** additionally exposes the embedding target and the re-embedding
  migration: dry run, copy, and a separate switch. The confirmation token that
  binds those steps stays inside the Gateway and never appears in the browser.

Every change carries a single-use form token from the page render it was clicked
on, because the tab cookie the host mints is `SameSite=None`. While
`writeActions` is `off` the page renders no form, forbids form targets in its
Content-Security-Policy, and refuses POST outright.

Also fixed: the reranking card used to name `jina` as a `reranker.provider`
value. The schema rejects it. Jina reranking is a local model, selected through
`reranker.local.model`.

### New in v7.5.6 — verified against OpenClaw 2026.9.1

- **No code change was needed for the 2026.9.1 host.** PLUR1BUS was loaded
  through that release's own plugin loader and the full suite was run against
  it. The compatibility contract now names 2026.9.1 stable and drops the
  2026.9.1-beta.1 wording, which described a beta nobody runs.

### New in v7.5.5 — readiness agrees with the runtime

- **Credential Readiness no longer calls a working embedding "missing".** The
  runtime falls back to `OPENAI_API_KEY` (and `OPENAI_API_KEY_FALLBACK` for
  the fallback embedder) when neither `apiKey` nor `apiKeyEnv` is set, which
  is how a default install carries its key. The table now follows the same
  rule, names the variable it found, and never reads its value. Keyless
  providers show `not required`; an unconfigured optional fallback shows
  `optional`.

### New in v7.5.4 — the tab opens at once, and looks like the rest of the Control UI

- **No more waiting for the health scan.** Opening the tab used to run a scan
  over every partition table (2–21 s depending on gateway load) because the
  snapshot cache lasted 10 s. The last snapshot is now served immediately and
  refreshed in the background: once at gateway start, then every 10 minutes.
  The page says how old the snapshot is.
- **Host styling.** The page uses the Control UI's own colour, radius and type
  tokens, dark by default and light when the operating system asks for it. The
  tab runs in a sandboxed iframe that receives no theme message, so a
  light/dark mode forced in the host cannot be followed, only the OS setting.

### New in v7.5.3 — the tab registers, and a host route is not a defect

- **The Control UI tab showed "Plugin panel unavailable".** OpenClaw 2026.8.2
  exposes the descriptor registration flat on the api object; PLUR1BUS read only
  the nested path, so no tab was ever registered.
- **Host-routed capabilities no longer wear the `missing` badge.** They need no
  key of their own, so the status says so instead of reading like a fault.

### New in v7.5.2 — the readiness table points at the right line

- **The config path shown is the one that holds the key.** A key in
  `reranker.apiKeyEnv` was labelled `reranker.apiKey`, sending the reader to a
  line that does not exist in their config.
- **`host_route` is explained.** The source had no legend entry, and the
  `missing` help text claimed the feature stays off — untrue for exactly the
  capabilities that report it.

### New in v7.5.1 — the operator dashboard tells the truth

- **Continuity Engine, Semantic Lens and Query Refinement default to on.** The
  tab states that an absent switch means on, but these three defaulted to off
  in the manifest, so an untouched install contradicted the sentence printed
  above the feature cards. An explicit `enabled: false` still turns them off.
- **Credential readiness reads `apiKeyEnv` too.** A working Cohere reranker
  configured through an environment variable was reported as missing. The five
  capabilities that fall back to OpenClaw's own model route are now marked as
  host-routed instead of looking unconfigured.
- **A Reranking card.** Provider, model and revision of the active reranker,
  plus how to switch between `cohere`, `jina` and the local BGE fallback.

### New in v7.5.0 — native integration and verified local models

- **No OpenClaw bundle patching.** Feature cron commands use OpenClaw's public
  plugin registration and `gateway-runtime` dispatcher capabilities. Missing
  capabilities fail closed; PLUR1BUS never rewrites OpenClaw source, dist, or
  `node_modules` files.
- **Exact 2026.8.x release contract.** Package metadata pins the tested host
  and SDK identity to `2026.8.1`/`2026.8.2`, while runtime behavior is guarded
  by feature detection rather than version-string branches. OpenClaw
  `2026.9.1` stable is additionally verified (see the compatibility contract).
- **Pinned local inference.** E5 embeddings, the optional multilingual Jina v3
  embedding, Jina reranking, and the free BGE fallback use immutable Hugging
  Face revisions with exact required-file sizes and SHA-256 verification before
  Transformers.js loads them. Jina v3 embedding is offered separately because
  its CC BY-NC 4.0 license does not permit commercial use without other terms.
- **Activation-owned preparation.** Selecting a local-model preparation profile
  stages no work during plugin discovery. The download begins only after
  OpenClaw activates the PLUR1BUS service, and shutdown or replacement drains
  it through the public service/runtime lifecycle.
- **Lifecycle-owned Obsidian watcher.** OpenClaw starts the Bridge only after
  registry activation and stops it before replacement. Periodic scans queue
  inbound review candidates without starting a Memory write; an authorized
  explicit apply remains required for durable inbound mutation.
- **One local model across scoped registries.** OpenClaw's request-scoped
  provider registries delegate local embedding inference to the activated
  PLUR1BUS owner over a private, authenticated Unix socket below the PLUR1BUS
  state directory. It is never published as a host port, binds exact model and
  dimension identity, and closes before the activation-owned model.
- **Deterministic regression timing.** CPU-bound performance contracts measure
  process CPU time; repair diagnostics drain naturally before process exit.

### New in v7.4.0 — evidence the agent can stand behind

- **An epistemic status every write earns.** New user captures are recorded as
  `observed`, every other new write as explicit `untrusted`; nothing invents
  `trusted` any more. The skill miner clusters `observed | corroborated | trusted`
  plus valid pre-cutoff legacy rows and no longer applies a 30-day lookback, so
  an existing install keeps mining its history instead of reporting `scanned: 0`.
  The cutoff marker is written once, at the first upgrade, before the first write.
- **Skill approval survives a crash.** `SKILL.md` is written first (tmp + fsync +
  rename), then the evidence transitions; a partial failure stays
  `activation_partial` and can be re-applied idempotently.
- **Forgotten stays forgotten.** Every reachable card re-insert — store, content
  update, `updateCard`, compaction, auto-capture, light-dream rewrite — checks the
  tombstone registry before `table.add`. Same-text replay by the user is still
  allowed.
- **A global inject budget** (`recall.globalInjectMaxChars`, default 17000) trims
  memories before time and reminder context, so a large recall can no longer
  crowd the rest of the prompt out.
- **Two new curation commands.** `/plur1bus curation resolve <keep|drop>` ends a
  neo `conflict` without any hard filter, and `/plur1bus curation drop-injected`
  demotes only *injected* behaviour conflicts after a preview and a nonce —
  genuine conflicts are never touched.
- **Derived records carry visibility.** Pattern and dream writers stamp scope;
  readers filter by requester. Legacy records without a stamp stay own-agent only.
- **Legacy compatibility note.** The 7.4.0 release could opt out of its then
  current dispatcher rewrite. Version 7.5.0 removes that rewrite completely.

### New in v7.3.x — memory dynamics that actually fire

Condensed summary of 7.3.0–7.3.5; see the [changelog](CHANGELOG.md) for detail.

- **Valid-time and trust state** (7.3.0) — memories carry temporal validity, and
  epistemic trust became a first-class field alongside a batch of audit fixes.
- **Security and scope hardening** (7.3.1) — bound episode-graph endpoints,
  ownership-partitioned compaction, fail-closed skill scans.
- **The classifier stopped rejecting its own default** (7.3.2) — `fakt` was
  missing from the type enum, so every classification run failed validation.
- **GC got a trigger and a policy** (7.3.3) — an eighth feature cron at 04:45 plus
  a configurable `maxMemoryCount`; before this, garbage collection had no
  scheduler at all.
- **`importance = 1.0` works again** (7.3.4) — the value is the agent's reserved
  manual core marker; it was silently ignored because the core score also demanded
  an emotional intensity the agent cannot set. Core scores are now normalised to
  the features that actually exist.
- **REM dreaming finds patterns again** (7.3.5) — similarity was compared on two
  different scales, so even an identical vector fell below the threshold: zero
  edges, zero clusters, ever. Feature crons are also staggered per agent now.

### New in v7.2.0 — safer OpenClaw updates

- **Complete, version-bound deploy verification** — repair checks cover all
  static and literal dynamic runtime imports, bind package and manifest
  identity to one immutable source snapshot, and roll back the complete
  deployment if any copy or final validation fails.
- **Safe promoted-memory reindex bridge** — the replacement maintenance CLI is
  configuration-aware, namespace-aware, idempotent, dry-run by default, and
  compatible with predecessor marker state without forwarding redacted
  credentials.
- **Staggered daily consolidation** — exact PLUR1BUS-owned per-agent jobs are
  scheduled 15 minutes apart, avoiding simultaneous consolidation pressure;
  custom or look-alike jobs remain untouched.
- **Explicit recovery tooling** — deploy verification and repair accept an
  expected release version and report missing source/preflight reasons instead
  of producing a mixed installation.

### New in v7.1.9 — lower background token usage

- **Six high-frequency jobs reduced by about 83%** — Afterthought and Critical
  Push now run every three hours instead of every 30 minutes.
- **Safe schedule migration** — only PLUR1BUS's shipped 30-minute cadence is
  migrated; custom operator intervals and delivery targets remain untouched.
- **No active-memory recursion** — active-memory child sessions cannot trigger
  another PLUR1BUS recall or capture pass.
- **Agent-scoped semantic discovery** — scheduled discovery processes only the
  triggering agent's configured Obsidian workspaces.

### New in v7.1.8 — reliable feature-cron setup

- **Slow healthy gateways no longer miss reconciliation** — the redacted
  effective-config snapshot used by feature-cron setup now has a focused
  30-second budget; live measurements were approximately 12.5–18 seconds.
- **Narrow compatibility fix** — the fail-closed result contract, single
  snapshot, shared CLI defaults, schedules, delivery, model routing, and
  thinking policy remain unchanged.

### New in v7.1.7 — model-free feature cron dispatch

- **No outer carrier model for Afterthought or Critical Push** — exact internal
  commands are finalized through OpenClaw's normal delivery path before the
  carrier agent/model executor.
- **Scoped fail-closed recovery** — if the host dispatcher is unavailable,
  only exact PLUR1BUS-owned feature jobs are paused and marked; custom prompts
  and unrelated jobs are never claimed.
- **Schedules and delivery remain intact** — existing jobs migrate
  idempotently while keeping their 30-minute cadence and validated targets.
- **Native internal LLM policy** — actual Afterthought composition and
  classification still inherit the target agent's OpenClaw model and thinking
  policy; PLUR1BUS does not force `thinking: off`.

### New in v7.1.0 — audited ownership, recall, and operations

- **Complete high/medium audit remediation (B1–B15)** — durable memory writes, timeout settlement, cancellation barriers, diagnostics, installer paths, operational maintenance, Obsidian mutations, and background jobs were hardened and regression-tested.
- **Strict memory ownership** — private, workspace, and user data use canonical agent/workspace/user request contexts. Sharing is explicit, confirmation-bound, owner-bound, and isolated in separate storage pools; unbound or conflicting rows fail closed.
- **Recall and namespace closure** — B12 Core and B12-P add secure read-only legacy access, globally bounded multi-namespace recall, adaptive budgets, compression, decision traces, and strict graph/provider authorization.
- **OpenClaw owns the LLM choice** — PLUR1BUS feature routes inherit the effective target agent model unless a feature has a complete explicit direct-provider override. Hard-coded chat-model defaults were removed.
- **Exact LLM result cache** — deterministic internal transforms can reuse validated, bounded, agent-scoped results without leaking prompts or credentials.
- **Dependency and runtime baseline** — patched transitive dependencies and `sharp@0.35.3` close the dependency audit; PLUR1BUS now requires Node.js 22.22 or newer.
- **Release verification** — the release baseline contains 3,260 tests (3,259 passed, 0 failed, 1 skipped) and `npm audit` reports 0 vulnerabilities.

### New in v6.9.10 — Maintenance progress and dedupe hardening

- **Candidate status updates survive content dedupe** — promote/demote/prune/tombstone updates are append-preserved while ordinary candidate captures remain content-deduped.
- **Capped memory dynamics are resumable** — retrieval-ledger caps store partial entry progress, and daily decay rotates with a persisted cursor instead of repeatedly touching the first rows.
- **LanceDB vector wrappers normalize safely** — Arrow-style vector wrappers are converted before update writes to avoid schema failures during consolidation.

### New in v6.9.x — Runtime fixes, cron provisioning, and emotional dynamics

- **REM-Dream cron provisioning** — New installs provision `rem-dream` when `merging.enabled: true` is explicitly authored, instead of shipping an enabled handler without a scheduler binding.
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

- **Multi-Namespace Pool** — One validated agent can opt into recall across named LanceDB storage namespaces; this never selects another agent and is not cross-agent sharing.
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

When the last conversation ended 30–120 minutes ago with an open outcome (the user asked for details, or the topic was dropped mid-thread), the plugin can compose a short, casual follow-up message ("Mir ist zu … noch eingefallen…"). This is gated by the shared proactive governor budget, capped at one per day, and skipped for any topic already surfaced as an open thread today. Recommended cron: every 3 hours, run the exact command `/plur1bus internal afterthought` with announce delivery. The plugin command returns either a validated reply payload or OpenClaw's `NO_REPLY` suppression token. PLUR1BUS submits the exact allowlisted command through OpenClaw's public gateway-runtime dispatcher, so OpenClaw owns status finalization and at-most-once announce delivery without an outer carrier-model run. If the required native capability is unavailable, provisioning fails closed and leaves the feature job inactive. Custom prompts, surrounding whitespace, prefixes, and suffixes are never claimed.

Setting this cron up is automatic when its raw feature gates are explicitly enabled — see below.

#### Multi-agent feature-cron automation

`node scripts/setup-feature-crons.mjs` verifies the public native command-dispatch capability first. When healthy, it loads exactly one validated configuration snapshot with `openclaw gateway call config.get --json`, discovers bound agents, and idempotently plans up to seven jobs per agent plus one install-wide GC job. It fails closed without normal cron planning when the capability is absent, the gateway call fails, JSON is invalid, `valid !== true`, or `sourceConfig`/`runtimeConfig` is not a plain object. Custom prompts and unrelated jobs remain untouched. It never falls back to local config files or alternate raw/resolved fields.

The capability probe allows the host CLI 30 seconds per help call (7.8.0); a booting host with many plugins needs more than the former five. Ownership is by exact command: an operator-named job that runs `/plur1bus internal <feature>` for an agent is that agent's job, and only PLUR1BUS-named jobs are eligible for schedule migration. A non-delivery feature whose only owned jobs are disabled gets its best candidate re-enabled; the singleton collector is satisfied by a job on any agent; when `openclaw agents list` flags no default agent, `main` is treated as the default.

The two configuration views have separate roles: `sourceConfig` alone controls explicit raw feature gates and the raw `skillMiner` schedule; `runtimeConfig` alone controls effective bindings, accounts, and delivery. Runtime defaults cannot enable jobs. The eligible jobs are:

- `persona-evolve`: `personaVoice.enabled && skillMiner.enabled`; Sunday 04:15 local time, staggered five minutes per agent; no delivery.
- `afterthought`: `afterthought.enabled && (skillMiner.enabled || merging.enabled)`; every 3 hours; exact-command announce delivery with a direct text/`NO_REPLY` result.
- `consolidate-daily`: `dailyConsolidation.enabled`; daily 04:00 in `Europe/Berlin`; no delivery.
- `classify-recent`: `criticalPush.enabled`; every 3 hours; safe announce delivery of approved pushes or `NO_REPLY`.
- `rem-dream`: `merging.enabled`; daily 01:15 in `Europe/Berlin`; no delivery.
- `skill-miner`: `skillMiner.enabled`; raw Croner-compatible cron/timezone after conservative syntax validation, defaulting to Sunday 03:00 in `Europe/Berlin` (`timezone: null` means local time). Invalid literals, descending ranges (including named month/day ranges), names, modifiers, or literal-step forms are ineligible.
- `discover-semantic-links`: `obsidianBridge.enabled && obsidianBridge.graphLinks.semanticDiscovery.enabled`; daily 02:00 in `Europe/Berlin`; no delivery.
- `gc-run`: `gc.enabled`; daily 04:45 in `Europe/Berlin`, after `consolidate-daily` has produced the candidates; no delivery. This one is a **singleton** — `runGcJob` iterates over every agent database itself, so exactly one job is planned regardless of how many agents the install has.

Every job runs with `--agent <agentId> --session isolated`. Provisioning does not set model, fallback, token, auth, API, or other credential overrides, so OpenClaw's default LLM and per-agent credentials remain authoritative. The script remains idempotent and exit-0 for install safety, so it can run from any of these channels:

- **`npm install`/`npm postinstall`** — fires when the plugin is installed via `npm install` (e.g. `npm install -g @cyb3rb1ade/plur1bus-memory`).
- **Gateway startup (deferred bootstrap)** — runtime registration verifies the
  public Gateway method, CLI, and command dispatcher exactly once. A
  `gateway_start` handler schedules a bounded reconciliation after the gateway
  becomes reachable. Missing capabilities or invalid config leave exact owned
  feature jobs inactive; retries use bounded backoff. Disable provisioning with
  `"featureCronSetup": { "auto": false }`.
- **Manual** — `/plur1bus setup crons` (optionally `--agent <id>`/`--account <acct>` to force single-agent mode).

The `/plur1bus doctor` and `/plur1bus status` feature-cron hint is **condition-derived**, not "have we shown this before": it reads the marker file and only surfaces a hint when setup has never run, ran under an older plugin version, or ran but couldn't create everything it planned (some crons are still pending — e.g. no delivery target could be derived). It's silent once a current-version run reports nothing left to create.

- **Bound-agent rule**: only agents with `bindings > 0` (i.e. an actual chat channel routes to them) get feature crons. Subagents (`bindings === 0` — researchers, deep-divers, and other internal-use-only agents) are deliberately excluded; they have no chat to receive an automatic persona evolution or an afterthought delivery, and running these jobs against them would be pure compute waste.
- **One agent per workspace**: PLUR1BUS state for these jobs (persona voice, proactive-governor budget, afterthought dedup state, …) is keyed by workspace directory, not agent id. If two bound agents share a workspace, only one gets the crons (tiebreak: `isDefault` first, then most bindings, then alphabetically-first id) to avoid two crons double-firing against the same state files.
- **Per-agent identity**: all per-agent canonical names use `plur1bus <feature> <agentId>`. An existing job is owned only by an exact, case-sensitive agent id plus either its exact canonical name or exact first command line; missing or different agents are untouched. Every exact owned duplicate is inspected and reconciled, even when another duplicate is already safe.
- **Safe delivery**: outbound targets never come from `allowFrom`. Delivery-required jobs use only a conservatively validated Telegram binding `match.peer.id` (including `t.me/<handle>`) or effective account/root `defaultTo`. Every relevant non-ACP binding must agree on channel, and an account inherits only when `match.accountId` is truly absent. Omitted accounts resolve in order from an explicit valid `defaultAccount`, `accounts.default`, one sole named account, or a root account proven by configured `botToken`/`tokenFile`; routing fields alone never invent a root default account. Unsupported providers, wildcard, placeholder, redaction, zero-id, disabled-account, explicit empty/missing account, mixed-account, and conflicting target/channel/account states are rejected. Existing delivery seeds require exact `mode: "announce"`; case or whitespace variants are unsafe. A job without a validated target is created disabled with `--no-deliver`; every unsafe owned delivery job is disabled and stripped of delivery. Non-delivery jobs retain only missing delivery or exact `mode: "none"`; every other delivery object is removed.
- **Agent discovery/input failure**: if `openclaw agents list --json` fails, is unparseable, or yields no bound agents, no cron is mutated. Passing a validated `--agent <id>` forces one explicit agent; missing, option-like, or invalid `--agent`/`--account` values fail closed, and `--account` without `--agent` is rejected.

## Installation

PLUR1BUS 7.7.1 requires Node.js 22.22 or newer and OpenClaw 2026.8.1 or newer.
On an older host the installer refuses the package instead of deploying it:
`requires plugin API >=2026.8.1, but this OpenClaw runtime exposes <version>`.

Install the published release through OpenClaw's package installer:

```bash
openclaw plugins install clawhub:@cyb3rb1ade/plur1bus-memory@7.5.3 \
  --acknowledge-clawhub-risk --pin
```

The same release is on the npm-compatible registry, if your `@cyb3rb1ade`
scope already points there:

```bash
openclaw plugins install @cyb3rb1ade/plur1bus-memory@7.5.3 --pin
```

Or install the immutable GitHub Release tarball:

```bash
openclaw plugins install \
  https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/releases/download/v7.5.3/cyb3rb1ade-plur1bus-memory-7.5.3.tgz
```

To build from this source checkout instead, produce a tarball and install that
artifact rather than linking the directory; a source link is not an equivalent
package-compatibility test:

```bash
npm ci
npm test
npm pack
openclaw plugins install \
  npm-pack:/absolute/path/cyb3rb1ade-plur1bus-memory-7.5.3.tgz --force
```

Record the tarball's SHA-256 before transferring it. PLUR1BUS 7.5.3 never
patches OpenClaw runtime files. Existing release artifacts remain unchanged and
must not be relabelled as 7.5.0.

Restart the gateway after installing, so the new plugin version is loaded.

Then add a `plugins.entries["memory-lancedb-namespaced"]` block to your `openclaw.json` (see below).

## Configuration

Minimal config block in `openclaw.json`. This is an explicit override example:
the named `gpt-4o-mini` value and its credential are illustrative user choices,
not PLUR1BUS defaults.

```json
{
  "skills": {
    "workshop": {
      "autonomous": { "mode": "propose" }
    }
  },
  "plugins": {
    "slots": {
      "memory": "memory-lancedb-namespaced"
    },
    "entries": {
      "memory-lancedb-namespaced": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
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
          "dreaming": {
            "enabled": false,
            "narrative": { "enabled": true, "storeAsMemory": true }
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

`dreaming.enabled: false` is the OpenClaw memory-core sidecar gate, not the
PLUR1BUS narrative toggle. Keep it false when PLUR1BUS owns consolidation or
REM; otherwise OpenClaw also loads `memory-core` dreaming. When `skillMiner` is
enabled, use Skill Workshop autonomous `propose` or `off` so both learning
systems share the governed proposal queue without independently applying
overlapping skills.

`hooks.allowConversationAccess: true` is mandatory for this trusted memory
plugin. It authorizes the official typed `before_agent_reply` hook used for
automatic recall and for the fail-closed admission boundary of exact feature
commands; OpenClaw otherwise withholds the conversation body. The installer
enforces this single permission even in preserve mode while keeping all
unrelated hook and feature choices unchanged.

All paths default to `$HOME/.openclaw/...` if omitted. `OPENCLAW_CONFIG_PATH` and `OPENCLAW_HOME` env vars override the lookup of the gateway config file used by the toggle commands.

### Named storage namespaces

Omitting `namespaces` preserves the legacy-flat layout exactly:
`{baseDbPath}/{agentId}`. Named routing is enabled only by supplying the strict
object explicitly:

```json
{
  "baseDbPath": "~/.openclaw/memory",
  "namespaces": {
    "activeWriteNamespace": "lancedb-local",
    "activeRecallNamespaces": ["lancedb-local"],
    "legacyReadOnlyNamespaces": ["lancedb-namespaced"],
    "crossNamespaceRecall": true
  }
}
```

An explicit `baseDbPath` may be the named root, as above, or the active writer
leaf (`~/.openclaw/memory/lancedb-local`); both forms resolve to the same
layout. Namespace identifiers must match
`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. The writer must occur in active recall,
and active namespaces must be disjoint from legacy read-only namespaces.
Legacy namespaces participate only when `crossNamespaceRecall` is exactly
`true`; they are opened without table creation, schema migration, or mutation.

Every recalled table must use the configured embedding dimensions. Each table
runs the existing recall pipeline. When multiple live tables participate,
PLUR1BUS waits for all of them and performs one stable global score merge; the
one-table path remains direct. Duplicate IDs and canonical
heading/text are collapsed, canonical plus memory results share the configured
output cap, and child decision traces are replayed through the existing trace
caps. A namespace changes storage routing for the current agent only. Sharing
between agents, workspaces, or users is separate ACL work owned by B13.

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

- Persistence uses the built-in `node:sqlite` module available throughout the supported Node.js runtime range; if SQLite initialization is unavailable, the cache falls back to memory-only.
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

### Freigegebene Memory-Pools (B13)

`/share <id>` kopiert eine sichtbare Karte nach bestätigter, an Benutzer und
Chat gebundener Bestätigung in den Workspace-Pool. `/share <id> --user` nutzt
dieselbe Bestätigung, erzeugt aber einen nur für denselben Kanal, Account und
Benutzer sichtbaren User-Pool. Die Grammatik ist strikt: nur ein vollständiges
UUID-`id`, optional genau `--user`, oder `/share confirm <nonce>` sind gültig;
unbekannte oder doppelte Optionen werden vor jedem Store-, DB-, Embedding- oder
Provider-Zugriff abgelehnt. Eine Freigabe ist **copy, never move**: die private
Ursprungskarte bleibt unverändert, und die autorisierte Shared-Kopie enthält
einen kanonischen Origin-Verweis. Recall darf die optionalen Shared-Quellen
ergänzend lesen und dedupliziert den kanonischen Ursprung; sie ersetzen weder
primären Recall noch dessen ACL.

Physische Routen sind kein benutzergesteuerter Pfad: ihre Segmente sind höchstens
64 Zeichen lang und werden als `.plur1bus-shared/workspaces/w-<62hex>` oder
`.plur1bus-shared/users/u-<62hex>` abgelegt. Die Berechtigung bindet den
kanonischen Workspace konfliktablehnend (keine versteckte Alias-Priorität) und
den vollständigen Kanal+Account+Benutzer-Prinzipal. Fehlende oder abweichende
Bindungen sind nicht sichtbar und nicht mutierbar; fehlend und verweigert
werden gleich behandelt. `/memory` und `/share --user` verwenden den direkt
vom Host gelieferten Account.

Der aktuelle OpenClaw-Hook kann die optionale automatische User-Shared-Recall
Quelle ausschließlich bei aktiviertem `autoRecall` verwenden. Er benötigt
einen account-tragenden Session-Key, ein exaktes Host-Run-Ticket oder eine
konservative default-only Account-Topologie. Native und Slash-Kommandos prägen
absichtlich kein Route-Ticket, weil behandelte Kommandos den Prompt-Hook nicht
erreichen. Bei mehrdeutigen benannten/multi-account Main-, Group- oder
Channel-Turns wird nur diese optionale Quelle ausgelassen; andere Recall-Quellen
bleiben unberührt. Ein zuletzt gespeicherter Session-Route-Wert ist kein
turn-gebundener Account-Beweis.

Legacy rows that used the old `workspace_shared` scope remain in their
authoritative private table until an operator explicitly migrates them. Start
with the non-mutating audit:

```text
/plur1bus migrate-legacy-shared
```

Use `--report <name.json>` for a fixed private report name, and resume a bounded
dry run with the opaque `--cursor <token>` returned by the previous run. After
reviewing the report, run `--apply` without a dry-run cursor; apply re-reads each
source row, writes and verifies an idempotent workspace copy, and only then
marks the legacy source. The command never deletes or re-scopes the source row:
workspace_shared legacy rows are not reinterpreted. The operation is bounded
per run to 250 rows, 4 MiB source bytes, 100 provider calls, and 60 seconds.
The opaque cursor pins source versions and dry-run mode; an unavailable or
changed pinned version, mode mismatch, checksum/binding failure, timeout, or
uncertain commit aborts the run and requires the documented continuation or a
restart without the cursor. Apply never accepts a dry-run cursor.
It is operator-destructive, so it requires the same user authorization as
`/forget`; cron identity does not bypass that gate. Reports are no-clobber
`0600` JSON files below `.plur1bus/migrations/` and exclude memory content,
vectors, evidence, and provenance.

The migration runs only through the destructively authorized initialized runtime
command; there is no standalone DB/config/credential bootstrap. Multi-Namespace,
Neo/Obsidian aliases, Semantic Lens, CRR, the OpenClaw default LLM, and
per-agent credentials do not change under sharing or migration.

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

A daily consolidation job detects duplicates and generates merge proposals (never auto-applies). A critical-push classifier (run via the OpenClaw-managed cron as the exact command `/plur1bus internal classify-recent`) labels recently captured cards by sensitive entity type (person, relationship, birthday, money/account, health, access/password) using the configured chat model, and — when a per-agent daily threshold (`maxPerDay`) is not yet exceeded — emits a short confirmation message per critical card. The command handler converts returned `pushMessages` into a validated native command reply; OpenClaw's dispatcher owns finalization and delivery. Multiple push texts are combined in their original order; partial classifier failures are reported alongside successfully produced pushes. The per-day counter is enforced across runs, and each card is classified exactly once, so no card is pushed twice.

The recall pipeline runs embedding → LanceDB vector search → optional query refinement → temporal filter → canonical `KNOWLEDGE.md` search → score/status processing → graph spread and hydration → budget allocation → optional rerank → deduplication → ACL filtering → finalization. The caller may then append bounded Semantic Lens and Conversation Reactivation Recall results; neither replaces the primary recall.

## Development

```bash
npm install
npm test              # full serialized Node test runner
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
