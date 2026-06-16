# PLUR1BUS Memory — Vollständiges Performance-Audit

**Plugin:** `@cyb3rb1ade/plur1bus-memory` v6.6.0  
**Pfad:** `/Users/cyberblade/openclaw-plur1bus-memory`  
**Datum:** 2026-06-16  
**Auditor:** Kimi Code CLI (Agent-Swarm)  
**Scope:** Entry Point & Lifecycle, Recall & Search Pipeline, Background Jobs, Obsidian Bridge & I/O, Memory Dynamics / Caching / State, Tests & Benchmarks, Dependencies & Build Surface  
**Methodik:** Parallele Code-Analyse, Ausführung bestehender Performance-Tests, Ad-hoc-Micro-Benchmarks, Komplexitätsanalyse. Keine dauerhaften Code-Änderungen wurden vorgenommen.

---

## Executive Summary

Das Plugin ist funktional stabil: **1.125 Unit-Tests bestanden, 0 Fehler**. Die existierenden Performance-Smoke-Tests decken kleine Inputs ab und laufen schnell. Bei Wachstum der Agent-DBs, Vaults und Logs zeigen sich jedoch mehrere systematische Performance-Risiken, die von suboptimalen Algorithmen (O(n²)/O(n log n)), synchronem I/O auf Hot-Paths, fehlenden Timeouts und nicht-atomaren DB-Updates herrühren.

**Gesamtscore:** 64/100 — **riskant für Produktion bei größeren Datenmengen**, aktuell noch akzeptabel für kleine bis mittlere Workloads.

| Kategorie | Score | Begründung |
|-----------|-------|------------|
| Recall / Search Hot-Path | 68 | Gute Basis (Embedding-Cache OpenAI, Graph-Index), aber lokaler Reranker ohne Batching, O(n²)-Dedup, fehlende Timeouts |
| Capture / agent_end | 62 | Sequentielle Writes, teure Regex-Extraktion, kein LLM-Timeout |
| Background Jobs | 55 | N+1-Updates, O(n²)-Job-Algorithmen, fehlende Job-Timeouts, kurze Lock-Stale-Zeit |
| Obsidian Bridge / I/O | 65 | Synchroner Vault-Walk, wiederholtes Index-Bauen, fehlende Backpressure |
| Caching & State | 60 | O(n)-Sweep, O(n log n)-Eviction, unbegrenzte Caches |
| Dependencies / Build | 70 | 513 MB node_modules bei 1,4 MB Source, veraltete LanceDB, audit-Fail |
| Tests / Benchmarks | 75 | Gute Abdeckung, aber fehlende Last-Regressionstests |

---

## 1. Kritische Befunde (sofortige Aktion empfohlen)

### K1 — `INJECTED_CONTEXT_RE` Regex ist super-linear und blockiert `agent_end`
- **Dateien:** `lib/neo-arch.js:107`, `index.js` (Capture-Pfad)
- **Beschreibung:** Eine komplexe Alternation-Regex wird auf jedem Capture-Item angewendet.
- **Messung:** 10.000 Checks auf 10.000 Zeichen = **1.408 ms** (~1,4 s).
- **Impact:** Lange Assistant-Outputs können den Capture-Pfad sekundenlang blockieren.
- **Empfehlung:** In einfache `String.includes()`-Vorfilter aufteilen oder zeitlich begrenzten Regex-Test verwenden.

### K2 — `MemoryDB.update` / `db-adapter.updateCard` nutzen `delete+add` statt atomarem Update
- **Dateien:** `index.js:804-826`, `lib/db-adapter.js:442-512`
- **Beschreibung:** Jede Update-Operation führt `delete(id)` + `add(normalized)` aus; bei Fehler wird best-effort wiederhergestellt.
- **Impact:** Nicht atomar, doppelte I/O-Kosten, invalidiert Caches/Indizes, Korruptionsrisiko unter Last.
- **Empfehlung:** Auf `table.update()` umstellen, falls von LanceDB 0.26.2 unterstützt; andernfalls Timeout + Retry + besseres Recovery.

### K3 — Fehlende Operation-Level-Timeouts bei fast allen LanceDB-Aufrufen
- **Dateien:** `index.js:690-848`, `lib/db-adapter.js:141-640`
- **Beschreibung:** `vectorSearch`, `query`, `countRows`, `add`, `delete`, `update` laufen ohne Timeout.
- **Impact:** Ein einzelner hängender DB-Call frisst den gesamten 45-60 s Global-Timeout auf; kein Raum für Retry/Fallback.
- **Empfehlung:** `withTimeout(promise, ms)`-Helper einführen (z. B. 5-10 s Reads, 15 s Writes).

### K4 — `bounded-cache.js` ruft synchronen `onEvict` mit async Handler auf
- **Dateien:** `lib/bounded-cache.js:31-32`, `index.js:859-863`
- **Beschreibung:** `AgentDbPool` übergibt `async (_id, db) => await db.shutdown()`, aber `makeBoundedCache` awaited nicht.
- **Impact:** Ressourcenlecks (offene LanceDB-Handles), unkontrollierte Eviction.
- **Empfehlung:** `onEvict` entweder synchron halten oder `makeBoundedCache` async-kompatibel machen.

### K5 — Lokaler Reranker ohne Batching
- **Dateien:** `lib/providers/reranker-local-transformers.js:47-54`
- **Beschreibung:** Dokumente werden sequentiell einzeln gescored.
- **Impact:** 20 Dokumente = 20 Forward-Passes; typisch 10-50× langsamer als Batch; Timeout-Fallback verschlechtert Recall-Qualität.
- **Empfehlung:** Transformers-Pipeline mit Array-Input oder batch-fähiges Modell nutzen.

### K6 — `LocalTransformersEmbeddingProvider` hat keinen Cache
- **Dateien:** `lib/providers/embedding-local-transformers.js`
- **Beschreibung:** Nur `OpenAIEmbeddingProvider` verwendet `createEmbeddingCache`.
- **Impact:** Jede wiederholte Query/Passage wird neu embedded — besonders teuer bei lokalem ONNX-Modell.
- **Empfehlung:** Gleichen LRU+TTL-Cache wie OpenAI-Provider einführen.

### K7 — `shared-memory.js detectConflicts` ist O(n²) ohne Limit
- **Dateien:** `lib/shared-memory.js:104-137`
- **Beschreibung:** Paarweiser Jaccard-Vergleich über alle `sharedMemories`.
- **Impact:** 10.000 Shared Memories = ~50 Mio. Vergleiche; kann Minuten blockieren.
- **Empfehlung:** `maxCandidates`-Limit oder Sampling einführen.

---

## 2. Hohe Befunde (nächster Sprint)

### H1 — `buildMaintenanceNudges` liest `conflict-log.jsonl` komplett im Prompt-Build
- **Dateien:** `index.js:1083-1103`
- **Messung:** 100 Aufrufe × 20.000 Zeilen = **63,6 ms** synchron im `before_prompt_build`.
- **Empfehlung:** Tail/Head-Read oder `statSync` + gezählte Zeilenanzahl nutzen.

### H2 — Retrieval-Ledger + Daily-Decay führen N+1 `getById`/`update` aus
- **Dateien:** `lib/jobs/memory-dynamics-maintenance.js:39-71`, `:100-116`
- **Impact:** Bei 10.000 Memories und täglichem Decay entstehen 10.000 teure Delete+Add-Zyklen.
- **Empfehlung:** Batched `getByIds` + Batch-Updates (oder `table.update()`).

### H3 — `scanActive()` lädt alle aktiven Memories ohne Limit
- **Dateien:** `index.js:828-848`, `lib/jobs/gc-job.js:103`
- **Impact:** Gesamte DB wird in den Speicher geladen; GC skaliert linear mit DB-Größe.
- **Empfehlung:** Limit/Cursor-Chunks (z. B. 500er-Batches).

### H4 — Fehlender Overall-Timeout für Cron-Jobs
- **Dateien:** `index.js:2003-2218`, `lib/jobs/daily-consolidation.js`, `lib/jobs/gc-job.js`
- **Impact:** Hängender daily-consolidation blockiert den Cron-Carrier.
- **Empfehlung:** `Promise.race([job, timeout])` pro Job (z. B. 5 min consolidate, 2 min gc).

### H5 — Job-Lock Stale-Zeit zu kurz (10 Minuten)
- **Dateien:** `lib/job-lock.js:13`, `lib/jobs/daily-consolidation.js:44-52`
- **Impact:** Bei langlaufenden Jobs entstehen doppelte parallele Läufe.
- **Empfehlung:** Auf ≥60 Minuten erhöhen oder pro Job konfigurierbar machen.

### H6 — `dedupResults` ist O(n²) mit wiederholter Tokenisierung
- **Dateien:** `lib/recall-pipeline.js:51-68`, `lib/text-utils.js:27-35`
- **Messung:** 100 Items = 0,13 ms/Op; 1.000 Items = 0,89-32,6 ms je nach Textlänge.
- **Empfehlung:** Token-Sets cachen, frühen Abbruch, MinHash/LSH für große Mengen.

### H7 — Query-Refiner löst sequentiell zweiten Embedding-Call aus
- **Dateien:** `lib/recall-pipeline.js:420-485`
- **Impact:** Verdopplung der Recall-Latenz bei aktiviertem Refiner.
- **Empfehlung:** Default `false` belassen, hartes Sub-Timeout, parallele Ausführung prüfen.

### H8 — `callLlm` / `makeQuerySummarizer` / `knowledge_update` ohne internes Timeout
- **Dateien:** `index.js:324-355`, `:1171-1192`, `:3712-3885`
- **Impact:** Hängender LLM-Provider blockiert `agent_end` oder Prompt-Build unbegrenzt.
- **Empfehlung:** `Promise.race` mit konfigurierbarem Timeout.

### H9 — `getByIds` Batch-Größe nur 10
- **Dateien:** `lib/recall-pipeline.js:306-320`
- **Impact:** Bei vielen graph-only IDs entstehen viele sequentielle Runden.
- **Empfehlung:** BATCH auf 50-100 erhöhen oder IN-Query priorisieren.

### H10 — `atomicJsonUpdate` blockiert Event Loop mit synchronem fs
- **Dateien:** `lib/atomic-json.js:18-42`
- **Impact:** Jeder Metrics-Flush blockiert kurz den Event Loop; unter Last p99-Spitzen.
- **Empfehlung:** `fs.promises.writeFile` + `fs.promises.rename` nutzen.

### H11 — Obsidian Bridge: überlappende Syncs/Rebuilds und synchroner I/O
- **Dateien:** `lib/obsidian-bridge.js:1789-1807`, `:1388-1454`, `:1673-1785`
- **Impact:** Kein Lauf-Schutz bei Intervall-Triggern; 500 Karten Sync = **203 ms** synchron.
- **Empfehlung:** Mutex/Boolean-Sperre, Chunking + `setImmediate`, überflüssiges Rücklesen entfernen.

### H12 — `protobufjs` Audit-Fail blockiert CI
- **Dateien:** `package-lock.json`, `.github/workflows/ci.yml`
- **Beschreibung:** `npm audit --audit-level=moderate` meldet moderate Schwachstelle in `protobufjs <=7.6.2` (transitiv via `@lancedb/lancedb` → `apache-arrow`).
- **Empfehlung:** `npm audit fix`, Lockfile bereinigen oder `@lancedb/lancedb` aktualisieren.

---

## 3. Mittlere Befunde

### M1 — Embedding-Cache `sweepExpired` bei jedem `get`/`set` (O(n))
- **Dateien:** `lib/embedding-cache.js:36-44`, `:54-70`
- **Messung:** 10.000 gets bei 5.000 Einträgen = **127,98 ms**.
- **Empfehlung:** Lazy/periodischen Sweep oder TTL-Heap verwenden.

### M2 — `bounded-cache.set()` Eviction ist O(n log n)
- **Dateien:** `lib/bounded-cache.js:23-35`
- **Messung:** max=5.000, 10.000 Sets = **498,5 ms**.
- **Empfehlung:** Map-Insertion-Order nutzen (`map.keys().next()`) oder Linked-List.

### M3 — `MemoryDB.getRecentForGraph` lädt `limit*2` Rows + JS-Sortierung
- **Dateien:** `index.js:628-665`
- **Empfehlung:** `orderBy("createdAt", "desc").limit(limit)` + WHERE auf Zeitfenster.

### M4 — `InterpretationOverlayStore.loadAllOverlays` parst JSONL komplett
- **Dateien:** `lib/interpretation-overlay.js:149-174`
- **Empfehlung:** Offset-Index für `targetMemoryId` oder nur relevante Zeilen parsen.

### M5 — Semantic Lens / CRR: serielle Hydratation
- **Dateien:** `lib/semantic-lens-index.js:143-149`, `lib/conversation-reactivation-recall.js:339-361`
- **Empfehlung:** Batch-Hydration via IN-Query; internes Deadline-Budget für CRR.

### M6 — `runtime-scheduler` `recallCache` ohne `maxEntries`
- **Dateien:** `lib/runtime-scheduler.js:76`, `:101-103`, `:118-127`
- **Empfehlung:** Obergrenze + periodisches Sweeping einführen.

### M7 — `conversation-reactivation-recall.js`: unbegrenzte `sessionState` Map
- **Dateien:** `lib/conversation-reactivation-recall.js:182-194`
- **Empfehlung:** TTL-Eviction (z. B. 7 Tage).

### M8 — `semantic-lens-index.js`: unbegrenzter `indexCache`
- **Dateien:** `lib/semantic-lens-index.js:14`, `:68-87`
- **Empfehlung:** Durch `createEmbeddingCache` oder `makeBoundedCache` ersetzen.

### M9 — `extractGraphSignals`: ungenutzte Berechnung + teure Regex
- **Dateien:** `lib/memory-graph.js:232-265`
- **Messung:** 1.000 Extraktionen auf 1.000 Wörtern = **80,73 ms**; ungenutzte `text.split(/\s+/)`.
- **Empfehlung:** Text kürzen, ungenutzte Zeile entfernen, Regex-Ergebnisse cachen.

### M10 — `getKnowledgeChunks` embeddet KNOWLEDGE.md-Sections sequentiell
- **Dateien:** `lib/recall-pipeline.js:139-148`
- **Empfehlung:** Parallel mit Concurrency-Limit oder Batch-Embedding-API.

### M11 — `scanWorkspace` hält alle Datei-Inhalte im Speicher
- **Dateien:** `lib/obsidian-bridge.js:1049-1139`
- **Empfehlung:** Streaming/Pagination oder Dirty-Only-Scan.

### M12 — `writeGraphLinks` liest jede Notiz auch ohne Änderung
- **Dateien:** `lib/obsidian/graph-link-writer.js:218-304`
- **Empfehlung:** Hash-basiertes Skip nutzen.

### M13 — `db-adapter` Schema-Extensions rufen `table.schema()` mehrfach auf
- **Dateien:** `lib/db-adapter.js:141-233`, `:286-291`
- **Empfehlung:** Schema einmal lesen und an alle `ensure*Columns`-Funktionen übergeben.

### M14 — `@lancedb/lancedb` veraltet (0.26.2 vs. 0.30.0 latest)
- **Dateien:** `package.json`, `package-lock.json`
- **Empfehlung:** Upgrade evaluieren (Performance-Regression-Tests voraus).

### M15 — `@huggingface/transformers` zieht 340 MB ONNX-Overhead
- **Dateien:** `package.json` (optionalDependency)
- **Impact:** 513 MB `node_modules` bei 1,4 MB Source; jeder Nutzer zahlt Overhead, auch wenn nur OpenAI genutzt wird.
- **Empfehlung:** `--no-optional` empfehlen, Provider auslagern oder `overrides` für `onnxruntime-web`.

---

## 4. Niedrige Befunde

- `metrics-debounce` schluckt Timer-Fehler still (`lib/metrics-debounce.js:26-32`).
- `MemoryDB` normalisiert ~80 Felder pro Store/Update (`index.js:405-465`).
- `runtimeScheduler.drainRecall` sortiert Queue bei jedem Aufruf (`lib/runtime-scheduler.js:92-116`).
- `agent_end` berechnet Session-Digest über alle normalisierten Turns (`index.js:3266-3268`).
- Mehrere leere `.catch(() => {})` im Entry Point (`index.js:616`, `:4266`, `:4354`).
- `stableJson` ohne Zyklenerkennung (`lib/obsidian-bridge.js:768-774`).
- `recall-pipeline.js` dupliziert 35-Felder-Row-Mapping.
- Duplicate Package-Versions im Lockfile (`command-line-args`, `flatbuffers`, `onnxruntime-common` etc.).

---

## 5. Test- und Messübersicht

### Gesamte Test-Suite

```bash
node --test tests/*.test.js test/*.test.js
```

| Metrik | Wert |
|--------|------|
| Tests | 1.125 |
| Suites | 211 |
| Pass | 1.125 |
| Fail | 0 |
| Dauer | ~30,8 s |

### Performance-relevante Subsets

| Befehl | Tests | Dauer | Status |
|--------|-------|-------|--------|
| `node --test tests/perf-smoke.test.js tests/p2-performance.test.js tests/recall-budget.test.js tests/recall-compression.test.js tests/embedding-cache.test.js` | 37-54 | ~235-264 ms | ✅ pass |
| `node --test tests/recall-e2e.test.js tests/graph-index.test.js tests/conversation-reactivation-recall.test.js tests/semantic-lens-index.test.js` | 66 | ~249 ms | ✅ pass |

### Ad-hoc-Micro-Benchmarks

| Hotspot | Setup | Ergebnis | Bewertung |
|---------|-------|----------|-----------|
| `INJECTED_CONTEXT_RE` Regex | 10k Checks, 10k Zeichen | **1.408,49 ms** | 🔴 kritisch |
| `buildMaintenanceNudges` Conflict-Log | 100 Aufrufe, 20k Zeilen | **63,60 ms** | 🟠 hoch |
| Embedding-Cache `get()` Sweep | 10.000 Aufrufe, 5.000 Einträge | **127,98 ms** | 🟠 hoch |
| `dedupResults` Jaccard | 200 ähnliche Memories | **0,89 ms** | 🟡 mittel |
| `dedupResults` Jaccard | 1.000 Kandidaten, 100 Wörter | **32,6 ms** | 🟠 hoch |
| `extractGraphSignals` | 1.000 Extraktionen, 1.000 Wörter | **80,73 ms** | 🟠 hoch |
| `bounded-cache.set` | max=5.000, 10.000 Sets | **498,5 ms** | 🟡 mittel |
| Graph-Traversal `traverseGraph` | 5k Edges, 150 Nodes | **0,15 ms** | 🟢 gut |
| `syncWorkspace` approved apply | 500 Karten | **203,38 ms** | 🟠 hoch |
| `writeMemoryNotes` initial | 1.000 Records | **112,34 ms** | 🟡 mittel |
| `rebuildDashboards` | 1.000 Records | **153,55 ms** | 🟡 mittel |
| `aggregateEvidence` Skill-Miner | 2.000 Memories | **531,8 ms** | 🟠 hoch |
| `reflectOnSession` findDuplicates | 1.000 Memories | **304,8 ms** | 🟠 hoch |
| Cold-Import `index.js` | — | **25,4 ms** | 🟡 mittel |

---

## 6. Priorisierte Empfehlungen

### Sofort (P0) — vor nächstem Release

1. **Kritische Regex in `lib/neo-arch.js` optimieren** — super-linearer Match kann `agent_end` blockieren.
2. **LanceDB-Operationen mit Timeouts umschließen** — `withTimeout()`-Helper für Reads/Writes.
3. **`MemoryDB.update` auf atomares `table.update()` umstellen** oder delete+add mit Timeout/Retry absichern.
4. **`bounded-cache` async-Eviction fixen** — `AgentDbPool.shutdown()` korrekt awaited ausführen.
5. **Lokalen Reranker batchen** oder als nicht empfohlen markieren.
6. **Embedding-Cache für `local-transformers`** einführen.
7. **`shared-memory.detectConflicts` limitieren** — `maxCandidates` oder Sampling.
8. **`protobufjs`-Audit-Fail beheben** — CI wieder grün bekommen.

### Kurzfristig (P1) — nächster Sprint

9. `buildMaintenanceNudges`: Tail-Read statt komplettem `conflict-log.jsonl`.
10. Retrieval-Ledger + Daily-Decay batchen.
11. `scanActive()` mit Limit/Cursor versehen.
12. Overall-Timeout für Cron-Jobs einführen.
13. Job-Lock Stale-Zeit erhöhen.
14. `dedupResults` mit Token-Cache + frühem Abbruch optimieren.
15. `atomicJsonUpdate` auf async fs umstellen.
16. `getByIds` Batch-Größe 10 → 50-100.
17. LLM-Calls (`callLlm`, `knowledge_update`) mit Timeout absichern.
18. Obsidian Bridge: Mutex, Chunking, redundantes Rücklesen entfernen.

### Mittelfristig (P2)

19. Embedding-Cache Sweep lazy/periodisch machen.
20. `bounded-cache` auf O(1) LRU umstellen.
21. `MemoryDB.getRecentForGraph` DB-seitig sortieren.
22. Overlay-Ladepfad indexieren.
23. Semantic Lens / CRR Batch-Hydration.
24. `runtime-scheduler` `recallCache` maxEntries + Sweeping.
25. CRR `sessionState` TTL-Eviction.
26. `semantic-lens-index` `indexCache` begrenzen.
27. LanceDB auf 0.30.0 evaluieren.
28. Optional Dependency `@huggingface/transformers` bereinigen (Overhead reduzieren).
29. Build-Pipeline / Bundling evaluieren (Tree-Shaking, schnellerer Startup).

### Monitoring & Tests (P3)

30. Last-Regressionstests hinzufügen: 100k Edges, 1k Dedup-Kandidaten, 10k Cache-Einträge, 50k Memories.
31. Metriken erfassen: `recallLatencyMs`, `embeddingCacheHitRate`, `lensTimeoutRate`, `crrTimeoutRate`, `backgroundJobRuntimeMs`.
32. Dateigrößen-Logging für `conflict-log.jsonl`, `interpretation-overlays.jsonl`, Neo-JSONLs.

---

## 7. Offene Risiken

- **Reale DB-Größen:** Ad-hoc-Messungen simulieren nur algorithmische Skalierung; echte LanceDB-I/O-Kosten bei >50.000 Memories sind unbekannt.
- **LanceDB-Version:** Unterstützt 0.26.2 zuverlässig atomare `update()`? Falls nein, bleibt delete+add mit höherem Risiko.
- **Cron-Job-Laufzeiten:** Keine Metriken, wie lange `daily-consolidation` bei großen Vaults läuft.
- **Multi-Agent-DB-Pool:** Hard-Limit 50 Agent-DBs; bei mehr Agents entsteht ständiges Öffnen/Schließen.
- **Cache-Isolation:** `embedding-openai.js` verwendet globalen Key `"__global__"`, bricht per-Agent-Isolation.
- **Netzwerk-Disks:** `fsyncSync` in `obsidian-control-room.js` kann auf NAS/SMB sehr langsam werden.
- **CI-Blockade:** `npm audit --audit-level=moderate` schlägt aktuell fehl.

---

## 8. Audit-Methodik & geprüfte Bereiche

| Bereich | Subagent | Berichtspfad |
|---------|----------|--------------|
| Entry Point & Plugin Lifecycle | agent-0 | `/Users/cyberblade/performance-audit-entrypoint-lifecycle.md` |
| Recall & Search Pipeline | agent-1 | `docs/audits/performance-recall-pipeline-2026-06-16.md` |
| Background Jobs | agent-2 | In Subagent-Output enthalten |
| Obsidian Bridge & I/O | agent-3 | In Subagent-Output enthalten |
| Memory Dynamics, Caching & State | agent-4 | `/tmp/perf-audit-memory-dynamics-report.md` |
| Tests & Benchmarks | agent-5 | `/tmp/plur1bus-performance-audit-tests-benchmarks.md` |
| Dependencies & Build Surface | agent-6 | In Subagent-Output enthalten |

---

## 9. Fazit

PLUR1BUS v6.6.0 ist **funktional reif** und hat eine **solide Testbasis**. Für kleine bis mittlere Workloads ist die Performance ausreichend. Unter Wachstum (viele Memories, große Vaults, lange Conflict-Logs, lokale Modelle) zeigen sich jedoch **mehrere systematische Skalierungsgrenzen**, die zu Blockierungen, Timeouts und Ressourcenlecks führen können.

Die wichtigsten Hebel für das nächste Release sind:

1. **Hot-Path-I/O und Timeouts** (Regex, Conflict-Log, LanceDB-Timeouts, LLM-Timeouts).
2. **Atomare/batched DB-Updates** statt delete+add und N+1.
3. **Lokale ML-Provider** (Reranker + Embedding) batchen/cachen.
4. **Cache-Implementierungen** auf O(1) umstellen und begrenzen.
5. **CI-Sicherheit** (`protobufjs`-Audit-Fail) beheben.

Empfohlener nächster Schritt: Einen Sprint mit den P0/P1-Maßnahmen planen und dabei Last-Regressionstests ergänzen, die die gefundenen Hotspots gegen zukünftige Verschlechterungen absichern.
