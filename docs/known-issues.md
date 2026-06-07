# Known Issues — v6.1.0 (Engram) GA

> Stand: 2026-06-07  
> Release: v6.1.0 General Availability

Die folgenden Einschränkungen sind bekannt und werden in einem zukünftigen Patch adressiert. Sie blockieren den Produktivbetrieb nicht.

---

## 1. Embedding-Cache noch nicht hot-verdrahtet

**Beschreibung:** Die Embedding-Cache-Implementierung (`embeddingCacheEnabled`, `embeddingCacheTtlMs`, `embeddingCacheMaxEntries`) ist vollständig vorhanden, aber noch nicht in den Recall-Hot-Path von `index.js` eingebunden.

**Impact:** Der Cache wird aktuell nicht genutzt; jeder Recall-Aufruf berechnet Embeddings neu.

**Workaround:** Keiner erforderlich – Performance-Regression gegenüber v6.0.x liegt im Messrauschen.

**Fix-Target:** v6.2.0

---

## 2. metricsDebounceMs hartcodiert

**Beschreibung:** Der Debounce-Wert für den Telemetrie-Flush im Recall-Hot-Path ist auf `250 ms` hartcodiert (`metricsDebounceMs` existiert als Config-Key, wird aber noch nicht vom Hot-Path gelesen).

**Impact:** In hochfrequenzigen Setups kann der Wert nicht ohne Code-Änderung angepasst werden.

**Workaround:** Direkte Modifikation der Konstante in `lib/recall-pipeline.js`.

**Fix-Target:** v6.2.0

---

## 3. Over-Exports in neo-arch.js / obsidian-*.js

**Beschreibung:** Mehr als 60 überflüssige Exports in `lib/neo-arch.js` und `lib/obsidian-*.js` führen zu Bundler-Warnungen und vergrößern die API-Oberfläche unnötig.

**Impact:** Reines Hygiene-Thema; keine Laufzeit-Auswirkungen.

**Workaround:** Keiner erforderlich.

**Fix-Target:** v6.2.0

---

## 4. atomic-json.js: Reentrancy-Deadlock bei nested Updates

**Beschreibung:** `atomicJsonUpdate` in `lib/atomic-json.js` verwendet einen `activeFiles`-Set-Schutz gegen Reentrancy. Wenn ein `async updater` innerhalb seiner Ausführung **awaited** ein weiteres `atomicJsonUpdate` für dieselbe Datei aufruft, entsteht ein Deadlock:

```js
await atomicJsonUpdate(filePath, async () => {
  await atomicJsonUpdate(filePath, () => ({ nested: true }));
  return { outer: true };
});
```

**Impact:** Produktions-Abstürze sind unwahrscheinlich, da typische Nutzung keine verschachtelten Updates auf derselben Datei ausführt. Bei fehleranfälligen Callbacks kann der Prozess jedoch hängen bleiben.

**Workaround:** Vermeidung von verschachtelten `atomicJsonUpdate`-Aufrufen auf derselben Datei innerhalb eines Updaters.

**Fix-Target:** v6.2.0 — `activeFiles`-Check vor Queue-Einfügung verschieben oder Timeout/Rejection-Mechanismus einbauen.

---

## Zusammenfassung

| Issue | Schwere | Workaround | Fix-Target |
|-------|---------|------------|------------|
| Embedding-Cache nicht hot-verdrahtet | Mittel | Nein | v6.2.0 |
| metricsDebounceMs hartcodiert | Niedrig | Ja (Code-Edit) | v6.2.0 |
| 60+ Over-Exports | Niedrig | Nein | v6.2.0 |
| atomic-json Reentrancy-Deadlock | Niedrig-Mittel | Ja (Pattern vermeiden) | v6.2.0 |
