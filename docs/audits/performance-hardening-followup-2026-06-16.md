# PLUR1BUS Memory — Performance-Hardening Followup

**Datum:** 2026-06-16  
**Plugin:** `@cyb3rb1ade/plur1bus-memory` v6.6.0  
**Branch:** main (lokale Commits, noch nicht gepusht)  
**Auditor:** Kimi Code CLI  

---

## Zusammenfassung

Auf Basis des vollständigen Performance-Audits (`docs/audits/performance-audit-full-2026-06-16.md`) wurde eine fokussierte P0/P1-Hardening-Runde durchgeführt. Alle geplanten Sofort- und Kurzfrist-Maßnahmen aus dem Audit wurden adressiert. Die Test-Suite wuchs von **1.125 auf 1.204 Tests**, alle grün.

**Finaler Teststatus:** `npm test` → 1.204 Tests, 0 Fehler, ~31 s.

---

## 1. Geänderte Dateien

| Commit | Dateien | Befund |
|--------|---------|--------|
| `feat(with-timeout)` | `lib/with-timeout.js`, `tests/with-timeout.test.js` | Neuer zentraler Timeout-Helper |
| `perf(neo-arch)` | `lib/neo-arch.js`, `tests/neo-arch-regex-perf.test.js` | K1: Super-lineare Regex |
| `perf(bounded-cache)` | `lib/bounded-cache.js`, `tests/bounded-cache-shutdown.test.js` | K4: Async shutdown |
| `perf(shared-memory)` | `lib/shared-memory.js`, `tests/shared-memory-conflict-limit.test.js` | K7: O(n²) detectConflicts |
| `perf(db-adapter)` | `lib/db-adapter.js`, `tests/db-adapter-timeouts.test.js` | K3: LanceDB Timeouts |
| `perf(index)` | `index.js`, `tests/index-conflict-log-prompt.test.js` | K3/H1: MemoryDB-Timeouts + Conflict-Log Tail-Read |
| `perf(jobs)` | `lib/jobs/daily-consolidation.js`, `lib/jobs/gc-job.js`, `lib/jobs/memory-compaction.js`, `lib/jobs/memory-dynamics-maintenance.js`, `tests/gc-job-timeout.test.js`, `tests/memory-compaction-timeout.test.js` | H4/P1: Job-Level-Timeouts |

---

## 2. Neue Tests

- `tests/with-timeout.test.js` — Timeout-Helper
- `tests/neo-arch-regex-perf.test.js` — Regex-Performance-Regression
- `tests/bounded-cache-shutdown.test.js` — Async Eviction
- `tests/shared-memory-conflict-limit.test.js` — Conflict-Limits
- `tests/db-adapter-timeouts.test.js` — LanceDB-Timeouts
- `tests/index-conflict-log-prompt.test.js` — Conflict-Log Prompt Build
- `tests/gc-job-timeout.test.js` — GC-Job Timeout
- `tests/memory-compaction-timeout.test.js` — Compaction Timeout

---

## 3. Vorher/Nachher-Messwerte

### 3.1 `lib/neo-arch.js` `isInjectedContextText`

| Szenario | Vorher (Audit) | Nachher | Status |
|----------|----------------|---------|--------|
| Adversarial punctuation soup (10k Zeichen) | super-linear, >1 s für 10k Checks | 0,09 ms | ✅ linear |
| Langer normaler Text (20k) | 71,5 ms für 1.000 Checks | 0,01 ms/op Budget | ✅ |
| Langer Text mit Marker (20k) | — | 0,01 ms/op Budget | ✅ |

### 3.2 `buildMaintenanceNudges` Conflict-Log

| Dateigröße | Vorher (Audit) | Nachher | Status |
|------------|----------------|---------|--------|
| 10 KB | ~0,6 ms/Op (linear) | ~0,27 ms | ✅ |
| 100 KB | linear wachsend | ~0,09 ms | ✅ konstant |
| 1 MB | linear wachsend | ~0,07 ms | ✅ konstant |
| 5 MB | linear wachsend | ~0,09 ms | ✅ konstant |

Ab >1 MB wird nur noch der Kopf (8 KB) gelesen, daher konstante Laufzeit.

### 3.3 `shared-memory.js` `detectConflicts`

| Input n | Vorher | Nachher | Status |
|---------|--------|---------|--------|
| 10 | 0,56 ms | 0,56 ms | ✅ gleich |
| 100 | O(n²) | 0,44 ms | ✅ begrenzt |
| 1.000 | O(n²) | 0,31 ms | ✅ begrenzt |
| 5.000 | potenziell Sekunden | 0,43 ms | ✅ begrenzt |

Begrenzung: `DEFAULT_MAX_CONFLICT_CANDIDATES = 500`, `maxConflicts = 100`.

### 3.4 LanceDB-Operationen

- Alle zentralen Reads/Writes in `MemoryDB`, `db-adapter` und Background-Jobs mit konservativen Timeouts:
  - Reads: 10 s
  - Writes: 15 s
  - daily-consolidation: 5 min
  - gc-job: 2 min
  - memory-compaction: 5 min
  - memory-dynamics-maintenance: konfigurierbar via `opts.timeoutMs`

---

## 4. Behobene Audit-Befunde

| Befund | Schwere | Status | Commit |
|--------|---------|--------|--------|
| K1 — Super-lineare Regex in `neo-arch.js` | kritisch | ✅ behoben | `perf(neo-arch)` |
| K3 — Fehlende LanceDB-Timeouts | kritisch | ✅ behoben | `perf(db-adapter)`, `perf(index)` |
| K4 — `bounded-cache` async shutdown | kritisch | ✅ behoben | `perf(bounded-cache)` |
| K7 — `shared-memory.detectConflicts` O(n²) | kritisch | ✅ behoben | `perf(shared-memory)` |
| H1 — Conflict-Log komplett einlesen | hoch | ✅ behoben | `perf(index)` |
| H4 — Background Jobs ohne Timeout | hoch | ✅ behoben | `perf(jobs)` |

---

## 5. Bewusst offen gebliebene Befunde

Folgende Befunde wurden nicht in dieser Runde behandigt, da sie entweder mittlere Priorität haben oder größere Architektur-Änderungen erfordern:

| Befund | Priorität | Grund für Offenlassen |
|--------|-----------|----------------------|
| K2 — `MemoryDB.update` delete+add statt atomarem Update | kritisch | Erfordert Evaluierung von LanceDB `table.update()`-Support in 0.26.2; Risiko von Datenverlust bei falscher Migration |
| K5 — Lokaler Reranker ohne Batching | kritisch | Erfordert Modell-/Pipeline-Änderung oder Vendor-Wechsel |
| K6 — `local-transformers` Embedding ohne Cache | kritisch | Erfordert Provider-Refactoring und ONNX-Modell-Lifecycle-Prüfung |
| H2 — Retrieval-Ledger N+1 Updates | hoch | Erfordert LanceDB-Batch-Update-Evaluierung |
| H3 — `scanActive()` ohne Limit | hoch | Erfordert Cursor/Limit-Änderung in mehreren Callern |
| H5 — Job-Lock Stale-Zeit 10 Minuten | hoch | Konfigurationsänderung, sollte mit Produktions-Job-Laufzeiten abgestimmt werden |
| H6 — `dedupResults` O(n²) | hoch | Default-Kandidatenzahl klein, Erfordert MinHash/LSH-Design |
| H7 — Query-Refiner zweiter Embedding-Call | hoch | Feature default `false`; würde Sub-Timeout/Parallelisierung erfordern |
| H8 — `callLlm` / `knowledge_update` ohne Timeout | hoch | Erfordert Config-Konsolidierung mit OpenClaw-Runtime-Timeouts |
| H9 — `getByIds` Batch-Größe 10 | hoch | Erfordert IN-Query-Zuverlässigkeitstest |
| H10 — `atomicJsonUpdate` synchroner fs | hoch | Mutex-Queue verwendet Promise-Chain; Umstellung auf async fs erfordert Queue-Review |
| H11 — Obsidian Bridge Sync Mutex/Chunking | hoch | Größere I/O-Refaktoring |
| H12 — `protobufjs` Audit-Fail | hoch | Transitiv via `@lancedb/lancedb`; erfordert Dependency-Upgrade oder `npm audit fix` |
| M1–M15 — Mittlere Befunde | mittel | Nicht Teil dieser P0/P1-Runde |

---

## 6. Risiken / Rollback-Hinweise

### Risiken

1. **LanceDB-Timeouts:** Konservative Defaults (10 s / 15 s) könnten auf sehr langsamen Disks oder Netzwerk-Storage zu vorzeitigen Timeouts führen. Bei ersten Produktionsproblemen sollten die Werte über Config erhöht werden.
2. **Conflict-Log Tail-Read:** Bei großen Logs (>1 MB) wird nur der Kopf gescannt. Wenn der älteste Eintrag erst nach den ersten 8 KB liegt, wird das Alter nicht erkannt. Dies ist ein bewusster Kompromiss für konstante Laufzeit.
3. **`detectConflicts` Limit:** Bei >500 Shared Memories werden nur die 500 neuesten geprüft. Bestehende Konflikte in älteren Einträgen könnten übersehen werden.
4. **Async Shutdown:** `AgentDbPool.shutdown()` wartet nun auf pending evictions. Bei hängendem `db.shutdown()` könnte dies länger dauern, verhindert aber Ressourcenlecks.

### Rollback

- Alle Änderungen sind in separaten Commits auf `main`. Einzelne Commits können via `git revert <commit>` rückgängig gemacht werden.
- Keine DB-Schema-Migrationen wurden durchgeführt.
- Keine Änderungen an der Semantik von Recall, Memory-Dynamics, Correction, Contradiction Tracking oder Obsidian Bridge.

---

## 7. Finaler Teststatus

```bash
cd /Users/cyberblade/openclaw-plur1bus-memory
npm test
```

Ergebnis:

```text
ℹ tests 1204
ℹ suites 223
ℹ pass 1204
ℹ fail 0
ℹ duration_ms 30961.381291
```

Alle neuen Regressionstests bestehen. Keine stillen Datenverluste eingeführt.
