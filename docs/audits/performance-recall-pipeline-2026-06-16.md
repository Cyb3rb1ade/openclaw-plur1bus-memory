# Performance-Audit Teilbericht — Recall & Search Pipeline

**Plugin:** `@cyb3rb1ade/plur1bus-memory`  
**Fokusbereich:** Recall & Search Pipeline  
**Datum:** 2026-06-16  
**Auditor:** Kimi Code CLI (Subagent)  
**Hinweis:** Nur lesende Analyse; es wurden keine Code-Änderungen committet.

---

## Fokusbereich

Recall & Search Pipeline: vom eingehenden Prompt über Embedding, Vektorsuche (LanceDB), Scoring/Boosting, Reranking, assoziativen Graph-Spread, Deduplizierung, Budget-Allokation, Kanonische Auswahl, Semantic Lens / CRR bis zur finalen Prompt-Kontext-Formatierung.

---

## Geprüfte Dateien/Module

| Pfad | Rolle im Recall-Pfad |
|------|----------------------|
| `index.js` (Zeilen ~330–355, ~1444, ~1480–1520, ~3440–3522, ~3970–4300, ~4285–4299) | Plugin-Integration, Aufruf der Pipeline, Runtime-Timeout, Recall-Cache |
| `lib/recall-pipeline.js` (komplett, 662 Zeilen) | Zentrale Orchestrator-Pipeline |
| `lib/embedding-cache.js` | LRU+TTL Embedding-Cache |
| `lib/relevant-memory-context.js` | Formatierung des `<relevant-memories>`-Blocks |
| `lib/recall-budget.js` | Adaptive Budget-Allokation |
| `lib/memory-graph.js` | Graph-Traversierung, Edge-Generierung, Metrics |
| `lib/graph-index.js` | In-Memory-Index für Graph-Edges |
| `lib/query-refiner.js` | Query-Verfeinerung mit Synonym-Expansion |
| `lib/semantic-lens-index.js` | Semantic Lens (additive Community-Suche) |
| `lib/conversation-reactivation-recall.js` | Conversation Reactivation Recall (CRR) |
| `lib/text-utils.js` | `tokenize`, `jaccardSimilarity`, `generateSummary`, `compressMemoriesForPrompt` |
| `lib/emotional-state.js` | Stimmungsabhängiger Recall-Boost |
| `lib/providers/embedding-openai.js` | OpenAI-Embedding-Provider (mit Cache) |
| `lib/providers/embedding-local-transformers.js` | Lokaler Embedding-Provider (ohne Cache) |
| `lib/providers/reranker-chained.js` | Chained Reranker |
| `lib/providers/reranker-cohere.js` | Cohere Reranker |
| `lib/providers/reranker-local-transformers.js` | Lokaler Reranker (ohne Batching) |
| `lib/interpretation-overlay.js` | Overlay-Ladepfad (`loadForTargets`, `loadAllOverlays`) |
| `lib/neo-arch.js` (Zeilen ~1215–1271, ~1023, ~1030) | JSONL-Tail-Reads/Append, Bounded Growth |
| `lib/metrics.js` + `lib/metrics-debounce.js` | Debounced Metrics-Flush |
| `lib/runtime-scheduler.js` | Recall-Scheduler, Timeout, Recall-Cache |
| `docs/recall-architecture.md` | Architektur-Dokumentation |
| `AGENTS.md` | Konventionen (Timeouts, Caches, Limits) |

---

## Gefundene Performance-Probleme

### 1. Lokaler Reranker ohne Batching (kritisch)

- **Beschreibung:** `LocalTransformersRerankerProvider.rerank` iteriert sequentiell über alle Dokumente und ruft das Modell für jedes Paar einzeln auf (`await _scorePair(...)`). Es gibt kein Batching.
- **Datei/Zeilen:** `lib/providers/reranker-local-transformers.js`, Zeilen 47–54
- **Begründung/Einfluss:** Bei `rerankCandidates=20` entstehen 20 synchrone Modell-Forward-Passes statt einem Batch. Das ist typischerweise 10–50× langsamer als ein Batch-Call. Im Worst Case werden damit die 5 s Reranker-Timeout systematisch überschritten, was den Fallback auf unrerankte Ergebnisse erzwingt und die Recall-Qualität senkt.
- **Empfohlene Maßnahme:** Transformers-Pipeline so aufrufen, dass `text` ein Array von Dokumenten ist (z. B. `classifier([{text: query, text_pair: doc1}, ...])`) oder auf ein Modell umsteigen, das nativ Batch-Reranking unterstützt.

### 2. Embedding-Cache fehlt für `local-transformers` (kritisch)

- **Beschreibung:** Nur `OpenAIEmbeddingProvider` verwendet `createEmbeddingCache`. `LocalTransformersEmbeddingProvider` hat keinerlei Cache.
- **Datei/Zeilen:** `lib/providers/embedding-local-transformers.js`, keine Cache-Referenz; `lib/providers/embedding-openai.js`, Zeilen 42–45, 112, 121, 137
- **Begründung/Einfluss:** Bei lokalem Embedding wird derselbe Prompt/Text bei jeder Turn-Wiederholung neu embeddet. Das ist besonders teuer, weil der lokale Modell-Laden und Forward-Pass deutlich langsamer ist als ein Cache-Hit. Hot-Path wird unnötig blockiert.
- **Empfohlene Maßnahme:** `LocalTransformersEmbeddingProvider` denselben `_cache`-Mechanismus wie OpenAI geben oder einen Provider-übergreifenden Cache in der Pipeline einführen.

### 3. Cache-Parameter widersprechen Architektur-Dokumentation (hoch)

- **Beschreibung:** `docs/recall-architecture.md` spezifiziert "LRU (TTL 5 min, max 1000)". Tatsächlich verwendet `embedding-cache.js` Defaults von 500 Einträgen / 30 Minuten und der OpenAI-Provider 500 / 30 Minuten.
- **Datei/Zeilen:** `docs/recall-architecture.md`, Zeile 14; `lib/embedding-cache.js`, Zeile 26; `lib/providers/embedding-openai.js`, Zeilen 42–45
- **Begründung/Einfluss:** Inkonsistenz führt zu verwirrenden Erwartungen. 30 Min TTL bei 500 Einträgen kann bei kurzen, hochfrequenten Agent-Turns Speicher bloaten; 5 Min TTL / 1000 wären näher an der dokumentierten Absicht.
- **Empfohlene Maßnahme:** Architektur-Dokumentation oder Default-Parameter anpassen; bevorzugt Cache-Defaults erhöhen (1000 Einträge) und TTL auf 5 Min reduzieren.

### 4. `dedupResults` ist O(n²) in der Anzahl Kandidaten (hoch)

- **Beschreibung:** Für jedes Kandidaten-Paar wird `jaccardSimilarity` berechnet. Das ist ein quadratischer Vergleich.
- **Datei/Zeilen:** `lib/recall-pipeline.js`, Zeilen 51–68
- **Begründung/Einfluss:** `fetchLimit` kann `rerankCandidates` (default 20–40) oder `topN * 3` (default 36) sein. Nach Graph-Spread (`mergeAssociativeResults` mit `maxTotal=15` bzw. `topN*3`) bleibt die Menge klein, aber wenn `dedupEnabled` vor dem Graph-Spread oder mit vielen Kandidaten aufgerufen würde, wäre es teuer. Unser Ad-hoc-Benchmark: 100 Items = ~0,13 ms/Op; im Worst Case mit vielen langen Texten steigt es.
- **Empfohlene Maßnahme:** MinHash/LSH oder zumindest frühes Length-Pruning vor Jaccard einführen; aktuell ist es aber für die default Pipeline akzeptabel.

### 5. Query-Refiner löst sequentiell zweiten Embedding-Call aus (hoch)

- **Beschreibung:** Wenn `queryRefinerEnabled=true` und die ersten Treffer unter `recallMinScore` liegen, wird eine verfeinerte Query generiert und **erneut** embeddet, gefolgt von einer zweiten LanceDB-Suche.
- **Datei/Zeilen:** `lib/recall-pipeline.js`, Zeilen 420–485
- **Begründung/Einfluss:** Jeder Embedding-Call kostet Netzwerk-/GPU-Latenz. Bei langsamen Providern verdoppelt sich die Recall-Latenz. Ad-hoc-Messung zeigte: mit Query-Refinement 2 Embedding-Calls = ~23 ms (simuliert 10 ms/Call); ohne Refinement 1 Call = ~11 ms. In Produktion mit OpenAI-Latenz von 200–500 ms bedeutet das +200–500 ms.
- **Empfohlene Maßnahme:** Query-Refiner default deaktiviert lassen (ist er aktuell); falls aktiviert, hartes Timeout hinzufügen und parallele Ausführung der beiden Suchpfade erwägen.

### 6. `buildMaintenanceNudges` liest komplette `conflict-log.jsonl` (hoch)

- **Beschreibung:** Zur Ermittlung der Zeilenzahl und des Alters der ersten Zeile wird die gesamte Datei mit `readFileSync(...).split("\n").filter(...)` in den Speicher geladen.
- **Datei/Zeilen:** `index.js`, Zeilen 1083–1100
- **Begründung/Einfluss:** Bei langem Betrieb kann `conflict-log.jsonl` mehrere MB groß werden. Der Aufruf passiert auf dem Hot-Path `before_prompt_build` für jede Agent-Turn. Das blockiert den Event Loop synchron.
- **Empfohlene Maßnahme:** Nur die ersten N Zeilen + eine gezählte Zeilenzahl lesen (`readline`-Interface oder Tail-Read aus `neo-arch.js` wiederverwenden); Datei-Stat-Check vor dem Lesen beibehalten.

### 7. `InterpretationOverlayStore.loadAllOverlays` parst JSONL komplett (hoch)

- **Beschreibung:** `loadAllOverlays` liest die gesamte `interpretation-overlays.jsonl` in den Speicher und parst jede Zeile, auch wenn später nur wenige `targetMemoryIds` gefiltert werden.
- **Datei/Zeilen:** `lib/interpretation-overlay.js`, Zeilen 149–174, 183–200
- **Begründung/Einfluss:** Im Recall-Pfad werden Overlays für die gewählten Memory-IDs geladen. Bei vielen Overlays im Workspace wird aber trotzdem die komplette Datei gelesen. Das passiert innerhalb des 45 s Recall-Timeouts, ist aber unnötig blockierend.
- **Empfohlene Maßnahme:** In-Memory-Index für `targetMemoryId → Zeilen-Offsets` aufbauen oder zumindest aufschlagbaren Index beim Schreiben pflegen.

### 8. `semantic-lens-index.js` / CRR: sequestrierte Hydration via `getMemoryById` (mittel)

- **Beschreibung:** `selectLensMemories` (Semantic Lens) und `selectReactivationMemories` (CRR) rufen für Kandidaten, die nicht im Index enthalten sind, sequentiell `getMemoryById` auf.
- **Datei/Zeilen:** `lib/semantic-lens-index.js`, Zeilen 126–149; `lib/conversation-reactivation-recall.js`, Zeilen 339–361, 386–398, 407–413
- **Begründung/Einfluss:** CRR hat ein Hydration-Budget (`MAX_COMMUNITY_HYDRATIONS = 12`), Semantic Lens hat ein Timeout von 50 ms. Trotzdem können mehrere serielle DB-Lookups das 50 ms-Budget verbrauchen. Ad-hoc-Messung: Semantic Lens mit `memoryById`-Map = 0,3 ms; mit simuliertem 5 ms `getMemoryById`-Delay = ~6 ms.
- **Empfohlene Maßnahme:** Batch-Hydration für `getMemoryById` einführen (mehrere IDs in einem LanceDB-IN-Query); CRR-Kandidaten vorab filtern, bevor Hydration gestartet wird.

### 9. `conversation-reactivation-recall.js`: unbegrenztes `sessionState` Map (mittel)

- **Beschreibung:** Modul-level `sessionState = new Map()` speichert pro `agentId + sessionKey` einen Zustand, ohne jemals Einträge zu entfernen.
- **Datei/Zeilen:** `lib/conversation-reactivation-recall.js`, Zeilen 182–194
- **Begründung/Einfluss:** Bei vielen Agenten/Sessions wächst die Map unbegrenzt. Jeder Eintrag ist klein, aber langlaufende Prozesse können hier ein langsames Memory-Leck entwickeln.
- **Empfohlene Maßnahme:** TTL-Eviction für Session-State einführen (z. B. Einträge älter als 7 Tage entfernen).

### 10. `semantic-lens-index.js`: unbegrenzter `indexCache` (mittel)

- **Beschreibung:** `indexCache` ist ein globaler `Map` ohne Größenlimit; er hält geladene `semantic-lens-index.json`-Dateien mit mtime/TTL.
- **Datei/Zeilen:** `lib/semantic-lens-index.js`, Zeilen 14, 68–87, 46–48
- **Begründung/Einfluss:** Bei vielen Workspaces wächst der Cache linear; zwar hat er TTL, aber ohne LRU-Limit kann er bei häufig wechselnden Workspaces übermäßig Speicher verbrauchen.
- **Empfohlene Maßnahme:** Auf `createEmbeddingCache` oder `makeBoundedCache` umstellen.

### 11. `getKnowledgeChunks` embeddet KNOWLEDGE.md-Sections sequentiell (mittel)

- **Beschreibung:** Jede Section von `KNOWLEDGE.md` wird nacheinander embeddet.
- **Datei/Zeilen:** `lib/recall-pipeline.js`, Zeilen 123–150
- **Begründung/Einfluss:** Bei umfangreichem KNOWLEDGE.md mit vielen Sections verlängert sich die erste Recall-Latenz um die Summe aller Embedding-Calls. Es gibt kein Batching und keine parallele Ausführung.
- **Empfohlene Maßnahme:** Sections parallel embedden (`Promise.all` mit kleinem Limit) oder Embedding-Provider mit Batch-API nutzen.

### 12. `LocalTransformersEmbeddingProvider` lädt Pipeline bei jedem Prozess neu (mittel)

- **Beschreibung:** `_pipeline` wird lazy geladen, aber bei jedem neuen Prozess/Neustart des Plugins erfolgt der Modell-Download/Laden erneut.
- **Datei/Zeilen:** `lib/providers/embedding-local-transformers.js`, Zeilen 29–45
- **Begründung/Einfluss:** Das ist ein Cold-Start-Problem. Es betrifft nicht den Recall-Hot-Path, aber nach jedem Plugin-Reload entstehen mehrere Sekunden Latenz.
- **Empfohlene Maßnahme:** Persistenter Model-Cache auf Dateisystem-Ebene ist bereits vorhanden (`cacheDir`); Dokumentation, dass `cacheDir` gesetzt sein sollte.

### 13. `ChainedRerankerProvider` ohne Timeout-Propagation (mittel)

- **Beschreibung:** Der Chained Reranker fängt Primary-Fehler und versucht den Fallback, aber er propagiert kein eigenes Timeout. Die Pipeline räumt zwar mit `Promise.race` gegen `rerankerTimeoutMs` auf, aber der Primary-Request läuft im Hintergrund weiter, bis Cohere/fetch sein 30 s Timeout erreicht.
- **Datei/Zeilen:** `lib/providers/reranker-chained.js`, Zeilen 16–23; `lib/providers/reranker-cohere.js`, Zeilen 14–16
- **Begründung/Einfluss:** Verschwendet Ressourcen und kann im Hochlastfall offene Verbindungen ansammeln.
- **Empfohlene Maßnahme:** `rerankerTimeoutMs` an den Chained-Reranker durchreichen und im Primary/Fallback mit `AbortController` abbrechen.

### 14. `fetchLimit`-Berechnung kann unnötig viele Rows ziehen (niedrig)

- **Beschreibung:** `fetchLimit = reranker ? Math.max(rerankCandidates, topN * 3) : topN`. Wenn `rerankCandidates=40` und `topN=12`, werden 40 Rows von LanceDB gelesen.
- **Datei/Zeilen:** `lib/recall-pipeline.js`, Zeile 378
- **Begründung/Einfluss:** Mehr Kandidaten = mehr Speicher und mehr Arbeit in Scoring/Dedup. Für `topN=12` wären 36 ausreichend.
- **Empfohlene Maßnahme:** `fetchLimit` auf `Math.max(rerankCandidates, topN * 3)` belassen, aber `rerankCandidates` default an `topN` koppeln.

### 15. `formatRelevantMemoriesContext` iteriert mehrfach über Overlays (niedrig)

- **Beschreibung:** Pro Memory wird `overlayMap.get(m.id)` aufgerufen; das ist O(1), aber die Overlay-Daten werden für jeden Render erneut zusammengebaut.
- **Datei/Zeilen:** `lib/relevant-memory-context.js`, Zeilen 49–56, 94–115
- **Begründung/Einfluss:** Bei 12 Memories + 12 Overlays = ~0,012 ms/Op (Ad-hoc-Benchmark). Vernachlässigbar, aber bei deutlich mehr Overlays kann es wachsen.
- **Empfohlene Maßnahme:** Aktuell ausreichend; bei Skalierung auf >50 Overlays frühzeitig prüfen.

---

## Messungen/Tests

### Ausgeführte existierende Tests

| Testdatei | Ergebnis | Laufzeit | Status |
|-----------|----------|----------|--------|
| `tests/perf-smoke.test.js` | 9 Tests | ~235 ms gesamt (mit allen anderen) | ✅ pass |
| `tests/p2-performance.test.js` | 7 Tests | Teil der 235 ms | ✅ pass |
| `tests/recall-budget.test.js` | 13 Tests | Teil der 235 ms | ✅ pass |
| `tests/recall-compression.test.js` | 12 Tests | Teil der 235 ms | ✅ pass |
| `tests/embedding-cache.test.js` | 10 Tests | Teil der 235 ms | ✅ pass |
| `tests/recall-e2e.test.js` | 5 Tests | Teil der 235 ms | ✅ pass |
| `tests/recall-p0.test.js` | 6 Tests | Teil der 235 ms | ✅ pass |
| `tests/graph-index.test.js` | 8 Tests | ~8 ms | ✅ pass |
| `tests/recall-pipeline-hydration.test.js` | 6 Tests | Teil der 202 ms | ✅ pass |
| `tests/conversation-reactivation-recall.test.js` | inkludiert | Teil der 202 ms | ✅ pass |
| `tests/recall-p1.test.js` | 8 Tests | Teil der 202 ms | ✅ pass |
| `tests/recall-golden-set.test.js` | 7 Tests | Teil der 202 ms | ✅ pass |
| `tests/smoke-reranker-pipeline.test.js` | 4 Tests | ~5,1 s (Timeout-Test wartet 500 ms) | ✅ pass |

**Gesamt:** Alle 101 ausgeführten Tests bestanden.

### Ad-hoc Hotspot-Messungen

Die folgenden Messungen wurden mit temporären Skripten in `tmp/` durchgeführt und anschließend gelöscht.

| Hotspot | Szenario | Ergebnis | Bewertung |
|---------|----------|----------|-----------|
| `dedupResults` | 20 Items, 1000 Iterationen | 26,9 ms total / 0,027 ms/op | ✅ akzeptabel |
| `dedupResults` | 100 Items, 100 Iterationen | 13,0 ms total / 0,13 ms/op | ⚠️ beobachten |
| `traverseGraph` | 5.000 Edges, 1.000 Iterationen | 2,4 ms total / 0,002 ms/op | ✅ sehr gut |
| `generateSummary` | 500 Wörter, 10.000 Iterationen | 101 ms total / 0,01 ms/op | ✅ gut |
| `compressMemoriesForPrompt` | 12×500 Wörter, 1.000 Iterationen | 94 ms total / 0,094 ms/op | ✅ gut |
| `formatRelevantMemoriesContext` | 12 Memories, 10.000 Iterationen | 61 ms total / 0,006 ms/op | ✅ gut |
| `formatRelevantMemoriesContext` | 12 Memories + 12 Overlays, 10.000 Iterationen | 124 ms total / 0,012 ms/op | ✅ gut |
| `tokenize` | 280 Zeichen, 10.000 Iterationen | 55,8 ms / 0,006 ms/op | ✅ gut |
| `jaccardSimilarity` | 280×2 Zeichen, 10.000 Iterationen | 110,5 ms / 0,011 ms/op | ✅ gut |
| `mergeAssociativeResults` | 20 Vector + 40 Assoc, 10.000 Iterationen | 16,7 ms / 0,002 ms/op | ✅ gut |
| `hydrateGraphResults` | 50 IDs via IN-Query | ~0,3 ms | ✅ gut |
| `hydrateGraphResults` | 50 IDs Fallback (Batches von 10) | ~0,3 ms | ✅ gut |
| `applySemanticLensToRecall` | memoryById-Map | ~0,3 ms | ✅ gut |
| `applySemanticLensToRecall` | getMemoryById + 5 ms Delay | ~5–6 ms | ⚠️ knapp am 50 ms Budget |
| `selectReactivationMemories` | typisches CRR-Szenario | ~0,7 ms | ✅ gut |
| `computeRecallBoost` | 50 Memories | ~0,1 ms | ✅ vernachlässigbar |
| `runRecallPipeline` mit Query-Refiner | 2 Embedding-Calls (simuliert 10 ms/Call) | ~23 ms vs. ~12 ms ohne Refiner | ⚠️ Latenzverdopplung |

---

## Empfohlene Maßnahmen (priorisiert)

1. **Batching im lokalen Reranker** (kritisch)
   - `lib/providers/reranker-local-transformers.js` so umbauen, dass alle Dokumente in einem Batch-Call klassifiziert werden.
   - Falls das Modell das nicht unterstützt, den lokalen Reranker als nicht empfohlen markieren oder durch ein batch-fähiges Modell ersetzen.

2. **Embedding-Cache für `local-transformers`** (kritisch)
   - `LocalTransformersEmbeddingProvider` denselben Cache wie OpenAI spendieren oder Cache in die Pipeline heben.

3. **`buildMaintenanceNudges` optimieren** (hoch)
   - `conflict-log.jsonl` nicht komplett einlesen; Tail/Head-Read oder `neo-arch.js::readJsonlTailLines` wiederverwenden.

4. **Overlay-Ladepfad indexieren** (hoch)
   - `InterpretationOverlayStore` mit einem Offset-Index für `targetMemoryId` versehen oder zumindest nur relevante Zeilen parsen.

5. **Cache-Defaults angleichen** (hoch)
   - Entscheidung: 1000 Einträge / 5 Minuten TTL (wie in Architektur-Doku) oder Doku aktualisieren.

6. **Query-Refiner absichern** (hoch)
   - Sicherstellen, dass `queryRefinerEnabled` default `false` bleibt; hartes Sub-Timeout einführen; parallele Embedding/Suche erwägen.

7. **Semantic Lens / CRR Batch-Hydration** (mittel)
   - `getMemoryById`-Calls sammeln und als Batch-IN-Query an LanceDB schicken.

8. **Session-State und Lens-Cache begrenzen** (mittel)
   - `sessionState` in CRR mit TTL-Eviction versehen.
   - `indexCache` in `semantic-lens-index.js` durch bounded Cache ersetzen.

9. **KNOWLEDGE.md-Sections parallel embedden** (mittel)
   - `Promise.all` mit Limit in `getKnowledgeChunks`.

10. **Reranker-Timeout-Propagation** (mittel)
    - `ChainedRerankerProvider` sollte `AbortController` mit `rerankerTimeoutMs` verwenden.

11. **Regelmäßige Profiling-Runs** (niedrig)
    - Ad-hoc-Benchmark-Skripte in `tests/perf-*.test.js` festhalten (z. B. dedup 100 Items, Semantic Lens Delay).

---

## Offene Fragen/Risiken

- **Reranker in Produktion:** Es ist unklar, wie häufig Cohere vs. Local Transformers vs. kein Reranker eingesetzt wird. Der lokale Reranker ist aktuell der größte Latenz-Risiko.
- **Größe von `interpretation-overlays.jsonl` und `conflict-log.jsonl` in Produktion:** Ohne reale Dateigrößen ist die Einschätzung der I/O-Last spekulativ. Empfehlung: Logging der Dateigrößen hinzufügen.
- **Graph-Edge-Anzahl:** Der Graph-Index skaliert gut, aber `traverseGraph` hat ein `maxVisitedNodes=150`. Bei sehr dichten Graphen könnte die Beam-Search-Traversierung trotzdem kurz vor dem Timeout kippen.
- **Embedding-Cache invalidiert nicht bei Modellwechsel:** Der Cache-Key enthält `modelVersion`, aber wenn sich die Modellkonfiguration (z. B. `dimensions`) ändert, ohne dass sich der Modellname ändert, können stale Vektoren verwendet werden.
- **LanceDB ANN-Index:** Reindex passiert nur im Schreibpfad. Bei sehr großen Tabellen ohne Index könnte `vectorSearch` langsamer werden; aktuell ist das aber durch `REINDEX_MIN_INTERVAL_MS` und Thresholds abgedeckt.
- **Runtime-Scheduler Recall-Cache:** Der Cache ist 120 s TTL. Bei schnell wechselnden Prompts könnte veralteter Kontext zurückgegeben werden, wenn ein Turn Timeout hat und der vorherige Cache verwendet wird.

---

## Zusammenfassung

Die Recall & Search Pipeline ist insgesamt gut optimiert: Embedding-Cache (für OpenAI), Graph-Index, debounced Metrics und bounded JSONL-Growth arbeiten effektiv. Die existierenden Performance-Tests bestehen alle.

Die größten konkreten Risiken liegen in **nicht gecachten lokalen Embeddings**, dem **fehlenden Batching im lokalen Reranker** und **synchronen I/O-Operationen auf dem Hot-Path** (`buildMaintenanceNudges`, Overlay-Laden). Diese sollten vor dem nächsten Release adressiert werden, besonders wenn lokale Modelle produktiv genutzt werden.
