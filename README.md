# OpenClaw Memory System

Produktionsreifes, dreischichtiges Gedächtnissystem für [OpenClaw](https://github.com/openclaw)-Agenten.

Entwickelt und erprobt im produktiven Einsatz mit mehreren Agenten (Bernd, Bernhardine, Heisenberg) über mehrere Monate.

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
how-to-memory.md               ← Deployment-spezifische Details
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

## Update (bestehende Installation)

```bash
# Nur Plugin aktualisieren — keine Config-Änderungen, keine API-Key-Abfragen
./scripts/install-memory-system.sh --update-plugin-only /pfad/zu/.openclaw
systemctl --user restart openclaw-gateway.service
```

## Rollback

```bash
./scripts/install-memory-system.sh --rollback /pfad/zu/.openclaw
systemctl --user restart openclaw-gateway.service
```

---

## Features

- **Per-Agent-Isolation** — jeder Agent hat seine eigene LanceDB-Datenbank
- **Auto-Capture** — speichert automatisch relevante Gesprächsinhalte nach jedem Turn
- **URL- und Attachment-Priorisierung** — Links und Dateianhänge vom User gehen nie verloren
- **Auto-Recall** — injiziert Top-5-relevante Memories vor jedem Turn
- **Cohere Re-Ranker** — optionales zweistufiges Retrieval für bessere Relevanz
- **LLM-Merging** — logisch verwandte Memories werden automatisch zusammengeführt
- **TTL-System** — `session` (24h), `short` (14 Tage), permanent
- **Schicht 1.5 / KNOWLEDGE.md** — kuratierte Wissensbasis mit automatischer Kompaktierung
- **Conflict-Log** — verfolgt widersprüchliche `decision`-Memories zwischen Agenten
- **Atomic Writes** — KNOWLEDGE.md via temp+rename, Lock-File via `wx`-Flag
- **Embedding-Retry** — exponentieller Backoff bei Rate-Limits

---

## Voraussetzungen

- [OpenClaw](https://github.com/openclaw) Gateway
- Node.js ≥ 18
- OpenAI API Key (für Embeddings: `text-embedding-3-large` oder `text-embedding-3-small`)
- Cohere API Key (optional, für Re-Ranking)
- LLM-API (optional, für Merging und KNOWLEDGE.md — kompatibel mit kimi-for-coding, GPT-4, etc.)

---

## Vollständige Dokumentation

→ [`how-to-memory-perfect.md`](how-to-memory-perfect.md)

Enthält: Architektur, Konfigurationsreferenz, Upgrade-Anleitungen, Security-Audit-Fixes, Troubleshooting.

---

## Lizenz

MIT
