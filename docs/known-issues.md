# Known Issues — v7.1.2

> Erstellt: 2026-06-07 · Zuletzt aktualisiert: 2026-07-24 (v7.1.2)
> Release: v7.1.2 Current Baseline

---

## 1. ~~Embedding-Cache noch nicht hot-verdrahtet~~ — ✅ Behoben in v6.2.1

**Beschreibung (original):** Die Embedding-Cache-Implementierung war vollständig vorhanden, aber noch nicht in den Recall-Hot-Path eingebunden.

**Auflösung (v6.2.1):** `OpenAIEmbeddingProvider` verdrahtet den Cache direkt (`lib/providers/embedding-openai.js`). Seit v6.8.12 ist `runtime.embeddingCacheEnabled` im Full Experience Default auf `true` gesetzt. Der Cache läuft pro Plugin-Instanz im Speicher (LRU, configurable TTL/maxEntries).

---

## 2. ~~metricsDebounceMs hartcodiert~~ — ✅ Behoben in v6.2.x

**Beschreibung (original):** Debounce-Wert für Telemetrie-Flush war hartcodiert auf 250 ms.

**Auflösung:** `lib/metrics-debounce.js` exportiert `createMetricsDebouncer({ debounceMs })` mit konfigurierbarem Default (5000 ms). Kein Hardcode mehr in `lib/recall-pipeline.js`.

---

## 3. Reranker-Scoring-Qualität

**Beschreibung:** Ein bereits vor v7.1.0 bestehender Scoring-Fehler kann die
Qualität bzw. Reihenfolge einzelner Reranker-Ergebnisse beeinträchtigen.

**Impact:** Recall bleibt funktionsfähig und fällt bei Provider-Fehlern oder
Timeouts auf die ungerankte Reihenfolge zurück. Das Problem betrifft die
Ranking-Qualität, nicht die ACL-, Speicher- oder Installationssicherheit.

**Status:** Offen — separat zu analysieren und zu beheben. Nicht durch v7.1.2
eingeführt.

---

## 4. Over-Exports in neo-arch.js / obsidian-*.js

**Beschreibung:** Mehr als 60 überflüssige Exports in `lib/neo-arch.js` und `lib/obsidian-*.js` führen zu Bundler-Warnungen und vergrößern die API-Oberfläche unnötig.

**Impact:** Reines Hygiene-Thema; keine Laufzeit-Auswirkungen.

**Status:** Offen — kein Fix-Zieldatum. Kein Produktionsrisiko.

---

## 5. ~~atomic-json.js: Reentrancy-Deadlock bei nested Updates~~ — ✅ Behoben

**Beschreibung (original):** Verschachtelte `atomicJsonUpdate`-Aufrufe auf derselben Datei konnten zu einem Deadlock führen.

**Auflösung:** `lib/atomic-json.js` wirft jetzt sofort mit `"Nested atomicJsonUpdate for same file is not allowed"` bei erkannter Reentrancy. Kein Deadlock mehr — stattdessen ein sofortiger, erklärender Fehler der die Nutzung korrigiert.

---

## 6. ~~Scope-Owner-Bindung für `scope: "user"`~~ — ✅ Behoben

**Beschreibung (original):** `user`-Scope-Records wurden teils wie private Inhalte behandelt, ohne den owner-bound Kontext explizit durch Authentifizierung/`userId` zu erzwingen.

**Auflösung:** `acl-middleware` erzwingt für `scope: "user"` den Vergleich mit `ctx.userId` (`acl.user.not_authenticated`, `acl.user.missing_owner`, `acl.user.mismatch`) und nutzt dafür die gespeicherte `ownerUserId` im Datensatz.

---

## Zusammenfassung

| Issue | Schwere | Status | Behoben in |
|-------|---------|--------|------------|
| Embedding-Cache nicht hot-verdrahtet | Mittel | ✅ Behoben | v6.2.1 |
| metricsDebounceMs hartcodiert | Niedrig | ✅ Behoben | v6.2.x |
| Reranker-Scoring-Qualität | Mittel | Offen | — |
| 60+ Over-Exports | Niedrig | Offen | — |
| atomic-json Reentrancy-Deadlock | Niedrig-Mittel | ✅ Behoben | v6.x |
| user-scope owner-bound Zugriff | Niedrig-Mittel | ✅ Behoben | v6.8.11 |

---

## Verbleibende offene Punkte / Follow-ups (Low/Info)

Die folgenden Punkte sind als unkritische Folgearbeiten identifiziert und dokumentiert:

1. **Staubiges Testverzeichnis aufräumen**: Das veraltete Testverzeichnis `plur1bus/tests/` archivieren bzw. entfernen (Entwicklung erfolgt ausschließlich unter `tests/` und `test/`).
2. **Local-only Script-Anpassung**: Das lokale Hilfsskript `.openclaw/scripts/embed-promoted-memories.mjs` auf das neue Provider-Factory-Pattern (`lib/providers/factory.js`) umstellen.
3. **Local PostToolUse Hook Warning**: Die Warnungen bezüglich des lokalen `PostToolUse`-Hooks beruhen auf einer Kimi/Claude-Lokalkonfiguration und betreffen nicht den Code des Repositories selbst.
