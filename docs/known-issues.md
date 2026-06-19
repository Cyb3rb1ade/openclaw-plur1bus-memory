# Known Issues — v6.1.0 (Engram) GA

> Erstellt: 2026-06-07 · Zuletzt aktualisiert: 2026-06-19 (v6.7.0 Auflösungsmarkierungen)
> Release: v6.1.0 General Availability

---

## 1. ~~Embedding-Cache noch nicht hot-verdrahtet~~ — ✅ Behoben in v6.2.1

**Beschreibung (original):** Die Embedding-Cache-Implementierung war vollständig vorhanden, aber noch nicht in den Recall-Hot-Path eingebunden.

**Auflösung (v6.2.1):** `OpenAIEmbeddingProvider` verdrahtet den Cache direkt (`lib/providers/embedding-openai.js`). Ab v6.7.0 ist `runtime.embeddingCacheEnabled` im Full Experience Default auf `true` gesetzt. Der Cache läuft pro Plugin-Instanz im Speicher (LRU, configurable TTL/maxEntries).

---

## 2. ~~metricsDebounceMs hartcodiert~~ — ✅ Behoben in v6.2.x

**Beschreibung (original):** Debounce-Wert für Telemetrie-Flush war hartcodiert auf 250 ms.

**Auflösung:** `lib/metrics-debounce.js` exportiert `createMetricsDebouncer({ debounceMs })` mit konfigurierbarem Default (5000 ms). Kein Hardcode mehr in `lib/recall-pipeline.js`.

---

## 3. Over-Exports in neo-arch.js / obsidian-*.js

**Beschreibung:** Mehr als 60 überflüssige Exports in `lib/neo-arch.js` und `lib/obsidian-*.js` führen zu Bundler-Warnungen und vergrößern die API-Oberfläche unnötig.

**Impact:** Reines Hygiene-Thema; keine Laufzeit-Auswirkungen.

**Status:** Offen — kein Fix-Zieldatum. Kein Produktionsrisiko.

---

## 4. ~~atomic-json.js: Reentrancy-Deadlock bei nested Updates~~ — ✅ Behoben

**Beschreibung (original):** Verschachtelte `atomicJsonUpdate`-Aufrufe auf derselben Datei konnten zu einem Deadlock führen.

**Auflösung:** `lib/atomic-json.js` wirft jetzt sofort mit `"Nested atomicJsonUpdate for same file is not allowed"` bei erkannter Reentrancy. Kein Deadlock mehr — stattdessen ein sofortiger, erklärender Fehler der die Nutzung korrigiert.

---

## Zusammenfassung

| Issue | Schwere | Status | Behoben in |
|-------|---------|--------|------------|
| Embedding-Cache nicht hot-verdrahtet | Mittel | ✅ Behoben | v6.2.1 |
| metricsDebounceMs hartcodiert | Niedrig | ✅ Behoben | v6.2.x |
| 60+ Over-Exports | Niedrig | Offen | — |
| atomic-json Reentrancy-Deadlock | Niedrig-Mittel | ✅ Behoben | v6.x |
