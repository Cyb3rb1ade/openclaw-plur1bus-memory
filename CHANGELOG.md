# Changelog — PLUR1BUS Memory

Alle wichtigen Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
und dieses Projekt folgt [Semantic Versioning](https://semver.org/lang/de/).

## [6.0.0] — 2026-06-03

### Breaking / Migration
- **Schema-Migration erforderlich** bei Upgrade von v5.2.11: `MemoryDB.init()` fügt automatisch alle v6-Spalten hinzu (emotionalValence, replayCount, memoryStrength, versionNumber, status, etc.). Bestehende Rows bleiben erhalten.
- `scripts/` und `tests/` wurden aus dem Repo entfernt und sind nicht mehr Teil der Distribution.

### Added — Phase 6: Consolidation Engine

- **Memory Compaction** (`lib/jobs/memory-compaction.js`)
  - Nicht-destruktive Deduplizierung: Aliases statt hartem Löschen
  - Ähnlichkeits-Clustering via Cosine Similarity (Threshold ≥0.88)
  - LLM-gestütztes Merging kompatibler Memories
  - Konflikt-Erkennung bei widersprüchlichen Entscheidungen
  - Auto-reduzierte Batch-Size für `local-transformers` (10 statt 50)
  - Fresh Embeddings für merged Text
  - Dry-Run Modus: keine DB-Mutationen, keine State-Writes

- **Conflict Resolver** (`lib/jobs/conflict-resolver.js`)
  - Automatische Konflikt-Auflösung via LLM
  - Reife-Filter: nur Konflikte älter als 7 Tage
  - Confidence-Threshold für Auto-Apply: ≥0.9
  - Deduplizierung bereits gelöster Konflikte
  - Topic-Gruppierung für kontextuellere Resolution

- **Atomic Job Locks** (`lib/job-lock.js`)
  - File-based Locking mit 10-Minuten-Staleness-Check
  - Verhindert parallele Ausführung von REM-Dream und Compaction

### Added — Phase 5: REM Dreaming

- **REM Dream Engine** (`lib/dreaming/rem-dream.js`)
  - Wöchentliche Muster-Erkennung über Sparse kNN-Graph
  - Cluster-Validierung: Min/Max-Size, Centroid-Similarity
  - LLM-basierte Pattern-Summary pro Cluster
  - Trend-Analyse: neu / stärker / schwächer / gleich / verschwunden
  - Idempotent via SHA256-Run-Key + `run-state.json`
  - Analysiert die **vorherige** abgeschlossene Woche (nicht die aktuelle)
  - Auto-reduzierte Limits für Local Provider (1000 Memories, topK 10)

### Added — Phase 4: Memory Graph

- **Memory Graph** (`lib/memory-graph.js`)
  - Drei Edge-Typen: semantic, temporal, episodic
  - Bidirektionale Adjazenzliste mit Deduplizierung
  - Graph-Traversal mit Depth-Limit und Zyklen-Erkennung
  - Assoziativer Spread in der Recall-Pipeline
  - Episode-Anchor-Edges für episodisches Binding
  - Vault-Ausgabe: Memory Constellation Report (Markdown)

### Added — Phase 3: Episodic Narrative

- **Episode Extraction** (`lib/episodes.js`)
  - Turn-Gruppierung zu Geschichten via LLM
  - Narrative Struktur: Setting, Trigger, Development, Resolution
  - Auto-Kürzung bei zu langen Sessions (>50 Turns)
  - Vault-Ausgabe: Episoden als Markdown-Dateien

### Added — Phase 2: Light Dreaming

- **Light Dream Engine** (`lib/dreaming/light-dream.js`)
  - Nach-Session-Reflexion: 3 Key Insights via LLM
  - Aktivierte Memories via Embedding-Suche
  - Memory-Strengthening: `replayCount + 1`, `lastReplayed` Update
  - Behavior-Card-Kandidaten aus expliziten Instruktionen/Korrekturen
  - Fire-and-forget im `agent_end` Hook
  - Idempotent via Session-Digest

### Added — Phase 1: Emotional Valence

- **Emotion Detection** (`lib/emotion.js`)
  - 28 Emotionen nach Plutchik-Rad-Modell
  - Intensity (0.0–1.0) + Dominant Emotion
  - Valence (positiv/negativ/neutral)
  - Mood Context: Emotionaler Zustand zum Zeitpunkt des Capture

- **Emotional State Pool** (`lib/emotional-state.js`)
  - Pro-Agent Emotional State Tracking
  - Stimmungsabhängiger Recall-Boost
  - `/zustand` zeigt aktuelle Emotion

### Added — Reranker & Provider

- **Chained Reranker** (`lib/providers/reranker-chained.js`)
  - Cohere Primary → Local Transformers Fallback
  - Automatischer Fallback bei API-Fehlern

### Changed

- **Schema Migration** (v5.3.0): Neue Spalten in LanceDB
  - `emotionalValence`, `emotionalIntensity`, `emotionalDominant`
  - `moodContextAtCapture`, `replayCount`, `lastReplayed`

- **Neo-Arch Erweiterung**
  - Neue JSONL-Dateien: `dream-diary.jsonl`, `episodes.jsonl`, `memory-graph.jsonl`, `pattern-analysis.jsonl`
  - `run-state.json` für Idempotenz-Tracking
  - Separate `NEO_JSON_FILES` (nicht gecappt/gedupt)

- **Recall Pipeline**
  - Emotional Boost: stimmungsabhängige Score-Anpassung
  - Assoziativer Spread: Graph-basierte Ergebnis-Erweiterung

- **Daily Consolidation** (`lib/jobs/daily-consolidation.js`)
  - Vollständige Phase-6-Integration
  - TTL-Expiration → Neo-Pruning → Compaction → Conflict Resolution
  - Vault-Ausgabe: Consolidation Report

### Fixed

- `crypto.randomUUID` nicht importiert in `memory-compaction.js`
- `getTable` undefiniert in `index.js` (Graph-Edge-Building)
- SQL-Injection via unsanitisierte `memoryId` in `light-dream.js`
- Kein Timeout bei Cohere `fetch` → 30s via `AbortController`
- Unbounded `readFileSync` in `conflict-resolver.js` → 50MB Limit
- `findBestPatternMatch` nutzt jetzt Jaccard-Ähnlichkeit

### Security

- `safeUuid()` für alle user-kontrollierten IDs in LanceDB where-Clauses
- `safeTimestamp()` für alle Zeitstempel-Filter

---

## [5.2.10] — 2026-05-XX

### Added
- Group session detection, sender attribution, clean text extraction

### Fixed
- `callLlm`: fallback to `reasoning_content` when `content` is empty
- `callLlm`: use `thinking: { type: "disabled" }` to suppress kimi-for-coding thinking

---

## [5.1.0] — 2026-04-XX

### Added
- Parallel capture, ANN index auto-reindex, query summarization

### Fixed
- Recall/capture feedback loop
- Bounded stores
- LanceDB AND-filter bug

---

## [4.2.0] — 2026-03-XX

### Added
- Obsidian Bridge: bidirektionale Synchronisation
- Feature Toggle System
- Neo-Arch: kognitive Schicht mit Candidates, Behavior Cards, Embeddings
