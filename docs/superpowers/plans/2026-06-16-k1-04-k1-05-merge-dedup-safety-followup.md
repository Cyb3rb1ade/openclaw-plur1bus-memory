# K1-04 / K1-05 Merge- und Dedup-Safety — Follow-up

## Zusammenfassung

Die lokalen Sicherheitsgurte für `memory_store` wurden in beiden aktiven Code-Pfaden
(`storeMemoryFromToolParams` für die Obsidian Bridge und das `memory_store`-Tool
selbst) verankert. Sie überschreiben LLM-Entscheidungen, wenn Fakten verloren gehen
oder wenn vektoriell ähnliche, aber inhaltlich unterschiedliche Memories als
Duplicate behandelt werden könnten.

### Implementierte Regeln

| Regel | Verhalten | Wann greift sie |
|---|---|---|
| **Safe-Duplicate-Check** (`isSafeDuplicate`) | Ablehnung als Duplicate nur, wenn Texte exakt/paraphrasiert/tech-synonymisch übereinstimmen oder sehr hohen Token-Overlap haben. | `db.findSimilar` liefert Treffer über `duplicateThreshold` |
| **Meaningful-Difference-Check** (`hasMeaningfulDifference`) | Blockiert LLM-Merge, wenn Zahlen, Versionen, Technologien/Datenbanken, Entities, Negationen oder Zeit-/Status-Marker divergieren. | `db.findMergeCandidate` liefert Kandidaten |
| **Merge-Result-Validation** (`validateMergedTextPreservesFacts`) | Verwirft LLM-`mergedText`, wenn es Fakten (Zahlen, Tech, DBs, Entities, Content-Terms) aus einer der Quellen verliert. | LLM empfiehlt `merge: true` |
| **Archiv-First** (DATA-003) | Unverändert erhalten: Original wird erst archiviert und dann gelöscht, nachdem Embedding/Archivierung erfolgreich war. | erfolgreicher Merge |

### Dateien

- `lib/memory-merge-safety.js` — reine Hilfsfunktionen (keine DB-Abhängigkeit)
- `index.js` — Guards an beiden `storeMemoryFromToolParams`-Call-Sites
- `tests/memory-merge-safety.test.js` — 33 Unit-Tests
- `tests/memory-store-dedup-safety.test.js` — 2 Integrationstests (K1-05)
- `tests/memory-store-merge-safety.test.js` — 2 Integrationstests (K1-04)

## Verifikation

```bash
npm test        # full suite passes
npm run lint    # node --check all JS files
npm audit       # 0 vulnerabilities
```

Alle neuen und bestehenden Tests sind grün, einschließlich des vorhandenen
`memory_store merge archive-first (DATA-003)`-Tests.

## Vector-DB-Dimension-Invariance-Prüfung

```text
Vector DB dimension invariance checked:
- no embedding model change
- no embedding dimension change
- no LanceDB vector schema change
- no re-embedding/migration required
```

Begründung:
- `git diff origin/main..HEAD` zeigt keine Änderungen an
  `lib/memory-db.js`, `lib/db-adapter.js`, `lib/embedding-cache.js`,
  `lib/*embedding*`, `openclaw.plugin.json`, `package.json` oder
  `package-lock.json`.
- Alle Vektoroperationen (Embedding, `MemoryDB.vectorDim`, LanceDB-Index,
  `findSimilar`, `findMergeCandidate`) wurden nicht berührt.
- Die einzigen geänderten Produktionsdateien sind `index.js` (rein textbasierte
  Guards um die bestehenden Merge-/Dedup-Checks) und `lib/memory-merge-safety.js`
  (neue, embedding-freie String-Heuristiken).

## Verbleibende Risiken und bewusste Kompromisse

1. **Heuristische Entity-Erkennung**
   - `extractEntitiesFromOriginal` erkennt Titlecase-Wörter. Um falsch-positive
     Entitäten zu reduzieren, werden deskriptive Meta-Wörter (`Original`,
     `Additional`, `Another`, `New`, `Main`, …) ignoriert.
   - **Risiko:** Echte Eigenname wie "Main Street" oder "New York" könnten
     ebenfalls ignoriert werden. Der Heuristik-Ansatz ist daher bewusst
     konservativ: im Zweifel wird separat gespeichert.

2. **Lichte Plural-Stemming**
   - Content-Terms werden per `stemContentTerm` normalisiert (`cats` → `cat`).
   - **Risiko:** Über-Stemming bei Wörtern, die auf `s` enden, aber kein Plural
     sind (z. B. `bus` bleibt erhalten wegen `ss`, aber `gas` → `ga` wäre falsch).
   Aktuell werden solche Fälle nicht explizit ausgeschlossen.

3. **Tech-Synonyme**
   - Nur `postgresql` → `postgres` und `nodejs`/`node.js` → `node` sind hart
     kodiert. Weitere Synonyme müssen bei Bedarf ergänzt werden.

4. **Reihenfolge in `findSimilar`**
   - Der Guard sucht jetzt in *allen* ähnlichen Treffern* nach einem safe
     Duplicate, nicht nur in `existing[0]`. Das verhindert, dass ein
     meaningfully-different Treffer vor einem exakten Duplicate die Entscheidung
     verfälscht.

5. **Test-Isolierung**
   - Die Dedup-Integrationstests teilen sich denselben LanceDB-Dateisystem-Zustand.
     Sie sind derzeit sequenziell und passieren, aber für zukünftige Erweiterungen
     wäre `beforeEach` mit einer frischen DB sauberer.

## Empfohlene nächste Schritte

1. **Staging-Beobachtung**
   - In einer realen Workspace-Umgebung beobachten, wie oft `memory.rejected_duplicate`
     mit Grund `meaningful_difference` und wie oft `memory.merged` mit
     `merge_safety_guard_aborted` vorkommt.
   - Metriken: Anzahl abgebrochener Merges pro Woche, Anzahl separat gespeicherter
     fast-Duplicates.

2. **Heuristiken iterativ verbessern**
   - Bei wiederkehrenden Fehlklassifikationen ENTITY_IGNORE / STOP_WORDS /
     TECH_SYNONYMS erweitern.
   - Optional: POS-Tagging oder ein kleines Lemmatisierungs-Wörterbuch für
     Deutsch/Englisch einführen, um `stemContentTerm` robust zu machen.

3. **LLM-Prompt-Anpassung**
   - Den `callMergeCheck`-Prompt anweisen, Zahlen, Versionsangaben und
     Datenbank-/Technologie-Namen niemals zu verlieren. Die lokale Validierung
     bleibt trotzdem die letzte Instanz.

4. **Konfigurierbarkeit**
   - Falls Nutzerberichte zeigen, dass die Guard zu streng oder zu locker ist,
     könnte `duplicateThreshold` bzw. ein neuer `mergeSafety` Konfig-Block die
     Parameter (`jaccardThreshold`, `ignoreList`) übersteuerbar machen.

5. **Test-Refactoring**
   - Dedup-Tests auf `beforeEach` mit isolierter DB umstellen, um zukünftige
     Flakiness zu vermeiden.

6. **Installer auf aktuellen Stand bringen** (nicht in diesem Branch)
   - Neue Config-Keys aus #49/#50/#51/K1-04-K1-05 berücksichtigen.
   - `openclaw.plugin.json` Defaults sauber in Installer übernehmen.
   - Bestehende Installationen ohne destruktive Config-Überschreibung migrieren.
   - Keine Vektor-DB-Dimensionen oder Embedding-Modelle ändern.
   - Upgrade-/Dry-Run-Test ergänzen.

## PR-Empfehlung

- Branch: `fix/memory-merge-dedup-safety-2026-06-16`
- Commits:
  1. `feat(memory): add merge safety helpers`
  2. `feat(memory): wire K1-04/K1-05 merge/dedup safety guards into store paths`
- Review-Fokus:
  - `index.js`: Sind beide Call-Sites konsistent? Bleibt DATA-003 (archive-first)
    erhalten?
  - `lib/memory-merge-safety.js`: Sind die Heuristiken verständlich und nicht
    übermäßig aggressiv?
  - Tests: Decken Unit- und Integrationstests die neuen Pfade ab?

## Schlussfolgerung

K1-04 und K1-05 sind funktional umgesetzt. Das System speichert bei Unsicherheit
separat, lässt den LLM nur bei hinreichender Faktengleichheit entscheiden und
verwirft Merge-Ergebnisse, die Fakten verlieren. Die verbleibenden Risiken sind
 dokumentiert und lassen sich durch Beobachtung und iterative Anpassung der
Heuristik-Listen adressieren.
