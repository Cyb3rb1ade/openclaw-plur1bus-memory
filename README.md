# OpenClaw Memory System

*[Deutsch](#deutsch) | [English](#english)*

---

<a name="deutsch"></a>
## Deutsch

Produktionsreifes Gedächtnissystem für [OpenClaw](https://github.com/openclaw)-Agenten mit **drei Memory-Schichten** und **nativem Dreaming**.

Entwickelt und erprobt im produktiven Einsatz mit 38 Agenten über mehrere Monate.

---

## Was ist das?

Dieses Paket löst das Kernproblem von LLM-Agenten: **Amnesie zwischen Sessions.**

Es kombiniert drei Memory-Schichten und ein Dreaming-System:

```
Schicht 1   Flat-File Memory     workspace/memory/YYYY-MM-DD.md — menschenlesbar
Schicht 2   Workspace-Indexer    SQLite + Vektor-Embeddings aller .md-Dateien
Schicht 3   LanceDB              Konversations-Fakten, semantisch durchsuchbar
Schicht 4   Dreaming             Natives memory-core (light → REM → deep) pro Workspace
```

Alle Schichten arbeiten zusammen. Der Agent schreibt, das System erinnert sich automatisch.
Dreaming konsolidiert Memories über Nacht in MEMORY.md und Dream Diary.

---

## Inhalt

```
extensions/
  memory-lancedb-namespaced/   ← Das Hauptplugin (OpenClaw-Gateway-Plugin)
  memory-lancedb-stock/        ← LanceDB-Wrapper (Abhängigkeit, npm install nötig)
scripts/
  install-memory-system.sh     ← Installations- und Update-Skript
  memory-gc.mjs                ← TTL-Garbage-Collector (täglich via Cron)
how-to-memory-perfect.md       ← Vollständige Dokumentation (Konzepte, Setup, Upgrade)
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
- Fragt nach API-Keys (OpenAI für Embeddings, optional Cohere für Re-Ranking)
- Erstellt LanceDB-Snapshot vor Änderungen
- Richtet Cron-Job für täglichen GC ein

---

## Update / Rollback

```bash
# Nur Plugin aktualisieren
./scripts/install-memory-system.sh --update-plugin-only /pfad/zu/.openclaw
systemctl --user restart openclaw-gateway.service

# Rollback
./scripts/install-memory-system.sh --rollback /pfad/zu/.openclaw
systemctl --user restart openclaw-gateway.service
```

---

## Features

- **Per-Agent-Isolation** — jeder Agent hat seine eigene LanceDB-Datenbank (38 DBs in Produktion)
- **Auto-Capture** — speichert automatisch relevante Gesprächsinhalte nach jedem Turn
- **LLM-Summarization** — überlange Nachrichten (>15K Zeichen) werden via LLM zusammengefasst statt verworfen
- **URL- und Attachment-Priorisierung** — Links und Dateianhänge gehen nie verloren
- **Auto-Recall** — injiziert Top-5-relevante Memories vor jedem Turn
- **Cohere Re-Ranker** — optionales zweistufiges Retrieval für bessere Relevanz
- **LLM-Merging** — logisch verwandte Memories werden automatisch zusammengeführt
- **Natives Dreaming** — `memory-core` als Slot-Owner führt light/REM/deep Phasen pro Workspace durch
- **TTL-System** — `session` (24h), `short` (14 Tage), permanent
- **KNOWLEDGE.md** — kuratierte Wissensbasis mit automatischer Kompaktierung
- **Embedding-Fallback** — zweiter Embedding-Endpunkt bei Primary-Ausfall
- **Atomic Writes** — KNOWLEDGE.md via temp+rename, Lock-File via `wx`-Flag
- **Embedding-Retry** — exponentieller Backoff bei Rate-Limits

---

## Voraussetzungen

- [OpenClaw](https://github.com/openclaw) Gateway ≥ 2026.4.5 (für natives Dreaming)
- Node.js ≥ 18
- OpenAI API Key (für Embeddings: `text-embedding-3-large` oder `text-embedding-3-small`)
- Cohere API Key (optional, für Re-Ranking)
- LLM-API (optional, für Merging + Summarization — kompatibel mit kimi-for-coding, GPT-4, etc.)

---

## Architektur: Memory + Dreaming

```
plugins.slots.memory = "memory-core"              ← Slot-Owner, Dreaming
memory-lancedb-namespaced.kind = "extension"      ← Auto-Capture/Recall per Agent

┌── Laufzeit (jeder Turn) ──────────────────────────────────┐
│  User-Nachricht → Auto-Recall (LanceDB, Top-5, Reranked)  │
│  Agent antwortet → Auto-Capture (LanceDB, per Agent)       │
│                    └─ >15K Zeichen? → LLM-Summarize        │
└────────────────────────────────────────────────────────────┘

┌── Dreaming (automatisch, periodisch) ─────────────────────┐
│  memory-core pro Workspace:                                │
│    Light Sleep → REM Sleep → Deep Sleep                    │
│    → memory/.dreams/, MEMORY.md, Dream Diary               │
│  Workspace-Isolation: Bernd ≠ Bernhardine ≠ Heisenberg    │
│  Agent-Isolation: LanceDB bleibt strikt per Agent          │
└────────────────────────────────────────────────────────────┘
```

---

## Vollständige Dokumentation

→ [`how-to-memory-perfect.md`](how-to-memory-perfect.md)

---

## Lizenz

MIT

---

<a name="english"></a>
## English

A production-grade memory system for [OpenClaw](https://github.com/openclaw) agents with **three memory layers** and **native dreaming**.

Built and battle-tested in production across 38 agents over several months.

---

## What is this?

This package solves the core problem of LLM agents: **amnesia between sessions.**

It combines three memory layers and a dreaming system:

```
Layer 1   Flat-File Memory     workspace/memory/YYYY-MM-DD.md — human-readable
Layer 2   Workspace Indexer    SQLite + vector embeddings of all .md files
Layer 3   LanceDB              Conversation facts, semantically searchable
Layer 4   Dreaming             Native memory-core (light → REM → deep) per workspace
```

All layers work together. The agent writes, the system remembers automatically.
Dreaming consolidates memories overnight into MEMORY.md and Dream Diary.

---

## Contents

```
extensions/
  memory-lancedb-namespaced/   ← Main plugin (OpenClaw Gateway plugin)
  memory-lancedb-stock/        ← LanceDB wrapper (dependency, requires npm install)
scripts/
  install-memory-system.sh     ← Installation and update script
  memory-gc.mjs                ← TTL garbage collector (daily via cron)
how-to-memory-perfect.md       ← Full documentation (concepts, setup, upgrade)
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
- Shows a selection menu if multiple instances are found
- Prompts for API keys (OpenAI for embeddings, Cohere for re-ranking — optional)
- Creates a LanceDB snapshot before making changes
- Sets up a daily cron job for garbage collection

---

## Update (existing installation)

```bash
# Update plugin only — no config changes, no API key prompts
./scripts/install-memory-system.sh --update-plugin-only /path/to/.openclaw
systemctl --user restart openclaw-gateway.service
```

## Rollback

```bash
./scripts/install-memory-system.sh --rollback /path/to/.openclaw
systemctl --user restart openclaw-gateway.service
```

---

## Features

- **Per-agent isolation** — each agent has its own LanceDB database (38 DBs in production)
- **Auto-capture** — automatically saves relevant conversation content after each turn
- **LLM summarization** — oversized messages (>15K chars) are LLM-summarized instead of dropped
- **URL and attachment prioritization** — links and file attachments from the user are never lost
- **Auto-recall** — injects the top-5 most relevant memories before each turn
- **Cohere re-ranker** — optional two-stage retrieval for better relevance
- **LLM merging** — logically related memories are automatically consolidated
- **Native dreaming** — `memory-core` as slot owner runs light/REM/deep phases per workspace
- **TTL system** — `session` (24h), `short` (14 days), permanent
- **Layer 1.5 / KNOWLEDGE.md** — curated knowledge base with automatic compaction
- **Embedding fallback** — secondary embedding endpoint on primary failure
- **Atomic writes** — KNOWLEDGE.md via temp+rename, lock file via `wx` flag
- **Embedding retry** — exponential backoff on rate limits

---

## Requirements

- [OpenClaw](https://github.com/openclaw) Gateway ≥ 2026.4.5 (for native dreaming)
- Node.js ≥ 18
- OpenAI API key (for embeddings: `text-embedding-3-large` or `text-embedding-3-small`)
- Cohere API key (optional, for re-ranking)
- Any LLM API (optional, for merging + summarization — compatible with kimi-for-coding, GPT-4, etc.)

---

## Full Documentation

→ [`how-to-memory-perfect.md`](how-to-memory-perfect.md)

Covers: architecture, configuration reference, dreaming, upgrade guides, security audit fixes, troubleshooting.

---

## License

MIT
