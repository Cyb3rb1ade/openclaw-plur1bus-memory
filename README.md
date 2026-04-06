# OpenClaw Memory System

*[Deutsch](#deutsch) | [English](#english)*

---

<a name="deutsch"></a>
## Deutsch

Produktionsreifes, dreischichtiges Gedächtnissystem für [OpenClaw](https://github.com/openclaw)-Agenten.

Entwickelt und erprobt im produktiven Einsatz mit mehreren Agenten über mehrere Monate.

---

## Was ist das?

Dieses Paket löst das Kernproblem von LLM-Agenten: **Amnesie zwischen Sessions.**

Es kombiniert drei Schichten:

```
Schicht 1   Flat-File Memory     workspace/memory/YYYY-MM-DD.md — menschenlesbar
Schicht 2   Workspace-Indexer    SQLite + Vektor-Embeddings aller .md-Dateien
Schicht 3   LanceDB              Konversations-Fakten, semantisch durchsuchbar
```

Alle drei arbeiten zusammen. Der Agent schreibt, das System erinnert sich automatisch.

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

- **Per-Agent-Isolation** — jeder Agent hat seine eigene LanceDB-Datenbank
- **Auto-Capture** — speichert automatisch relevante Gesprächsinhalte nach jedem Turn
- **URL- und Attachment-Priorisierung** — Links und Dateianhänge gehen nie verloren
- **Auto-Recall** — injiziert Top-5-relevante Memories vor jedem Turn
- **Cohere Re-Ranker** — optionales zweistufiges Retrieval für bessere Relevanz
- **LLM-Merging** — logisch verwandte Memories werden automatisch zusammengeführt
- **TTL-System** — `session` (24h), `short` (14 Tage), permanent
- **KNOWLEDGE.md** — kuratierte Wissensbasis mit automatischer Kompaktierung
- **Atomic Writes** — KNOWLEDGE.md via temp+rename, Lock-File via `wx`-Flag
- **Embedding-Retry** — exponentieller Backoff bei Rate-Limits

---

## Voraussetzungen

- [OpenClaw](https://github.com/openclaw) Gateway
- Node.js ≥ 18
- OpenAI API Key (für Embeddings: `text-embedding-3-large` oder `text-embedding-3-small`)
- Cohere API Key (optional, für Re-Ranking)
- LLM-API (optional, für Merging — kompatibel mit kimi-for-coding, GPT-4, etc.)

---

## Vollständige Dokumentation

→ [`how-to-memory-perfect.md`](how-to-memory-perfect.md)

---

## Lizenz

MIT

---

<a name="english"></a>
## English

A production-grade, three-layer memory system for [OpenClaw](https://github.com/openclaw) agents.

Built and battle-tested in production across multiple agents over several months.

---

## What is this?

This package solves the core problem of LLM agents: **amnesia between sessions.**

It combines three layers:

```
Layer 1   Flat-File Memory     workspace/memory/YYYY-MM-DD.md — human-readable
Layer 2   Workspace Indexer    SQLite + vector embeddings of all .md files
Layer 3   LanceDB              Conversation facts, semantically searchable
```

All three work together. The agent writes, the system remembers automatically.

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

- **Per-agent isolation** — each agent has its own LanceDB database
- **Auto-capture** — automatically saves relevant conversation content after each turn
- **URL and attachment prioritization** — links and file attachments from the user are never lost
- **Auto-recall** — injects the top-5 most relevant memories before each turn
- **Cohere re-ranker** — optional two-stage retrieval for better relevance
- **LLM merging** — logically related memories are automatically consolidated
- **TTL system** — `session` (24h), `short` (14 days), permanent
- **Layer 1.5 / KNOWLEDGE.md** — curated knowledge base with automatic compaction
- **Conflict log** — tracks contradictory `decision`-type memories across agents
- **Atomic writes** — KNOWLEDGE.md via temp+rename, lock file via `wx` flag
- **Embedding retry** — exponential backoff on rate limits

---

## Requirements

- [OpenClaw](https://github.com/openclaw) Gateway
- Node.js ≥ 18
- OpenAI API key (for embeddings: `text-embedding-3-large` or `text-embedding-3-small`)
- Cohere API key (optional, for re-ranking)
- Any LLM API (optional, for merging and KNOWLEDGE.md — compatible with kimi-for-coding, GPT-4, etc.)

---

## Full Documentation

→ [`how-to-memory-perfect.md`](how-to-memory-perfect.md)

Covers: architecture, configuration reference, upgrade guides, security audit fixes, troubleshooting.

---

## License

MIT
