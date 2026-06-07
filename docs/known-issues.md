# Known Issues — v6.1.0-rc1 (Engram)

> Stand: 2026-06-07
> Diese Liste betrifft ausschließlich den RC1-Stand und wird vor dem finalen v6.1.0-Release abgearbeitet.

---

## 1. Embedding-Cache noch nicht hot-verdrahtet

**Beschreibung:** Die Embedding-Cache-Implementierung (`embeddingCacheEnabled`, `embeddingCacheTtlMs`, `embeddingCacheMaxEntries`) ist vollständig vorhanden, aber noch nicht in den Recall-Hot-Path von `index.js` eingebunden.

**Impact:** Der Cache wird aktuell nicht genutzt; jeder Recall-Aufruf berechnet Embeddings neu.

**Workaround:** Keiner erforderlich – Performance-Regression gegenüber v6.0.x liegt im Messrauschen.

**Fix-Target:** P5+ (Post-RC1)

---

## 2. metricsDebounceMs hartcodiert

**Beschreibung:** Der Debounce-Wert für den Telemetrie-Flush im Recall-Hot-Path ist auf `250 ms` hartcodiert (`metricsDebounceMs` existiert nicht als Config-Key).

**Impact:** In hochfrequenzigen Setups kann der Wert nicht ohne Code-Änderung angepasst werden.

**Workaround:** Direkte Modifikation der Konstante in `lib/recall-pipeline.js` (Zeile ~42).

**Fix-Target:** P5+ (Post-RC1)

---

## 3. Over-Exports in neo-arch.js / obsidian-*.js

**Beschreibung:** Mehr als 60 überflüssige Exports in `lib/neo-arch.js` und `lib/obsidian-*.js` führen zu Bundler-Warnungen und vergrößern die API-Oberfläche unnötig.

**Impact:** Reines Hygiene-Thema; keine Laufzeit-Auswirkungen.

**Workaround:** Keiner erforderlich.

**Fix-Target:** P5+ (Post-RC1)

---

## Zusammenfassung

| Issue | Schwere | Workaround | Fix-Target |
|-------|---------|------------|------------|
| Embedding-Cache nicht hot-verdrahtet | Mittel | Nein | P5+ |
| metricsDebounceMs hartcodiert | Niedrig | Ja (Code-Edit) | P5+ |
| 60+ Over-Exports | Niedrig | Nein | P5+ |
