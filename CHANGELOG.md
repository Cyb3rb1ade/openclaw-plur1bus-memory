# Changelog

## [1.3.1] — 2026-04-11

### `install-memory-system.sh`

- Merging: Default-Modell und Base-URL werden bei Update-Installationen aus der vorhandenen
  `openclaw.json` gelesen und als Vorschlag angezeigt — kein hardcoded Modellname mehr
- Merging: leeres Modellfeld bei Erstinstallation (User muss explizit eingeben)

---

## [1.3.0] — 2026-04-11

### Plugin (`memory-lancedb-namespaced`)

**Features**
- Embedding-Fallback: zweiter Embedding-Endpunkt bei Primary-Ausfall (gleiche Dimension Pflicht)
- ActiveMemory-Unterstützung: Plugin liefert Memory-Tools für den neuen OpenClaw-4.10-Sub-Agenten

**Fixes**
- `openclaw.plugin.json`: trailing comma entfernt (ungültiges JSON)

### `install-memory-system.sh`

- Embedding-Fallback optional konfigurierbar (API Key, Base-URL, Modell)
- ActiveMemory-Plugin optional in Schritt 4b konfigurieren (OpenClaw ≥ 4.10)
- Merging: Kimi-spezifische Optionen (`disableThinking`, `User-Agent`-Header) sind jetzt
  opt-in statt default — Script funktioniert unverändert mit OpenAI, Claude, GLM, ChatGPT u.a.
- Default-Modell für Merging: `gpt-4o-mini` (statt `kimi-for-coding`)
- Default-Base-URL für Merging: leer = Standard-OpenAI-Endpunkt (statt Kimi-URL)

### `how-to-memory-perfect.md`

- Neues Kapitel: §ActiveMemory — Konzept, Per-Agent-Isolation, Konfigurationsparameter,
  Zusammenspiel mit Auto-Recall (Flussdiagramm)
- Neues Kapitel: §Embedding-Fallback — Resilienz, Dimensions-Constraint, Konfiguration,
  Graceful Degradation ohne Fallback
- Upgrade-Anleitung 2026-04-11: k2p5 contextWindow=262144/maxTokens=32768-Fix, YAAWC
  Cohere Reranker, contentUtils tool_call-Fix, kimiOpenAI maxTokens-Default

---

## [1.2.0] — 2026-04-06

### Plugin (`memory-lancedb-namespaced`)

**Features**
- Plugin-Kind auf `extension` geändert — ermöglicht Koexistenz mit nativem `memory-core`
  Dreaming (light → REM → deep Phasen pro Workspace), während LanceDB weiterhin
  Auto-Capture/Recall per Agent liefert
- ~~Dreaming-Bridge~~: externe Python-Skripte (`dreaming-bridge.py`, `dreaming-promote.py`)
  wurden erstellt, aber nie via Cron aktiviert — das native `memory-core` Dreaming
  übernahm die Funktion. Scripts bleiben als Referenz im Branch `dreaming-bridge/v1.0.0`

**Security-Fixes**
- Pfad-Traversal-Schutz: `agentId` wird gegen `[a-zA-Z0-9_-]` validiert
- LanceDB-Verbindungen werden nach Operationen geschlossen (kein Connection-Leak)
- Fehlerbehandlung in Plugin-Hooks verhindert unkontrollierten Absturz

---

## [1.1.0] — 2026-04-03

### Plugin (`memory-lancedb-namespaced`)

**Security-Fixes** (nach internem Audit)
- `memory_store`: Path-Traversal via `agentId` geschlossen
- `memory_forget`: UUID-Validierung vor `DELETE` verschärft
- Lock-File: Race-Condition bei gleichzeitigem Store behoben

---

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
