# OpenClaw Memory System

*[Deutsch](#deutsch) | [English](#english)*

[![Latest Release](https://img.shields.io/badge/release-v3.0.0--neo-blue)](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/tree/neo-arch)

---

<a name="deutsch"></a>
## Deutsch

Produktionsreifes Gedächtnissystem für [OpenClaw](https://github.com/openclaw)-Agenten mit **vier Memory-Schichten**, **nativem Dreaming**, **Canonical-First Recall** und voller **Provenance**.

**Aktuelle Version:** `3.0.0` (Branch `neo-arch`) — führt die **Neo-Arch-Kognitionsschicht** ein: 24 Kategorien, 6 Trust-Levels, 14 Recall-Lanes und ein Turn-Journal mit provenanzierter Status-Maschine (`pending → curated → canonical → archived`). Kompatibel mit OpenClaw ≥ `2026.4.29`. Der Haupt-LLM-Provider von OpenClaw ist frei wählbar.

> **Branch-Übersicht:** `main` = stabile v2.1.x (ohne Neo-Arch). `neo-arch` = v3.0.0 mit erweitertem kognitiven Modell. Wer nur das bewährte LanceDB-Plugin braucht, kann auf `main` bleiben.

**Mindestversion:** OpenClaw `2026.4.29` oder neuer. Ältere Versionen werden vom aktuellen Installer nicht unterstützt.

**Neo-Arch Runtime-Regel:** Im Branch `neo-arch` ist PLUR1BUS ein OpenClaw-natives Augment/Supplement. `memory-core` bleibt Slot-Owner; PLUR1BUS registriert Tools, Hooks, Prompt-/Corpus-Supplements und Gateway-Lifecycle-Handler. OpenClaw-dist-Patches, `ExecStartPre`, root/user-cron und `systemctl` sind kein Primaerpfad.

**Legacy/OpenClaw-Compat-Patches:** `patches/apply-memory-patches.sh` bleibt als historischer Operator-Fallback erhalten. Der neo-arch-Normalbetrieb darf davon nicht abhaengen.

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
  apply-memory-patches.sh      ← OpenClaw-Patches (Stuck-Session, Cohere-Rerank, versionierte Compat-Patches)
  apply-openclaw-20260429-compat.sh ← Wrapper für den 4.29-Hotfix
  apply-openclaw-20260503-compat.sh ← Lokaler OpenClaw 2026.5.3-1 Compat-Patch
  apply-openclaw-20260504-compat.sh ← Lokaler OpenClaw 2026.5.4/2026.5.5/2026.5.6/2026.5.7 Compat-Patch
  apply-plur1bus-user-hotfix.sh ← Historischer OpenClaw 2026.4.29 Tool-Prep/Prompt-Blocking-Hotfix
scripts/
  install-memory-system.sh     ← Installation, Update, Registry-Refresh, Rollback + Patches (mit Auto-Discovery)
  bump-version.sh              ← Synchronisiert Versions in Manifest + CHANGELOG
  memory-gc.mjs                ← TTL-Garbage-Collector (täglich via Cron, 03:00)
  memory-doctor.mjs            ← Health-CLI (stats/dupes/stale/orphans/pending/eval/provider-check)
  maintain-knowledge-md.mjs    ← Workspace-scoped KNOWLEDGE.md Check/Fresh/Backfill-Maintainer
  recall-eval.sample.json      ← Vorlage für recall-eval.json (echte Test-Datei in .gitignore)
  auto-capture-lancedb.mjs     ← Legacy/Operator-Fallback; neo-arch nutzt agent_end
  embed-promoted-memories.mjs  ← Bridge Dreaming-Promotionen → LanceDB (alle 30 Min)
  migrate-memory-md-to-lancedb.mjs  ← Einmalige MEMORY.md → LanceDB Migration
  cleanup-session-history.mjs  ← Bereinigt aufgeblähte OpenClaw-Session-Transcripts
how-to-memory-perfect.md       ← öffentliche/kanonische Dokumentation (Architektur, Upgrades, Patches, Betrieb)
HOW-TO-UPDATE.md               ← sicherer OpenClaw/plur1bus Update- und Release-Ablauf
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
- Fragt nach API-Keys (**OpenAI-kompatibel ODER OpenRouter** für Embeddings, optional Cohere für Reranking, beliebiger OpenAI-kompatibler Chat-Completions-Anbieter für Merging)
- Bei OpenRouter (v2.1+): listet 20+ Embedding-Modelle live, ermittelt Vektor-Dimension automatisch via Test-Call
- Setzt bei optionalem Merging kein Chat-Modell heimlich voraus; der User muss das Merging-Modell explizit wählen
- **Pre-Flight-Check** (v2.1.1+) — vergleicht neue Dim mit bestehenden Agent-DBs, warnt bei Mismatch (Provider-Wechsel braucht fresh DB!)
- Erstellt LanceDB-Snapshot vor Änderungen
- Konfiguriert OpenClaw-native Hook-Rechte (`allowConversationAccess`, `allowPromptInjection`) und Hook-Timeouts

### ⚠️ Provider-Wechsel: Wichtige Warnung

LanceDB hat **fixe Vektor-Dimension pro Tabelle**. Wechsel von OpenAI (3072d) zu BAAI (1024d) oder NVIDIA (2048d) → bestehende DB ist inkompatibel. Optionen:

1. **Bei alter Config bleiben** — bewährter Pfad
2. **Fresh-DB pro Agent** — `rm -r /pfad/zu/lancedb-namespaced/<agent>/` und Memories über Dreaming/Migrate/embed-promoted neu aufbauen lassen
3. **Andere baseDbPath** — `embedding.baseDbPath` umkonfigurieren auf `lancedb-namespaced-v2`, dann läuft alt+neu parallel

Vor jedem Wechsel: `node scripts/memory-doctor.mjs provider-check` — checkt API + alle Agent-DBs, schlägt Alarm bei Inkonsistenz.

### Provider-Kompatibilität

| Bereich | Provider-Anforderung |
|---------|----------------------|
| OpenClaw-Hauptmodell | Frei wählbar: jeder von OpenClaw unterstützte Chat-Provider |
| Embeddings | OpenAI-kompatible `/embeddings` API oder OpenRouter; `model` und `dimensions` müssen zur DB passen |
| Reranking | Optional Cohere; ohne Key bleibt Vector-only Recall aktiv |
| Merging / Summarization / KNOWLEDGE.md | Optional; braucht explizites `merging.model` bzw. `schicht15.model` auf einem OpenAI-kompatiblen Chat-Completions-Endpunkt |

plur1bus setzt kein Chat-Modell für OpenClaw voraus. Bestehende Agent-, Subagent-, Session- und Cron-Modellrouten bleiben Aufgabe der OpenClaw-Konfiguration; der Installer überschreibt sie nicht ungefragt. Nur die Memory-internen Embedding- und optionalen LLM-Endpunkte müssen passend konfiguriert sein.

### Native Workspace-Suche

Die native OpenClaw-Workspace-Suche `agents.defaults.memorySearch` ist optional und unabhängig von plur1bus. Sie kann aktiv bleiben, wenn ein passender Embedding-Provider konfiguriert ist. Sie kann auch deaktiviert werden, ohne Auto-Recall/Auto-Capture von `memory-lancedb-namespaced` abzuschalten.

### Migration von v2.1.x auf Neo-Arch v3

Ein Upgrade von v2.1.x auf `neo-arch`/v3 ist ein **additiver In-Place-Upgrade**. Das Plugin wird zentral in der OpenClaw-Installation aktualisiert; die Neo-Arch-Daten entstehen danach **workspace-scoped** unter dem bestehenden `baseDbPath`. Du musst also nicht fuer jeden Agenten einen eigenen API-Key einrichten. Was pro Workspace entsteht, sind Turn-Journal, Candidates, Reaction Ledger, BehaviorCards, Embedding Queue und optional `memory/KNOWLEDGE.md`.

Empfohlener Ablauf:

1. `neo-arch` auschecken und vorab einen Snapshot der bestehenden LanceDB erstellen lassen: `./scripts/install-memory-system.sh --dry-run /pfad/zu/.openclaw`, danach ohne `--dry-run`.
2. Den bestehenden `baseDbPath` beibehalten, z.B. `~/.openclaw/memory/lancedb-namespaced`. Dadurch bleiben v2-Memories fuer `memory_recall` und Auto-Recall lesbar.
3. Embedding-Modell und `dimensions` unveraendert lassen, sofern du bestehende LanceDBs weiterverwenden willst. Ein Provider-/Dimensionswechsel braucht einen neuen `baseDbPath` oder einen Fresh-DB-Rebuild.
4. Hook-Rechte setzen: `hooks.allowConversationAccess=true`, `hooks.allowPromptInjection=true`, plus Timeouts fuer `before_prompt_build` und `agent_end`.
5. Pro Workspace pruefen, ob `memory/KNOWLEDGE.md` existiert oder per `knowledge_update`/Maintainer aufgebaut werden soll. Das ist workspace-spezifisch; die Provider-Keys bleiben zentral.
6. Nach dem Gateway-Restart verifizieren: `node scripts/memory-doctor.mjs provider-check`, `openclaw plugins doctor`, `/plur1bus doctor`, manueller `memory_recall`, `memory_search corpus=all`, ein realer `agent_end`-Capture.

Provider-Keys liegen in `openclaw.json` unter:

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-namespaced": {
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": true,
          "timeouts": {
            "before_prompt_build": 90000,
            "agent_end": 60000
          }
        },
        "config": {
          "embedding": {
            "apiKey": "${OPENAI_API_KEY}",
            "model": "text-embedding-3-large",
            "dimensions": 3072
          },
          "reranker": {
            "enabled": true,
            "apiKey": "${COHERE_API_KEY}",
            "model": "rerank-v3.5"
          },
          "baseDbPath": "~/.openclaw/memory/lancedb-namespaced",
          "autoCapture": true,
          "autoRecall": true
        }
      }
    }
  }
}
```

`autoCapture:false` schaltet nur automatische Hook-Capture aus, nicht `memory_store`, `knowledge_update` oder vorhandenen State. `autoRecall:false` schaltet nur automatische Prompt-Injection aus, nicht `memory_recall`, `memory_search corpus=all/wiki` oder das CorpusSupplement.

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

- **Auto-Capture** — default-on via `agent_end`, solange `autoCapture !== false`. `autoCapture:false` deaktiviert nur automatische Hook-Capture; `memory_store`, `knowledge_update`, Curation und bestehender PLUR1BUS-State bleiben nutzbar.
- **Auto-Recall** — default-on via genau einem Prompt-Injection-Pfad pro Turn. `autoRecall:false` deaktiviert nur automatische Prompt-Injection; `memory_recall`, `memory_search corpus=all/wiki`, CorpusSupplement und manuelle Recalls bleiben nutzbar.
- **Legacy-Fallback** (`auto-capture-lancedb.mjs`) — verarbeitet Sessions nur als expliziter Operator-Fallback, nicht als neo-arch-Primärpfad.
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
- **Workspace-Isolation** — getrennte Workspaces konsolidieren ihre Dreams unabhängig voneinander.
- **Cross-Pollination** innerhalb eines Workspace — Subagents teilen sich den Dream-Kontext.
- **Dreaming → LanceDB Bridge** (`embed-promoted-memories.mjs`) — neue MEMORY.md-Promotionen werden alle 30 Min nachgebettet.

### OpenClaw-Patches

`patches/apply-memory-patches.sh` wird bei der Installation automatisch ausgeführt (Schritt 9). Aktive Patches:

| Patch | Datei | Was |
|---|---|---|
| **#16** Stuck-Session-Abort | `diagnostic-*.js` | SIGUSR1 wenn Session > `stuckSessionAbortMs` (Default 600s) hängt |
| **#17** Cohere Rerank | `manager-*.js` | `rerank-v3.5` nach `mergeHybridResults()` — bessere Top-K-Sortierung |
| **#18** Active-Memory Fast-Path | `active-memory/index.js` | Retired/no-op auf aktuellen Builds, damit plur1bus nicht umgangen wird |
| **#19** plur1bus Compat | `apply-openclaw-20260429-compat.sh`, `apply-openclaw-20260503-compat.sh`, `apply-openclaw-20260504-compat.sh`, `active-memory/index.js`, `subagent-*.js`, `acp-spawn-*.js`, `heartbeat-runner-*.js`, `boot-md`, `agent-runner.runtime-*.js`, `openclaw.json` | versionierter 4.29/5.3/5.4-Compat; 5.3+ retired upstream-gefixte Tool-Allowlist-Patches und haelt ActiveMemory-Fallback, kurze Hook-Budgets, Lane-Isolation, Heartbeat-Backpressure, non-blocking Boot und Hidden-Flush stabil |
| **#20** Runtime-Deps Race Guard | `bundled-runtime-deps-*.js` | überspringt redundante `npm install`-Runs, wenn der gemeinsame Plugin-Runtime-Deps-Cache bereits semver-passende Pakete enthält; verhindert `ENOTEMPTY`-Rennen beim Laden von Telegram/Discord/memory-core |

Die Compat-Patches sind **OpenClaw-Bundle-Namen-unabhängig**: die Scripts finden die relevanten Bundles per Inhalt. Bei künftigen Updates muss `apply-memory-patches.sh` erneut laufen; neue OpenClaw-Versionen brauchen einen eigenen versionierten Patch, wenn Anchors oder Upstream-Verhalten abweichen.

---

## Voraussetzungen

- [OpenClaw](https://github.com/openclaw) Gateway ≥ 2026.4.29
- Node.js ≥ 18
- Embedding API Key (OpenAI-kompatibel oder OpenRouter; Modell und Dimension werden im Installer abgefragt)
- Cohere API Key (optional, für Reranking)
- OpenAI-kompatible Chat-Completions-API (optional, für Merging + Summarization + KNOWLEDGE.md; Modell muss explizit gesetzt werden)

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
│  Auto-Capture (agent_end-Hook, default-on):                        │
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

┌── Wartung (OpenClaw-native / Operator-Jobs) ──────────────────────┐
│  Plugin-Service                     — leichte Neo-Wartung          │
│  OpenClaw-Agent-Crons               — schwere Dreaming/Backfills   │
│  Legacy-Scripts                     — nur Operator-Fallback        │
│  on-demand memory-doctor            — Health, Eval, Wartung        │
└────────────────────────────────────────────────────────────────────┘
```

---

## Öffentliche Dokumentation

→ [`how-to-memory-perfect.md`](how-to-memory-perfect.md) — öffentliche kanonische Dokumentation: vollständige Architektur, Konfigurations-Referenz, Upgrade-Anleitungen, Betrieb, Security-Audits, Troubleshooting.

→ [`HOW-TO-UPDATE.md`](HOW-TO-UPDATE.md) — sichere Update- und Release-Checkliste.

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

**Current version:** `3.0.0` (branch `neo-arch`) — introduces the **Neo-Arch cognition layer**: 24 categories, 6 trust levels, 14 recall lanes, and a turn journal with provenance-tracked status machine (`pending → curated → canonical → archived`). Compatible with OpenClaw ≥ `2026.4.29`. OpenClaw's primary chat LLM provider is not constrained by plur1bus.

> **Branch overview:** `main` = stable v2.1.x (without Neo-Arch). `neo-arch` = v3.0.0 with extended cognitive model. If you only need the battle-tested LanceDB plugin, `main` is the safe default.

**Minimum version:** OpenClaw `2026.4.29` or newer. Older versions are not supported by the current installer.

**OpenClaw compatibility patches:** `patches/apply-memory-patches.sh` dispatches by OpenClaw version. OpenClaw `2026.4.29` uses the historical `apply-plur1bus-user-hotfix.sh`; OpenClaw `2026.5.3-1` uses `apply-openclaw-20260503-compat.sh`; OpenClaw `2026.5.4`, `2026.5.5`, `2026.5.6` and `2026.5.7` use `apply-openclaw-20260504-compat.sh`. The 5.3/5.4/5.5/5.6/5.7 patches keep ActiveMemory fallback/timeouts, isolated lanes, heartbeat backpressure, non-blocking `boot-md`, subagent completion announce caps, and the hidden flush prompt locally compatible.

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
  apply-memory-patches.sh      ← OpenClaw patches (stuck-session, cohere-rerank, versioned compat patches)
  apply-openclaw-20260429-compat.sh ← Wrapper for the 4.29 hotfix
  apply-openclaw-20260503-compat.sh ← Local OpenClaw 2026.5.3-1 compat patch
  apply-openclaw-20260504-compat.sh ← Local OpenClaw 2026.5.4/2026.5.5/2026.5.6/2026.5.7 compat patch
  apply-plur1bus-user-hotfix.sh ← Historical OpenClaw 2026.4.29 tool-prep/prompt-blocking hotfix
scripts/
  install-memory-system.sh     ← Installation, update, registry refresh, rollback + patches (with auto-discovery)
  bump-version.sh              ← Synchronizes versions in manifest + CHANGELOG
  memory-gc.mjs                ← TTL garbage collector (daily via cron at 03:00)
  memory-doctor.mjs            ← Health CLI (stats/dupes/stale/orphans/pending/eval/provider-check)
  maintain-knowledge-md.mjs    ← Workspace-scoped KNOWLEDGE.md check/fresh/backfill maintainer
  recall-eval.sample.json      ← Template for recall-eval.json (real test file in .gitignore)
  auto-capture-lancedb.mjs     ← Cron fallback for auto-capture (every 5 minutes)
  embed-promoted-memories.mjs  ← Bridge dreaming promotions → LanceDB (every 30 min)
  migrate-memory-md-to-lancedb.mjs  ← One-shot MEMORY.md → LanceDB migration
  cleanup-session-history.mjs  ← Cleans bloated OpenClaw session transcripts
how-to-memory-perfect.md       ← public/canonical documentation (architecture, upgrades, patches, operations)
HOW-TO-UPDATE.md               ← safe OpenClaw/plur1bus update and release flow
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
- Prompts for API keys (**OpenAI-compatible OR OpenRouter** for embeddings, optional Cohere for reranking, any OpenAI-compatible chat-completions provider for merging)
- For OpenRouter (v2.1+): lists 20+ embedding models live, auto-detects vector dimension via test call
- Does not silently assume a chat model for optional merging; the user must choose the merging model explicitly
- **Pre-flight check** (v2.1.1+) — compares new dim against existing agent DBs, warns on mismatch (provider switch needs fresh DB!)
- Creates a LanceDB snapshot before making changes
- Sets up a daily cron job for garbage collection

### ⚠️ Provider Switch: Important Warning

LanceDB has **fixed vector dimension per table**. Switching from OpenAI (3072d) to BAAI (1024d) or NVIDIA (2048d) → existing DB is incompatible. Options:

1. **Stay on existing config** — proven path
2. **Fresh DB per agent** — `rm -r /path/to/lancedb-namespaced/<agent>/` and let Dreaming/Migrate/embed-promoted rebuild
3. **Different baseDbPath** — reconfigure `embedding.baseDbPath` to `lancedb-namespaced-v2`, run old+new in parallel

Before any switch: `node scripts/memory-doctor.mjs provider-check` — checks API + all agent DBs, raises alarm on inconsistency.

### Provider Compatibility

| Area | Provider requirement |
|------|----------------------|
| OpenClaw primary model | Unrestricted: any chat provider supported by OpenClaw |
| Embeddings | OpenAI-compatible `/embeddings` API or OpenRouter; `model` and `dimensions` must match the DB |
| Reranking | Optional Cohere; without a key, vector-only recall remains active |
| Merging / summarization / KNOWLEDGE.md | Optional; requires explicit `merging.model` or `schicht15.model` on an OpenAI-compatible chat-completions endpoint |

plur1bus does not require a specific OpenClaw chat model. Existing agent, subagent, session and cron model routes remain part of the OpenClaw configuration; the installer does not overwrite them without an explicit user choice. Only the memory-internal embedding and optional LLM endpoints need compatible configuration.

### Native Workspace Search

Native OpenClaw workspace search via `agents.defaults.memorySearch` is optional and independent from plur1bus. It can remain enabled when a compatible embedding provider is configured. It can also be disabled without disabling Auto-Recall or Auto-Capture from `memory-lancedb-namespaced`.

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
- **Workspace isolation** — separate workspaces consolidate their dreams independently.
- **Cross-pollination** within a workspace — subagents share the dream context.
- **Dreaming → LanceDB bridge** (`embed-promoted-memories.mjs`) — new MEMORY.md promotions are embedded every 30 min.

### OpenClaw Patches

`patches/apply-memory-patches.sh` runs automatically during installation (step 9). Active patches:

| Patch | File | What |
|---|---|---|
| **#16** Stuck-Session Abort | `diagnostic-*.js` | SIGUSR1 when session exceeds `stuckSessionAbortMs` (default 600s) |
| **#17** Cohere Rerank | `manager-*.js` | `rerank-v3.5` after `mergeHybridResults()` — better top-K ranking |
| **#18** Active-Memory Fast-Path | `active-memory/index.js` | Retired/no-op on current builds so plur1bus is not bypassed |
| **#19** plur1bus Compat | `apply-openclaw-20260429-compat.sh`, `apply-openclaw-20260503-compat.sh`, `apply-openclaw-20260504-compat.sh`, `active-memory/index.js`, `subagent-*.js`, `acp-spawn-*.js`, `heartbeat-runner-*.js`, `boot-md`, `agent-runner.runtime-*.js`, `openclaw.json` | Versioned 4.29/5.3/5.4 compat; 5.3+ retires upstream-fixed tool allowlist patches and keeps ActiveMemory fallback, short hook budgets, lane isolation, heartbeat backpressure, non-blocking boot and hidden flush stable |
| **#20** Runtime-Deps Race Guard | `bundled-runtime-deps-*.js` | Skips redundant `npm install` runs when the shared plugin runtime-deps cache already contains semver-compatible packages; prevents `ENOTEMPTY` races while loading Telegram/Discord/memory-core |

The compat patches are **OpenClaw bundle-name independent**: scripts find the relevant bundles by content. After future OpenClaw updates, re-running `apply-memory-patches.sh` restores known patches; new OpenClaw versions need their own versioned patch when anchors or upstream behavior change.

---

## Requirements

- [OpenClaw](https://github.com/openclaw) Gateway ≥ 2026.4.29
- Node.js ≥ 18
- Embedding API key (OpenAI-compatible or OpenRouter; model and dimensions are selected in the installer)
- Cohere API key (optional, for reranking)
- OpenAI-compatible chat-completions API (optional, for merging + summarization + KNOWLEDGE.md; model must be set explicitly)

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
node scripts/cleanup-session-history.mjs --agent main --agent agent-a --agent agent-b
```

Apply the rewrite with backups:

```bash
node scripts/cleanup-session-history.mjs --agent main --agent agent-a --agent agent-b --write
```

The script preserves leading session metadata, keeps the active transcript
branch, writes backups to `.history-cleanup-backups/`, and ignores archived
`*.deleted.*` plus `*.trajectory.jsonl` files unless explicitly requested.

---

## Public Documentation

→ [`how-to-memory-perfect.md`](how-to-memory-perfect.md) — public canonical documentation: full architecture, configuration reference, upgrade guides, operations, security audits, troubleshooting.

→ [`HOW-TO-UPDATE.md`](HOW-TO-UPDATE.md) — safe update and release checklist.

→ [`CHANGELOG.md`](CHANGELOG.md) — version history with all breaking changes and migration instructions.

---

## License

MIT
