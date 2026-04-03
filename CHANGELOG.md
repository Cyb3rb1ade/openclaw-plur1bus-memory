# Changelog

## [1.0.0] — 2026-04-03

Erste öffentliche Version. Konsolidiert alle Entwicklungen aus dem produktiven OpenClaw-Deployment.

### Plugin (`memory-lancedb-namespaced`)

**Features**
- Per-Agent-Isolation: jeder Agent bekommt seine eigene LanceDB unter `{baseDbPath}/{agentId}/`
- Auto-Capture nach jedem Turn mit URL- und Attachment-Priorisierung
- Auto-Recall vor jedem Turn (Top-5, optional mit Cohere Re-Ranker)
- Dreistufige Store-Pipeline: Duplikat-Check → LLM-Merge → Neu
- TTL-System: `session` (24h), `short` (14 Tage), permanent
- Schicht 1.5: `KNOWLEDGE.md` mit automatischer Kompaktierung bei >200 Zeilen
- Conflict-Log für `decision`-Memories zwischen Agenten (schemaVersion: 1)
- `storedBy`-Feld für Traceability
- Relative Pfade via `import.meta.url` — installationspfad-unabhängig

**Security**
- SQL-Injection-Schutz: UUID-Format-Validierung vor allen `table.delete()`-Aufrufen
- Atomares Lock-File via `openSync('wx')` — verhindert TOCTOU-Race-Condition
- Staleness-Check: Lock-Dateien >5 Minuten werden automatisch entfernt (Crash-Recovery)
- JSON-Parse-Fehlerbehandlung in `callMergeCheck` — ungültiges LLM-JSON führt zu No-Merge
- Embedding-Retry mit exponentiellem Backoff (3 Versuche, Rate-Limit-aware)
- Promise-Queue pro Agent für Auto-Capture — verhindert Race Conditions bei parallelen Events
- `pendingCount` gedeckelt bei 1000

### `memory-gc.mjs`

- Pfade relativ via `import.meta.url` — kein hardcoded `/root/`
- Agent-Liste wird aus `openclaw.json` gelesen (Fallback: `main`, `bernhardine`, `heisenberg`)

### `install-memory-system.sh`

- Auto-Erkennung lokaler OpenClaw-Installationen (sucht nach `openclaw.json` in Standard-Pfaden)
- Auswahlmenü bei mehreren Installationen mit Versions-Anzeige
- `--update-plugin-only`: nur Plugin-Dateien aktualisieren, keine Config-Änderungen
- `--rollback`: stellt letzten LanceDB-Snapshot + `openclaw.json.bak` wieder her
- `--dry-run`: Vorschau ohne Änderungen
- Automatischer LanceDB-Snapshot vor jeder Installation (max. 5, älteste werden gelöscht)
