# OpenClaw Memory System

*[Deutsch](#deutsch) | [English](#english)*

[![Latest Release](https://img.shields.io/github/v/tag/Cyb3rb1ade/openclaw-plur1bus-memory)](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/tags)

---

<a name="deutsch"></a>
## Deutsch

Produktionsreifes Gedächtnissystem für [OpenClaw](https://github.com/openclaw)-Agenten mit **vier Memory-Schichten**, **nativem Dreaming**, **Canonical-First Recall** und voller **Provenance**.

**Aktuelle Version:** `2.1.13` — OpenClaw `2026.4.29` ist die Mindestversion; Installer erhält bestehende Provider/Modelle oder konfiguriert Fresh-Installs explizit per User-Entscheidung.

**Mindestversion:** OpenClaw `2026.4.29` oder neuer. Ältere Versionen werden vom aktuellen Installer nicht unterstützt.

**OpenClaw-2026.4.29-Hotfix:** `patches/apply-plur1bus-user-hotfix.sh` hält plur1bus/ActiveMemory aktiv und reduziert Prompt-Build-Latenz durch frühes `toolsAllow`, Plugin-Registry-Reuse, Plugin-Descriptor-Caching, lazy Media-/Web-Tool-Deskriptoren, eine isolierte ActiveMemory-Command-Lane, session-isolierte Embedded-Agent-Lanes, due-aware Startup-Heartbeats, Stale-Task-Zombie-Reconciliation und echte Silent-Replies in Direct-Chats.

Entwickelt und erprobt im produktiven Einsatz mit 38 Agenten über mehrere Monate.

---

## Was ist das?

Dieses Paket löst das Kernproblem von LLM-Agenten: **Amnesie zwischen Sessions.**

```
Schicht 1     Flat-File Memory       workspace/memory/YYYY-MM-DD.md — menschenlesbar
Schicht 1.5   KNOWLEDGE.md           Kurierte Wissensbasis mit YAML-Frontmatter
Schicht 2     Workspace-Indexer      SQLite + Vektor-Embeddings aller .md-Dateien
Schicht 3     LanceDB                Konversations-Fakten, semantisch durchsuchbar
Schicht 4     Dreaming               Natives memory-core (light → REM → deep) pro Workspace
```

Der Agent schreibt, das System erinnert sich automatisch. Dreaming konsolidiert Memories über Nacht in MEMORY.md und Dream Diary.

---

## Inhalt

```
extensions/
  memory-lancedb-namespaced/   ← Hauptplugin (OpenClaw-Gateway-Plugin)
  memory-lancedb-stock/        ← LanceDB-Wrapper (Abhängigkeit, npm install)
patches/
  apply-memory-patches.sh      ← OpenClaw-Patches (Stuck-Session, Cohere-Rerank, 4.29-Latenzfix)
  apply-plur1bus-user-hotfix.sh ← User-Hotfix für OpenClaw 2026.4.29 Tool-Prep/Prompt-Blocking
scripts/
  install-memory-system.sh     ← Installation, Update, Registry-Refresh, Rollback + Patches (mit Auto-Discovery)
  bump-version.sh              ← Synchronisiert Versions in Manifest + CHANGELOG
  memory-gc.mjs                ← TTL-Garbage-Collector (täglich via Cron, 03:00)
  memory-doctor.mjs            ← Health-CLI (stats/dupes/stale/orphans/pending/eval/provider-check)
  recall-eval.sample.json      ← Vorlage für recall-eval.json (echte Test-Datei in .gitignore)
  auto-capture-lancedb.mjs     ← Cron-Fallback für Auto-Capture (alle 5 Min)
  embed-promoted-memories.mjs  ← Bridge Dreaming-Promotionen → LanceDB (alle 30 Min)
  migrate-memory-md-to-lancedb.mjs  ← Einmalige MEMORY.md → LanceDB Migration
  cleanup-session-history.mjs  ← Bereinigt aufgeblähte OpenClaw-Session-Transcripts
how-to-memory.md               ← Schnell-Referenz (Konzepte und Setup)
how-to-memory-perfect.md       ← Vollständige Dokumentation (Architektur, Upgrades, Patches)
CHANGELOG.md                   ← Versionshistorie
```

---

## Schnellstart

```bash
# Abhängigkeiten installieren (nur einmalig)
cd extensions/memory-lancedb-stock && npm install

# Installation — erkennt OpenClaw automatisch
./scripts/install-memory-system.sh

# Oder explizit:
./scripts/install-memory-system.sh /pfad/zu/.openclaw

# Remote:
./scripts/install-memory-system.sh user@host:/pfad/zu/.openclaw
```

Das Skript:
- Erkennt lokale OpenClaw-Installationen automatisch
- Zeigt Auswahlmenü bei mehreren Instanzen
- Fragt nach API-Keys (**OpenAI ODER OpenRouter** für Embeddings, optional Cohere für Reranking, kimi-for-coding/GPT-4 für Merging)
- Bei OpenRouter (v2.1+): listet 20+ Embedding-Modelle live, ermittelt Vektor-Dimension automatisch via Test-Call
- **Pre-Flight-Check** (v2.1.1+) — vergleicht neue Dim mit bestehenden Agent-DBs, warnt bei Mismatch (Provider-Wechsel braucht fresh DB!)
- Erstellt LanceDB-Snapshot vor Änderungen
- Richtet Cron-Job für täglichen GC ein

### ⚠️ Provider-Wechsel: Wichtige Warnung

LanceDB hat **fixe Vektor-Dimension pro Tabelle**. Wechsel von OpenAI (3072d) zu BAAI (1024d) oder NVIDIA (2048d) → bestehende DB ist inkompatibel. Optionen:

1. **Bei alter Config bleiben** — bewährter Pfad
2. **Fresh-DB pro Agent** — `rm -r /pfad/zu/lancedb-namespaced/<agent>/` und Memories über Dreaming/Migrate/embed-promoted neu aufbauen lassen
3. **Andere baseDbPath** — `embedding.baseDbPath` umkonfigurieren auf `lancedb-namespaced-v2`, dann läuft alt+neu parallel

Vor jedem Wechsel: `node scripts/memory-doctor.mjs provider-check` — checkt API + alle Agent-DBs, schlägt Alarm bei Inkonsistenz.

---

## Update / Rollback

```bash
# Nur Plugin aktualisieren
./scripts/install-memory-system.sh --update-plugin-only /pfad/zu/.openclaw
systemctl --user restart openclaw-gateway.service

# Rollback letzter Snapshot
./scripts/install-memory-system.sh --rollback /pfad/zu/.openclaw
systemctl --user restart openclaw-gateway.service
```

---

## Features

### Recall-Pipeline (v1.8.0+)

- **Canonical-First Recall** — `KNOWLEDGE.md` wird semantisch VOR LanceDB durchsucht. Kuratierte Wahrheit kommt zuerst im `<relevant-memories>`-Block.
- **Importance-Boost** — Score wird angepasst zu `score * (1 + importance * 0.3)`. High-importance Memories rutschen nach oben.
- **Inter-Result-Dedup** — Nach Cohere-Rerank werden ähnliche Memories (Jaccard ≥ 0.6) suprimiert. Verhindert dass 5 Varianten desselben Sachverhalts den Kontext fluten.
- **Cohere Reranker** — Optionales zweistufiges Retrieval (Top-20 → Cohere v3.5 → Top-5).

### Capture-Pipeline

- **Auto-Capture** — speichert automatisch relevante Gesprächsinhalte nach jedem Turn (Plugin-Hook + Cron-Fallback).
- **Cron-Fallback** (`auto-capture-lancedb.mjs`) — verarbeitet Sessions wenn Plugin-Hook geblockt ist (OpenClaw 4.x Schema-Issue). v1.8.2: Trajectory-Filter, Dynamic Agent Discovery, Byte-Offset-State-Tracking, Multi-File-Sweep.
- **LLM-Summarization** — überlange Nachrichten (>15K Zeichen) werden via LLM zusammengefasst statt verworfen.
- **URL- und Attachment-Priorisierung** — Links und Dateianhänge gehen nie verloren.
- **Provenance-Tracking** (v1.8.0+) — jede Memory bekommt `sourceTurnId`, `sourceMessageRole`, `sourceTimestamp`, `sourceUrl`, `evidenceQuote`, `scope`.

### Storage-Schicht

- **Per-Agent-Isolation** — jeder Agent hat seine eigene LanceDB-Datenbank.
- **LLM-Merging** — logisch verwandte Memories werden automatisch zusammengeführt (Score 0.70-0.94).
- **TTL-System** — `session` (24h), `short` (14 Tage), permanent.
- **Schicht 1.5 / KNOWLEDGE.md** — kuratierte Wissensbasis mit YAML-Frontmatter (`last_verified`, `source_memories`), automatische Kompaktierung bei >200 Zeilen.
- **Embedding-Fallback** — zweiter Embedding-Endpunkt bei Primary-Ausfall.
- **Embedding-Retry** — exponentieller Backoff bei Rate-Limits.
- **Atomic Writes** — KNOWLEDGE.md via temp+rename, Lock-File via `wx`-Flag.
- **Conflict-Log** — semantisch ähnliche Decision-Memories zwischen Agenten werden geloggt mit proaktivem Review-Reminder.

### Health & Wartung

- **`memory-doctor stats`** — Anzahl, Speicher, Decision-Count, storedBy-Lücken pro Agent
- **`memory-doctor dupes`** — Cluster fast-identischer Memories via Jaccard
- **`memory-doctor stale`** — Memories älter X Tage mit niedriger Importance
- **`memory-doctor orphans`** — Memories ohne `storedBy` oder `origin`
- **`memory-doctor pending`** — High-Importance Memories nicht in `KNOWLEDGE.md`
- **`memory-doctor eval [agent] [raw\|pipeline]`** — Recall-Eval (raw=LanceDB-only, pipeline=full Live-Pipeline)
- **`memory-doctor provider-check`** (v2.1.1+) — validiert Embedding-Endpoint, Modell, Dim, alle DB-Dim-Konsistenz

### Dreaming (Schicht 4)

- **Natives Dreaming** — `memory-core` als Slot-Owner führt light/REM/deep Phasen pro Workspace durch.
- **Workspace-Isolation** — Bernds Dreams ≠ Bernhardines Dreams ≠ Heisenbergs Dreams.
- **Cross-Pollination** innerhalb eines Workspace — Subagents teilen sich den Dream-Kontext.
- **Dreaming → LanceDB Bridge** (`embed-promoted-memories.mjs`) — neue MEMORY.md-Promotionen werden alle 30 Min nachgebettet.

### OpenClaw-Patches

`patches/apply-memory-patches.sh` wird bei der Installation automatisch ausgeführt (Schritt 9). Aktive Patches:

| Patch | Datei | Was |
|---|---|---|
| **#16** Stuck-Session-Abort | `diagnostic-*.js` | SIGUSR1 wenn Session > `stuckSessionAbortMs` (Default 600s) hängt |
| **#17** Cohere Rerank | `manager-*.js` | `rerank-v3.5` nach `mergeHybridResults()` — bessere Top-K-Sortierung |
| **#18** Active-Memory Fast-Path | `active-memory/index.js` | Retired/no-op auf aktuellen Builds, damit plur1bus nicht umgangen wird |
| **#19** plur1bus User Hotfix | `selection-*.js`, `pi-tools-*.js`, `tools-*.js`, `active-memory/index.js` | aktive Gateway-Registry wiederverwenden, `toolsAllow` vor Plugin-Factories, Plugin-Deskriptor-Cache, kürzeres active-memory Hook-Budget, non-blocking `boot-md` |

Der 4.29-Latenzfix ist **OpenClaw-Bundle-Namen-unabhängig**: das Script findet die aktuellen `selection-*`, `pi-tools-*` und `tools-*` Bundles per Inhalt. Bei künftigen Updates muss nur `apply-memory-patches.sh` erneut laufen.

---

## Voraussetzungen

- [OpenClaw](https://github.com/openclaw) Gateway ≥ 2026.4.29
- Node.js ≥ 18
- Embedding API Key (OpenAI-kompatibel oder OpenRouter; Modell und Dimension werden im Installer abgefragt)
- Cohere API Key (optional, für Reranking)
- LLM-API (optional, für Merging + Summarization + KNOWLEDGE.md — kompatibel mit kimi-for-coding, GPT-4, Claude, etc.)

---

## Architektur

```
plugins.slots.memory = "memory-core"              ← Slot-Owner, Dreaming
memory-lancedb-namespaced.kind = "extension"      ← Auto-Capture/Recall per Agent

┌── Laufzeit (jeder Turn) ──────────────────────────────────────────┐
│  User-Nachricht                                                    │
│      │                                                             │
│      ▼                                                             │
│  Auto-Recall:                                                      │
│      1. Search KNOWLEDGE.md (canonical-first, mtime-cached)        │
│      2. LanceDB vector search (Top-20)                             │
│      3. Importance-Boost                                           │
│      4. Cohere Rerank (optional)                                   │
│      5. Inter-Result-Dedup                                         │
│      → Top-5 als <relevant-memories>                               │
│      │                                                             │
│      ▼                                                             │
│  Agent antwortet                                                   │
│      │                                                             │
│      ▼                                                             │
│  Auto-Capture (Plugin-Hook oder 5-Min-Cron):                       │
│      → Provenance-Felder erfasst (turnId, role, timestamp, URL)    │
│      → >15K Zeichen? LLM-Summarize                                 │
│      → Duplicate-Check (≥0.95) skip                                │
│      → Merge-Check (0.70-0.94) LLM-konsolidieren                   │
│      → Sonst: store                                                │
└────────────────────────────────────────────────────────────────────┘

┌── Dreaming (memory-core, periodisch pro Workspace) ───────────────┐
│  Light Sleep → REM Sleep → Deep Sleep                              │
│  → memory/.dreams/, MEMORY.md, Dream Diary                         │
│  → embed-promoted-memories.mjs bridged neue Promotionen → LanceDB  │
└────────────────────────────────────────────────────────────────────┘

┌── Wartung (System-Cron) ──────────────────────────────────────────┐
│  03:00  memory-gc.mjs                — TTL-Purge                   │
│  alle 5 Min  auto-capture-lancedb    — Capture-Fallback            │
│  alle 30 Min embed-promoted-memories — Dreaming-Bridge             │
│  on-demand   memory-doctor           — Health, Eval, Wartung       │
└────────────────────────────────────────────────────────────────────┘
```

---

## Vollständige Dokumentation

→ [`how-to-memory-perfect.md`](how-to-memory-perfect.md) — vollständige Architektur, Konfigurations-Referenz, Upgrade-Anleitungen, Security-Audits, Troubleshooting.

→ [`CHANGELOG.md`](CHANGELOG.md) — Versionshistorie mit allen Breaking-Changes und Migrations-Anweisungen.

---

## Lizenz

MIT

---

<a name="english"></a>
## English

A production-grade memory system for [OpenClaw](https://github.com/openclaw) agents with **four memory layers**, **native dreaming**, **canonical-first recall** and full **provenance tracking**.

Built and battle-tested in production across 38 agents over several months.

---

## What is this?

This package solves the core problem of LLM agents: **amnesia between sessions.**

**Current version:** `2.1.13` — OpenClaw `2026.4.29` is the minimum version; the installer preserves existing providers/models or configures fresh installs by explicit user choice.

**Minimum version:** OpenClaw `2026.4.29` or newer. Older versions are not supported by the current installer.

**OpenClaw 2026.4.29 hotfix:** `patches/apply-plur1bus-user-hotfix.sh` keeps plur1bus/ActiveMemory enabled and reduces prompt-build latency through early `toolsAllow`, plugin-registry reuse, plugin-descriptor caching, lazy media/web tool descriptors, an isolated ActiveMemory command lane, session-isolated embedded agent lanes, due-aware startup heartbeats, stale task-zombie reconciliation, and real silent replies in direct chats.

```
Layer 1    Flat-File Memory     workspace/memory/YYYY-MM-DD.md — human-readable
Layer 1.5  KNOWLEDGE.md         Curated knowledge base with YAML frontmatter
Layer 2    Workspace Indexer    SQLite + vector embeddings of all .md files
Layer 3    LanceDB              Conversation facts, semantically searchable
Layer 4    Dreaming             Native memory-core (light → REM → deep) per workspace
```

The agent writes, the system remembers automatically. Dreaming consolidates memories overnight into MEMORY.md and the Dream Diary.

---

## Contents

```
extensions/
  memory-lancedb-namespaced/   ← Main plugin (OpenClaw Gateway plugin)
  memory-lancedb-stock/        ← LanceDB wrapper (dependency, requires npm install)
patches/
  apply-memory-patches.sh      ← OpenClaw patches (stuck-session, cohere-rerank, 4.29 latency fix)
  apply-plur1bus-user-hotfix.sh ← User hotfix for OpenClaw 2026.4.29 tool-prep/prompt blocking
scripts/
  install-memory-system.sh     ← Installation, update, registry refresh, rollback + patches (with auto-discovery)
  bump-version.sh              ← Synchronizes versions in manifest + CHANGELOG
  memory-gc.mjs                ← TTL garbage collector (daily via cron at 03:00)
  memory-doctor.mjs            ← Health CLI (stats/dupes/stale/orphans/pending/eval/provider-check)
  recall-eval.sample.json      ← Template for recall-eval.json (real test file in .gitignore)
  auto-capture-lancedb.mjs     ← Cron fallback for auto-capture (every 5 minutes)
  embed-promoted-memories.mjs  ← Bridge dreaming promotions → LanceDB (every 30 min)
  migrate-memory-md-to-lancedb.mjs  ← One-shot MEMORY.md → LanceDB migration
  cleanup-session-history.mjs  ← Cleans bloated OpenClaw session transcripts
how-to-memory.md               ← Quick reference (concepts and setup)
how-to-memory-perfect.md       ← Full documentation (architecture, upgrades, patches)
CHANGELOG.md                   ← Version history
```

---

## Quickstart

```bash
# Install dependencies (once)
cd extensions/memory-lancedb-stock && npm install

# Install — auto-detects OpenClaw
./scripts/install-memory-system.sh

# Explicit path:
./scripts/install-memory-system.sh /path/to/.openclaw

# Remote:
./scripts/install-memory-system.sh user@host:/path/to/.openclaw
```

The script:
- Auto-detects local OpenClaw installations
- Shows a selection menu when multiple instances are found
- Prompts for API keys (**OpenAI OR OpenRouter** for embeddings, optional Cohere for reranking, kimi-for-coding/GPT-4 for merging)
- For OpenRouter (v2.1+): lists 20+ embedding models live, auto-detects vector dimension via test call
- **Pre-flight check** (v2.1.1+) — compares new dim against existing agent DBs, warns on mismatch (provider switch needs fresh DB!)
- Creates a LanceDB snapshot before making changes
- Sets up a daily cron job for garbage collection

### ⚠️ Provider Switch: Important Warning

LanceDB has **fixed vector dimension per table**. Switching from OpenAI (3072d) to BAAI (1024d) or NVIDIA (2048d) → existing DB is incompatible. Options:

1. **Stay on existing config** — proven path
2. **Fresh DB per agent** — `rm -r /path/to/lancedb-namespaced/<agent>/` and let Dreaming/Migrate/embed-promoted rebuild
3. **Different baseDbPath** — reconfigure `embedding.baseDbPath` to `lancedb-namespaced-v2`, run old+new in parallel

Before any switch: `node scripts/memory-doctor.mjs provider-check` — checks API + all agent DBs, raises alarm on inconsistency.

---

## Update / Rollback

```bash
# Update plugin only — no config changes, no API key prompts
./scripts/install-memory-system.sh --update-plugin-only /path/to/.openclaw
systemctl --user restart openclaw-gateway.service

# Rollback latest snapshot
./scripts/install-memory-system.sh --rollback /path/to/.openclaw
systemctl --user restart openclaw-gateway.service
```

---

## Features

### Recall pipeline (v1.8.0+)

- **Canonical-first recall** — `KNOWLEDGE.md` is semantically searched BEFORE LanceDB. Curated truth comes first in the `<relevant-memories>` block.
- **Importance boost** — score is adjusted to `score * (1 + importance * 0.3)`. High-importance memories climb to the top.
- **Inter-result dedup** — after Cohere rerank, similar memories (Jaccard ≥ 0.6) are suppressed. Prevents 5 variants of the same fact flooding the context.
- **Cohere reranker** — optional two-stage retrieval (top-20 → Cohere v3.5 → top-5).

### Capture pipeline

- **Auto-capture** — automatically saves relevant conversation content after each turn (plugin hook + cron fallback).
- **Cron fallback** (`auto-capture-lancedb.mjs`) — handles capture when the plugin hook is blocked (OpenClaw 4.x schema issue). v1.8.2: trajectory filter, dynamic agent discovery, byte-offset state tracking, multi-file sweep.
- **LLM summarization** — oversized messages (>15K chars) are LLM-summarized instead of dropped.
- **URL and attachment prioritization** — links and file attachments from the user are never lost.
- **Provenance tracking** (v1.8.0+) — every memory gets `sourceTurnId`, `sourceMessageRole`, `sourceTimestamp`, `sourceUrl`, `evidenceQuote`, `scope`.

### Storage layer

- **Per-agent isolation** — each agent has its own LanceDB database.
- **LLM merging** — logically related memories are automatically consolidated (score 0.70-0.94).
- **TTL system** — `session` (24h), `short` (14 days), permanent.
- **Layer 1.5 / KNOWLEDGE.md** — curated knowledge base with YAML frontmatter (`last_verified`, `source_memories`), automatic compaction beyond 200 lines.
- **Embedding fallback** — secondary embedding endpoint on primary failure.
- **Embedding retry** — exponential backoff on rate limits.
- **Atomic writes** — KNOWLEDGE.md via temp+rename, lock file via `wx` flag.
- **Conflict log** — semantically similar decision memories across agents are logged with a proactive review reminder.

### Health & maintenance

- **`memory-doctor stats`** — count, storage, decision-count, storedBy gaps per agent
- **`memory-doctor dupes`** — clusters of near-identical memories via Jaccard
- **`memory-doctor stale`** — memories older than X days with low importance
- **`memory-doctor orphans`** — memories without `storedBy` or `origin`
- **`memory-doctor pending`** — high-importance memories not in `KNOWLEDGE.md`
- **`memory-doctor eval [agent] [raw\|pipeline]`** — recall eval (raw=LanceDB-only, pipeline=full live pipeline)
- **`memory-doctor provider-check`** (v2.1.1+) — validates embedding endpoint, model, dim, all DB-dim consistency

### Dreaming (Layer 4)

- **Native dreaming** — `memory-core` as slot owner runs light/REM/deep phases per workspace.
- **Workspace isolation** — Bernd's dreams ≠ Bernhardine's dreams ≠ Heisenberg's dreams.
- **Cross-pollination** within a workspace — subagents share the dream context.
- **Dreaming → LanceDB bridge** (`embed-promoted-memories.mjs`) — new MEMORY.md promotions are embedded every 30 min.

### OpenClaw Patches

`patches/apply-memory-patches.sh` runs automatically during installation (step 9). Active patches:

| Patch | File | What |
|---|---|---|
| **#16** Stuck-Session Abort | `diagnostic-*.js` | SIGUSR1 when session exceeds `stuckSessionAbortMs` (default 600s) |
| **#17** Cohere Rerank | `manager-*.js` | `rerank-v3.5` after `mergeHybridResults()` — better top-K ranking |
| **#18** Active-Memory Fast-Path | `active-memory/index.js` | Retired/no-op on current builds so plur1bus is not bypassed |
| **#19** plur1bus User Hotfix | `selection-*.js`, `pi-tools-*.js`, `tools-*.js`, `active-memory/index.js` | Reuses the active Gateway registry, applies `toolsAllow` before plugin factories, adds a plugin descriptor cache, caps active-memory hook waits, makes `boot-md` non-blocking |

The 4.29 latency fix is **OpenClaw bundle-name independent**: the script finds the current `selection-*`, `pi-tools-*` and `tools-*` bundles by content. After future OpenClaw updates, re-running `apply-memory-patches.sh` restores all patches.

---

## Requirements

- [OpenClaw](https://github.com/openclaw) Gateway ≥ 2026.4.29
- Node.js ≥ 18
- Embedding API key (OpenAI-compatible or OpenRouter; model and dimensions are selected in the installer)
- Cohere API key (optional, for reranking)
- Any LLM API (optional, for merging + summarization + KNOWLEDGE.md — compatible with kimi-for-coding, GPT-4, Claude, etc.)

---

## Architecture

```
plugins.slots.memory = "memory-core"              ← Slot owner, dreaming
memory-lancedb-namespaced.kind = "extension"      ← Auto-capture/recall per agent

┌── Runtime (every turn) ───────────────────────────────────────────┐
│  User message                                                      │
│      │                                                             │
│      ▼                                                             │
│  Auto-recall:                                                      │
│      1. Search KNOWLEDGE.md (canonical-first, mtime-cached)        │
│      2. LanceDB vector search (top-20)                             │
│      3. Importance boost                                           │
│      4. Cohere rerank (optional)                                   │
│      5. Inter-result dedup                                         │
│      → Top-5 as <relevant-memories>                                │
│      │                                                             │
│      ▼                                                             │
│  Agent responds                                                    │
│      │                                                             │
│      ▼                                                             │
│  Auto-capture (plugin hook or 5-min cron):                         │
│      → Provenance fields captured (turnId, role, timestamp, URL)   │
│      → >15K chars? LLM-summarize                                   │
│      → Duplicate check (≥0.95) skip                                │
│      → Merge check (0.70-0.94) LLM-consolidate                     │
│      → Otherwise: store                                            │
└────────────────────────────────────────────────────────────────────┘

┌── Dreaming (memory-core, periodic per workspace) ─────────────────┐
│  Light sleep → REM sleep → Deep sleep                              │
│  → memory/.dreams/, MEMORY.md, Dream Diary                         │
│  → embed-promoted-memories.mjs bridges new promotions → LanceDB    │
└────────────────────────────────────────────────────────────────────┘

┌── Maintenance (system cron) ──────────────────────────────────────┐
│  03:00       memory-gc.mjs                — TTL purge              │
│  every 5 min auto-capture-lancedb         — capture fallback       │
│  every 30 min embed-promoted-memories     — dreaming bridge        │
│  on-demand   memory-doctor                — health, eval, ops      │
└────────────────────────────────────────────────────────────────────┘
```

---

## Session History Cleanup

OpenClaw versions with append-only transcript branch rewrites can leave inactive
JSONL entries in session history. Newer runtime reads follow the active
`parentId` branch, but existing files can still stay physically bloated.

Use the cleanup script in dry-run mode first:

```bash
node scripts/cleanup-session-history.mjs --agent main --agent bernhardine --agent heisenberg
```

Apply the rewrite with backups:

```bash
node scripts/cleanup-session-history.mjs --agent main --agent bernhardine --agent heisenberg --write
```

The script preserves leading session metadata, keeps the active transcript
branch, writes backups to `.history-cleanup-backups/`, and ignores archived
`*.deleted.*` plus `*.trajectory.jsonl` files unless explicitly requested.

---

## Full Documentation

→ [`how-to-memory-perfect.md`](how-to-memory-perfect.md) — full architecture, configuration reference, upgrade guides, security audits, troubleshooting.

→ [`CHANGELOG.md`](CHANGELOG.md) — version history with all breaking changes and migration instructions.

---

## License

MIT
