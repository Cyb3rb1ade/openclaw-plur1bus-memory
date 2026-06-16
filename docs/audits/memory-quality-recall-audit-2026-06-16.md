# Memory Quality & Recall Correctness Audit

**Projekt:** `/Users/cyberblade/openclaw-plur1bus-memory`  
**Branch:** `audit/memory-quality-recall-2026-06-16`  
**Datum:** 2026-06-16  
**Auditor:** Kimi Code CLI mit 8 parallelen Audit-Subagenten  
**Ausgangszustand:** `git status --short` clean, `npm test` = 1204 passing / 0 failing, `npm audit --audit-level=moderate` = 0 vulnerabilities  
**Scope:** Memory Formation, Weighting/Decay, Recall Pipeline, Graph/Association, Contradiction/Correction, Prompt Rendering, Golden-Set, Decision Trace / Explainability  

---

## 1. Executive Summary

Das Memory-System hat nach PR #48 einen soliden technischen Zustand: Tests sind grün, Audit-Status clean, bekannte Sicherheits- und Performance-Probleme wurden behoben. Die Architektur unterscheidet prinzipiell zwischen direkten Vektor-Treffern, kanonischem Wissen (`KNOWLEDGE.md`), assoziativen Graph-Treffern, Semantic-Lens-Communities, Interpretation-Overlays und Reactivation-Recall.

**Der zentrale Verdacht des Nutzers ist jedoch begründet:**

> „Die Bots nehmen momentan zu viele quere Assoziationen für bare Münze.“

Das System sammelt assoziatives Material aus vielen Quellen (Graph-Spread, Semantic Lens, CRR, Patterns, emotionale/zeitliche Nähe), aber es gibt **mehrere Stellen, an denen diese Assoziationen im Score, im Ranking und im Prompt nicht stark genug von direkten, query-relevanten Fakten getrennt werden**. Gleichzeitig fehlen harte Schutzmechanismen gegen falsche Sicherheit: keine Widerspruchserkennung auf Memory-Text-Ebene, keine valide Score-Aufschlüsselung, kein Decision-Trace und keine Budget-Trennung zwischen direkten und assoziativen Treffern in der Produktionspipeline.

**Wichtigste Risiken:**

- Assoziative Graph-Treffer können direkte Vektor-Treffer überholen und im gleichen Prompt-Block als „Fakten" präsentiert werden.
- Graph-Edges entstehen aus sehr schwachen Signalen (gleiche Emotion, 30 % Topic-Overlap, zeitliche Nähe).
- Semantic Lens und CRR reichen einzelne gemeinsame Tokens als Relevanzbeweis.
- Widersprüchliche aktive Memories werden gleichzeitig recalled, ohne markiert zu werden.
- Merge-/Deduplikations-Pfade können unterschiedliche Fakten verlieren.

Empfehlung: **Eine separate Fix-Runde ist erforderlich.** Sie sollte zuerst die Prompt-Evidence-Grenze und das Ranking assoziativer Treffer härten, dann die Graph-Edge-Qualität verbessern und schließlich Widerspruchserkennung sowie Explainability ausbauen.

---

## 2. Gesamtrisiko

| Kategorie | Bewertung |
|-----------|-----------|
| Datenintegrität (Formation/Promotion) | **Hoch** — Merge und Deduplikation können unterschiedliche Fakten zusammenführen oder verwerfen. |
| Recall-Präzision | **Hoch** — Assoziationen gelangen zu leicht in die Top-N und werden nicht klar genug als solche markiert. |
| Widerspruchskorrektheit | **Hoch** — Aktive widersprüchliche Memories können gemeinsam recalled werden. |
| Explainability / Auditierbarkeit | **Mittel-Hoch** — Keine Score-Aufschlüsselung, kein Decision-Trace, irreführende Explainability. |
| Prompt-Sicherheit / Evidence Boundary | **Hoch** — Assoziative Treffer teilen sich den Block mit direkten Fakten und verlieren oft ihre Origin-Provenance. |
| Gesamteinschätzung | **H1** — Das System ist produktionsnutzbar, aber das Risiko von Halluzinationen durch Assoziationen ist real und sollte in einer Fix-Runde adressiert werden. |

---

## 3. Wichtigste These: Werden Assoziationen als Fakten behandelt?

**Antwort: Ja, in mehreren Code-Pfaden wird assoziatives Material faktisch wie direkte Evidenz behandelt.**

Konkrete Belege:

1. **Score-Vermischung:** `lib/memory-graph.js:mergeAssociativeResults` mischt Graph-Scores mit Vektor-Scores (`0.6 * vector + 0.4 * associative` bei Überschneidung, `associatedScore * 0.85` für graph-only). Dadurch können rein assoziative Treffer in die Top-N rücken.
2. **Gleicher Prompt-Block:** `lib/relevant-memory-context.js:formatRelevantMemoriesContext` rendert graph-sourced Items im selben `<relevant-memories>`-Block wie direkte Treffer. Der Unterschied beschränkt sich auf `source="associative"` und ein `depth`-Attribut.
3. **Fehlende Faded-Markierung:** Nur `depth >= 3` erzwingt `faded="true"`. Tiefe 1–2 assoziative Treffer erscheinen ohne zusätzliche Unsicherheitsmarkierung.
4. **Verlust der Origin-Provenance:** Bei graph-sourced Items wird der ursprüngliche `source` (z. B. `dm`, `group`, `cron`) durch `source="associative"` ersetzt.
5. **ContinuityGate prüft falsches Signal:** `lib/continuity-gate.js:filterAssociativeCandidates` verwendet `item.memoryStrength` als Gate-Score, nicht die tatsächliche Assoziationsstärke (`associatedScore` / `relevanceScore`). Populäre Memories rutschen so durch, auch wenn ihre Verbindung schwach ist.
6. **Semantic Lens / CRR ohne Query-Relevanz:** `lib/semantic-lens-index.js` und `lib/conversation-reactivation-recall.js` wählen Community-Mitglieder anhand von Community-Zugehörigkeit oder einzelnem Token-Overlap, nicht anhand semantischer Ähnlichkeit zur aktuellen Query.
7. **Keine Widerspruchserkennung auf Faktenebene:** `lib/contradiction-detector.js` prüft nur Overlays, nicht direkte Memory-Texte. Zwei aktive Fakten wie „Wir nutzen Postgres" und „Wir nutzen MySQL" können gemeinsam recalled werden.

Diese Punkte zusammen führen dazu, dass der Downstream-Bot assoziative Hinweise als gleichwertige oder sogar stärkere Evidenz wahrnehmen kann.

---

## 4. Befunde K1 / H1 / M1 / L1

### K1 — Kritisch

| ID | Schwere | Datei / Funktion | Beschreibung | Beispiel / Repro | Warum schadet das Memory-Qualität? | Empfohlener Fix | Fix-Risiko | Testidee |
|----|---------|------------------|--------------|------------------|------------------------------------|-----------------|------------|----------|
| K1-01 | K1 | `lib/recall-pipeline.js` → `hydrateGraphResults`, `lib/memory-graph.js` → `traverseGraph` | Graph-only IDs werden aus der DB nachgeladen und in die finalen Ergebnisse übernommen, ohne dass der geladene Text semantisch zur Query geprüft wird. | Query „Postgres-Plan" → Graph-Spread findet über eine shared-entity-Kante eine alte MySQL-Memory-ID → Hydration lädt den Text und präsentiert ihn als assoziative Erinnerung. | Eine ID-Assoziation wird zur Inhaltsähnlichkeit verwechselt. | Nach dem Hydrate gegen den Query-Vektor re-scoren und unter Threshold verwerfen. | Mittel | Mock-Test mit Graph-Only-ID, deren hydrated Text semantisch fern liegt; erwarte Filterung. |
| K1-02 | K1 | `index.js` → `runRecallPipeline(...)`; `lib/recall-pipeline.js` | Assoziativer Recall ist unabhängig vom `continuityEngine`-Schalter aktiv: `const useAssociative = continuityEnabled ? assocCfg.enabled !== false : true;`. Wenn `continuityEngine.enabled === false`, wird assoziativer Spread trotzdem ausgeführt. | Config `{ continuityEngine: { enabled: false } }` → trotzdem landen graph-basierte Ergänzungen im Prompt. | Der Operator kann den assoziativen Pfad nicht über den Hauptschalter abschalten. | `useAssociative = assocCfg.enabled === true` (opt-in). | Mittel-Hoch | Unit-Test prüft, dass bei `continuityEngine.enabled=false` keine Graph-Traversierung stattfindet. |
| K1-03 | K1 | `lib/semantic-lens-index.js` → `selectLensMemories`, `lib/conversation-reactivation-recall.js` → `hasTokenOverlap` | Semantic Lens und Conversation Reactivation Recall wählen Memories anhand von Community-Zugehörigkeit bzw. einem einzigen gemeinsamen Token (`minOverlap = 1`). Es wird nicht geprüft, ob der Kandidat thematisch zur Query passt. | Prompt „API-Projekt" + faded Memory „Wetter-API gesehen" → wird reaktiviert, weil Token „API" übereinstimmt. | Schwache Ähnlichkeits-Proxies reichen als Relevanzbeweis. | `minOverlap` auf 2–3 signifikante Tokens erhöhen, Stopwords filtern, zusätzlich semantische Similarity prüfen. | Niedrig-Mittel | Test mit Community-Memory, die nur ein gemeinsames Allerweltswort teilt; erwarte keine Aufnahme. |
| K1-04 | K1 | `index.js` → `callMergeCheck()` / `storeMemoryFromToolParams()` | LLM-basierter Merge kann zwei thematisch ähnliche, aber inhaltlich verschiedene Memories zusammenführen. Es gibt keine harte Nachprüfung des `mergedText`. Bei Merge wird das Original gelöscht. | „Projekt Alpha: Auth-Service" und „Projekt Beta: Auth-Service" könnten zu „Projekt Alpha/Beta: Auth-Service" gemergt werden. | Zwei separate Fakten gehen verloren; Originalquelle wird zerstört. | Nach LLM-Merge semantische Konsistenzprüfung: mergedText muss beide Named Entities enthalten; Logging des Merge-Grunds. | Mittel | Test mit zwei inhaltlich verschiedenen aber oberflächlich ähnlichen Memories; erwarte `action: "stored"`. |
| K1-05 | K1 | `index.js` → `MemoryDB.findSimilar()` / `storeMemoryFromToolParams()` | `findSimilar` akzeptiert Treffer mit `score >= threshold || r.text === text`. Der Duplicate-Threshold liegt bei 0.95. Semantisch sehr ähnliche, aber inhaltlich unterschiedliche Sätze können als Duplikat verworfen werden. | „User mag React" vs. „User mag Vue" können bei bestimmten Embeddings >0.95 Score erreichen. | Korrekturen oder Nuancen gehen verloren. | Im Bereich [0.90, 0.98] zusätzlich Jaccard-/Keyword-Prüfung oder LLM-Ähnlichkeitsprüfung. | Mittel | Test mit semantisch ähnlichen aber inhaltlich gegensätzlichen Memories; erwarte, dass beide gespeichert werden. |
| K1-06 | K1 | `lib/recall-pipeline.js` → `runRecallPipeline()`, `lib/contradiction-detector.js` → `findContradictions()` | Die Pipeline filtert nur nach `status='active'`, Score und Dedup. Widersprüchliche aktive Memory-Texte („Wir nutzen Postgres" vs. „Wir nutzen MySQL") werden beide zurückgegeben. Der ContradictionDetector prüft nur Overlays. | Zwei aktive Fakten mit gegensätzlichem Text landen gemeinsam im Prompt. | Das LLM sieht zwei gegensätzliche Fakten als gleichwertige Evidenz. | Optionalen Background-Job oder Pipeline-Schritt einführen, der neue Fakten gegen existierende gleicher Kategorie prüft. | Hoch | Test, der zwei widersprüchliche fact-Memories als Konflikt erkennt. |

### H1 — Hoch

| ID | Schwere | Datei / Funktion | Beschreibung | Empfohlener Fix | Testidee |
|----|---------|------------------|--------------|-----------------|----------|
| H1-01 | H1 | `lib/memory-graph.js` → `mergeAssociativeResults()` | Graph-only Treffer erhalten `score = associatedScore * 0.85` und werden in dieselbe Score-Sortierung wie Vektor-Treffer gemischt. | Graph-Treffer separat halten oder mit klarem Rabott versehen (z. B. nie höher als der schlechteste Vektor-Treffer). | Test prüft, dass Graph-only-Treffer nie über dem höchsten Vektor-Score landen. |
| H1-02 | H1 | `lib/memory-graph.js` → `mergeAssociativeResults()` | Wenn ein Eintrag sowohl Vector- als auch Graph-Treffer ist, wird der Score mit `0.6 * existing + 0.4 * assocScore` neu berechnet. Schwache Vektor-Treffer können so künstlich hochgezogen werden. | Bei Überschneidung Score nicht erhöhen; Herkunft transparent machen (`source="vector+associative"`). | Test mit vector 0.3 + assoc 0.45 → Score darf nicht über 0.30 steigen. |
| H1-03 | H1 | `lib/memory-graph.js` → `traverseGraph()` | `maxDepth: 3`, `minCumulativeRelevance: 0.2`, `maxNeighborsPerNode: 8`. Tiefe-3-Hops mit moderaten Kanten landen im Ergebnis. | `maxDepth` auf 2 reduzieren oder `minCumulativeRelevance` pro Tiefe anheben. | Test, der einen 3-Hop-Treffer unter einem festen Threshold hält. |
| H1-04 | H1 | `lib/memory-graph.js` → `buildEdgesForSession()` | Graph-Edges werden aus schwachen Signalen gebildet: emotional (gleiche `emotionalDominant`), entity (30 % Topic-Overlap), temporal (innerhalb 30 Minuten). | Emotionale/zeitliche Edges nur bei zusätzlichem inhaltlichem Overlap; Entity-Threshold erhöhen. | Unit-Test mit zwei gleich-emotionalen aber thematisch unterschiedlichen Memories; erwarte keine starke Edge. |
| H1-05 | H1 | `lib/continuity-gate.js` → `filterAssociativeCandidates()` | Der Gate-Score ist `item.memoryStrength ?? 1.0`, nicht die tatsächliche Assoziationsstärke. | `relevanceScore` / `associatedScore` als Gate-Score verwenden. | Test mit `memoryStrength=1.0` aber niedrigem `relevanceScore`; erwarte Blockierung. |
| H1-06 | H1 | `lib/recall-budget.js` → `allocateMemoryTiers()`; `index.js` | `allocateMemoryTiers` existiert (inkl. 30 % Cap für associative Memories), wird aber in der Produktionspipeline nicht verwendet. | `allocateMemoryTiers` in den Hauptfluss integrieren; `runRecallPipeline` liefert getrennte Tiers zurück. | Integrationstest: Bei 12 Plätzen sollen maximal 3–4 assoziative Items im Prompt landen. |
| H1-07 | H1 | `lib/recall-pipeline.js` → `runRecallPipeline()` | Vektor-Score, Importance-Boost, Emotional-Boost und Strength-Boost werden multiplikativ kombiniert. Hoch-wichtige oder emotional passende Assoziationen können semantisch bessere Treffer überholen. | Additive/log-sum-exp-Kombination oder Begrenzung der Boosts; nur bei hoher Vektor-Ähnlichkeit anwenden. | Golden-Set-Test: thematisch passendes Memory darf nicht durch importance/emotion überholt werden. |
| H1-08 | H1 | `lib/relevant-memory-context.js` → `formatRelevantMemoriesContext()` | Graph-sourced Items verlieren ihren Origin-Source (`dm`, `group`, `cron`) und erscheinen nur als `source="associative"`. | Origin-Source beibehalten und assoziativen Charakter separat markieren (`graph-source="associative"`). | Test, der `source="group"` UND `graph-source="associative"` im Output erwartet. |
| H1-09 | H1 | `lib/relevant-memory-context.js` → `formatRelevantMemoriesContext()` | Nur `depth >= 3` erzwingt `faded="true"`. Tiefe 1–2 Assoziationen werden nicht als unsicher markiert. | Bereits ab `depth >= 1` oder `depth >= 2` für graph-sourced Items faded markieren. | Test erwartet `faded="true"` für `depth=2` graph-sourced Memory. |
| H1-10 | H1 | `lib/overlay-generator.js` → `generate()`; `index.js` → `autoCreateOverlays` | Auto-Overlays werden auch für graph-sourced / associative Memories generiert und persistiert. | Auto-Overlays nur für Vector-Quellen aktivieren; `confidenceThreshold` auf ≥0.7 anheben. | Test, dass `OverlayGenerator.generate` für `graphSource: "graph"` `null` zurückgibt. |
| H1-11 | H1 | `lib/query-refiner.js` → `refineQuery()` | Wenn die erste Suche schlechte Ergebnisse liefert, wird die Query mit Keywords aus dem Top-Result angereichert. Das kann die Suche in Richtung eines zufälligen schwachen Treffers verzerren. | Refinement nur auslösen, wenn Top-Result über einem Quality-Threshold liegt und semantisch zur Original-Query passt. | Test mit absichtlich irrelevantem Top-Result; Refinement darf nicht stattfinden. |
| H1-12 | H1 | `lib/explainability.js` → `explainResult`; `index.js` → `explainResults()` | `--explain` wird ohne `componentsFn` aufgerufen; Explainability zeigt 100 % „semantische Ähnlichkeit", obwohl Boosts das Ranking verändert haben. | `runRecallPipeline` liefert pro Result ein `scoreBreakdown`; `explainResults` übergibt dieses. | Test prüft, dass Importance-Boost und Reranker nicht-triviale Prozente zeigen. |
| H1-13 | H1 | `lib/recall-pipeline.js`, `index.js` | Es gibt keine strukturierte Decision-Trace-Datenstruktur pro Recall. Zusammensetzung aus Vector-Similarity, Boosts, Graph-Spread, Reranker, Overlays etc. ist nirgends pro Memory aufgezeichnet. | `RecallDecisionTrace`-Objekt einführen, das jede Stufe dokumentiert. | Test prüft, dass `runRecallPipeline` mit `trace: true` alle Stufen liefert. |
| H1-14 | H1 | `lib/pattern-surface.js` → `computePatternScore()` | Große Patterns können durch 2–3 zufällige Overlaps mit einer kleinen Recall-Menge einen hohen Score erreichen. | Mindestgröße für `memberIds`, Mindestanteil aktiver Member, Bestrafung nicht-overlappender Member. | Test mit großem Pattern und kleinem Candidate-Set; erwarte Blockade. |

### M1 — Mittel

| ID | Schwere | Datei / Funktion | Beschreibung | Empfohlener Fix | Testidee |
|----|---------|------------------|--------------|-----------------|----------|
| M1-01 | M1 | `lib/categorize.js` → `categorizeMemory()` | `fact`-Kategorie wird durch sehr schwaches Regex (`is |are |was |were |has |have |\d{4}`) getriggert. Fast jeder englische Satz wird als Fakt klassifiziert. | `fact` nur auf konkrete Muster prüfen oder LLM-basierte Kategorisierung mit Confidence-Threshold. | Golden-Set-Test mit 50 Sätzen und erwarteten Kategorien. |
| M1-02 | M1 | `index.js` → `storeMemoryFromToolParams()` | `importance` wird unvalidiert vom Caller übernommen; Werte außerhalb [0,1] oder absichtlich hohe Werte werden gespeichert. | Clamp auf [0,1]; Logging/Flagging bei Werten >0.9 ohne Evidence. | Test mit `importance: 1.5` und `-0.2`; erwarte Clamping. |
| M1-03 | M1 | `lib/memory-dynamics.js` → `computeCoreMemoryScore()` | Core-Memory erfordert `emotionalIntensity >= 0.95`. Wichtige, aber emotionslose technische Fakten erreichen keinen Core-Status. | Core-Kriterien um Provenance-Qualität ergänzen; emotionalen Anteil senken. | Test, der bestätigtes, mehrfach abgerufenes Faktum als Core-Kandidaten erwartet. |
| M1-04 | M1 | `lib/memory-dynamics.js` → `resolveHalfLifeDays()` | Halbwertszeit wird nur nach `category` / `memoryClass` bestimmt. Graph-/Lens-Quellen haben keinen Einfluss. | `sourceReliability` einführen; schwache Quellen kürzere Halbwertszeit. | Test prüft `applyDynamicsDefaults` mit `sourceReliability: 0.5`. |
| M1-05 | M1 | `lib/retroactive-interference.js` → `applyRetroactiveInterference()` | Default-Multiplier 0.9 schwächt auch kompatible ähnliche Memories ab. | Nur widersprechende oder redundant identische Memories abschwächen. | Test mit kompatiblen Memories; erwarte keine Schwächung. |
| M1-06 | M1 | `lib/feedback-log.js` → `recordFeedback()` | Positives Feedback verstärkt auch ungenaue Assoziationen; Negatives Feedback schwächt nur um 20 %. | Feedback mit Abrufart speichern; positive Verstärkung nur bei Vector/Score-Threshold. | Test prüft unterschiedliche Verstärkung bei Graph- vs. Vector-Quelle. |
| M1-07 | M1 | `lib/filter-parser.js` → `buildWhereClause()` | `minimportance` wird auf `memoryStrength` gemappt, nicht auf `importance`. | `minimportance` auf Spalte `importance` mappen oder UI-Alias trennen. | `buildWhereClause({ minimportance: 0.7 })` → `importance >= 0.7`. |
| M1-08 | M1 | `lib/memory-graph.js` → `buildEdgesForSession()` | Semantic-Edge-Threshold 0.78 ist niedrig; viele thematisch ähnliche aber inhaltlich unterschiedliche Memories werden verbunden. | Threshold auf 0.82–0.85 erhöhen oder Edge-Stärke-Kurve flacher gestalten. | Test, der zwei thematisch ähnliche aber inhaltlich verschiedene Sätze ohne Edge erwartet. |
| M1-09 | M1 | `lib/memory-graph.js` → `buildEdgesForSession()` | Entity-Edges bei 30 % Topic-Überlappung; generische Begriffe erzeugen falsche Verbindungen. | Threshold auf ≥0.5; Mindest-Overlap ≥2; Stopwords/Hub-Wörter filtern. | Test mit zwei Sätzen, die nur generische Wörter teilen; erwarte keine Edge. |
| M1-10 | M1 | `lib/memory-graph.js` → `traverseGraph()` | Jeder Nachfolger erbt den Seed-Score; der Pfad-Score drückt nicht die lokale Evidenz aus. | Pfad-Score nur von `cumulativeRelevance` und `depthPenalty` abhängig machen. | Test mit Seed-Score-Variationen bei gleichem Graph. |
| M1-11 | M1 | `lib/contradiction-detector.js` → `_askLLM()` | Contradiction-LLM-Prompt enthält nur die beiden `shiftDescription`-Texte, nicht den Original-Memory-Text. | Original-Memory-Text und `triggerContext` in den Prompt einbauen. | Test mit kompatiblen Bedeutungsverschiebungen; erwarte `false`. |
| M1-12 | M1 | `lib/interpretation-overlay.js` → `loadForTargets()` | Pro Target wird nur das neueste Overlay gerendert; Alternativen werden unterdrückt. | Mehrere aktive Overlays pro Target rendern oder Anzahl reflektieren. | Test mit zwei aktiven Overlays für dieselbe Memory. |
| M1-13 | M1 | `lib/overlay-generator.js` → `generate()` | Overlay-`confidence` kommt direkt aus der LLM-Antwort ohne externe Validierung. | Confidence durch Signal-Stärke und Evidence-Faktor modulieren. | Test mit hohem LLM-Confidence bei schwachem Trigger; erwarte reduzierte Confidence. |
| M1-14 | M1 | `lib/semantic-lens-index.js`, `lib/relevant-memory-context.js` | Semantic-Lens-Memories haben keine Faded-/Confidence-Markierung. | Lens-Items mit `faded="true"` und `source="semantic-lens"` markieren. | Test mit faded Lens-Memory. |
| M1-15 | M1 | `lib/emotional-state.js` → `computeRecallBoost()` | Emotionaler Boost kann inhaltlich irrelevante Memories hochziehen. | MoodBoost nur als Tie-Breaker bei nahezu gleichen Vector-Scores verwenden. | Test: emotional passende aber inhaltlich irrelevante Memory darf nicht überholen. |
| M1-16 | M1 | `index.js` → Auto-Capture | Auto-Capture-Memories erhalten automatisch `importance: 0.7` und bekommen damit fast den vollen Boost. | Auto-Capture-Importance auf 0.5 oder kategorieabhängig setzen. | Test: conversation Auto-Capture hat niedrigere importance. |
| M1-17 | M1 | `lib/meta-cognition.js` → `extractTopics()` / `updateBehaviorCards()` | Topics werden frequenzbasiert extrahiert; generische Wörter führen zu `open_question`-Karten. | TF-IDF oder Domain-Stopwords; Karten nur bei echtem Gap. | Test mit generischem gemeinsamen Wort; erwarte keine open_question-Karte. |
| M1-18 | M1 | `lib/meta-cognition.js` → `computeRecallMetrics()` | `precision` / `recall` / `f1` sind semantisch irreführend. | Klare Trennung: satisfactionRate, dissatisfactionRate, precision. | Test mit gemischtem Feedback prüft getrennte Metriken. |
| M1-19 | M1 | `lib/memory-context-sanitize.js` | `DISPLAY_SOURCES` enthält nicht `"dm"`; häufigste Quelle fällt auf `"memory"` zurück. | `"dm"` zu `DISPLAY_SOURCES` hinzufügen. | Test mit `source: "dm"` erwartet `source="dm"`. |
| M1-20 | M1 | `lib/relevant-memory-context.js` → `formatRelevantMemoriesContext()` | Numerische `memoryStrength` wird nicht exponiert; nur binäre `faded`-Labels. | `memory-strength`-Attribut rendern. | Test prüft `memory-strength="0.34"`. |

### L1 — Niedrig

| ID | Schwere | Datei / Funktion | Beschreibung | Empfohlener Fix | Testidee |
|----|---------|------------------|--------------|-----------------|----------|
| L1-01 | L1 | `index.js` → `findBestPattern()` | Pattern-Surfacing wird mit `patternRecords: []` aufgerufen; Codepfad ist inaktiv. | Pattern-Store anbinden oder Logik/Config klarstellen. | Test, dass bei `patternRecords: []` kein `<memory-continuity>` Block ausgegeben wird. |
| L1-02 | L1 | `lib/relevant-memory-context.js` | `RECALL SAFETY`-Preamble ist generisch und erwähnt assoziative Treffer nicht explizit. | Preamble ergänzen, wenn assoziative/Lens-Items vorhanden sind. | Snapshot-Test des Prompt-Blocks. |
| L1-03 | L1 | `lib/pattern-surface.js` → `formatPatternBlock()` | Pattern-Block verwendet numerische `confidence`, die als Fakten-Score missverstanden werden kann. | Confidence in Vertrauensbereich übersetzen oder Text konsistent als Hypothese formulieren. | Test prüft, dass keine misleading numerische confidence erscheint. |
| L1-04 | L1 | `lib/conversation-reactivation-recall.js` → `formatReactivationContext()` | Reactivation-Memories verlieren ihren ursprünglichen Auslöser (graph-bridge vs. open-project). | Ursprünglichen `source` beibehalten und `reactivation="true"` markieren. | Test prüft `source="graph-bridge"` im CRR-Output. |
| L1-05 | L1 | `lib/explainability.js` → `explainResult()` | Komponenten unterschiedlicher Skalen werden addiert; Prozentsätze sind irreführend. | Komponenten vor Aggregation auf [0,1] normalisieren oder separate Breakdowns liefern. | Test prüft interpretierbare Prozentsätze. |
| L1-06 | L1 | `lib/obsidian/provenance-graph.js` → `buildProvenanceGraph()` | Provenance-Graph ist reiner Spiegel mit festem `risk: "low"`. | Risiko abhängig von Herkunft, Quellenanzahl und Kontradiktionsstatus berechnen. | Provenance-Eintrag für assoziativ abgeleiteten Record hat höheres Risiko. |
| L1-07 | L1 | `lib/relevant-memory-context.js` → `resolveFadedThreshold()` | Faded-Threshold 0.25 ist willkürlich und nicht kategorieabhängig. | Kategorieabhängige Thresholds erlauben. | person-Memory mit strength 0.3 wird nicht als faded markiert. |
| L1-08 | L1 | `lib/memory-dynamics.js` → `createRetrievalLedgerEntry()` | Ledger speichert keine Auswahlgründe / Quellen-Aufschlüsselung. | `sourceCounts`, `graphDepths` erweitern. | Ledger-Eintrag enthält Quellen-Aufschlüsselung. |

---

## 5. Memory Formation Bewertung

**Gesamtnote: M1-H1**

Das System hat gute Grundlagen: Memories werden mit `source`, `origin`, `category`, `scope`, `confidence`, `importance`, `memoryStrength`, `contentHash` und Provenance-Feldern gespeichert. Correction/Update erzeugt neue Versionen und markiert alte als `superseded`, statt sie blind zu überschreiben.

**Schwächen:**

- **Kategorisierung ist zu grob:** `lib/categorize.js` triggert `fact` durch sehr schwache Regex-Muster. Belanglose Gesprächsfetzen können als Fakten kategorisiert werden und erhalten damit andere Halbwertszeiten und Promotion-Eligibility.
- **Importance unvalidiert:** `storeMemoryFromToolParams` übernimmt `params.importance` ohne Range-Check. Agenten oder Fehler können beliebige Inhalte nach oben schieben.
- **Merge- und Deduplikationsrisiken:** Der LLM-basierte Merge (`callMergeCheck`) kann zwei unterschiedliche Fakten zusammenführen und das Original löschen. Der Duplicate-Threshold 0.95 kann semantisch ähnliche, aber inhaltlich unterschiedliche Fakten verwerfen.
- **Core-Memory zu emotionslastig:** Core-Status erfordert `emotionalIntensity >= 0.95`. Wichtige, aber emotionslose technische Fakten werden nicht geschützt.
- **Auto-Capture Bias:** Automatisch erfasste Memories bekommen `importance: 0.7` und werden systematisch gehoben.

**Empfohlene Maßnahmen:**

1. `categorizeMemory` mit einem 50-Satz-Golden-Set neu kalibrieren.
2. `importance` auf [0,1] clammen und hohe Werte loggen.
3. Merge-Nachprüfung einführen (semantische Konsistenz, beide Named Entities im `mergedText`).
4. Duplicate-Check im Bereich 0.90–0.98 mit Jaccard/Keyword erweitern.
5. Core-Memory-Kriterien um Provenance-Qualität ergänzen.

---

## 6. Weighting / Decay / Reinforcement Bewertung

**Gesamtnote: H1**

Die klassische Dynamics-Implementierung (exponentieller Decay, Half-Life-Mapping, Faded-Recall-Markierung) ist sauber und gut getestet. Die Probleme liegen in der **Gewichtungs-Kaskade** und im **Feedback-Loop**.

**Schwächen:**

- **Importance-/Strength-Boosts gelten gleichermaßen für assoziative Treffer:** In `runRecallPipeline` werden `score *= 1 + importance * boost` und `score *= 0.65 + 0.35 * memoryStrength` auf **alle** Results angewendet, inklusive graph-sourced assoziativer Treffer. Das hebt assoziative Treffer mit hoher `importance` oder `memoryStrength` in die oberen Ränge.
- **Retrieval Reinforcement verstärkt jede Abrufung gleich:** `applyRetrievalReinforcement` gibt jedem recalled Memory denselben Boost, unabhängig davon, ob es Vektor-, Graph-, Lens- oder Pattern-sourced war. Assoziationen werden dadurch iterativ stärker.
- **Feedback-Log verstärkt Assoziationen:** Positives Feedback ruft `applyRetrievalReinforcement` auf, ohne die Abrufart zu prüfen.
- **Retroactive Interference ist zu schwach und untrennbar:** Der Default-Multiplier 0.9 schwächt auch kompatible ähnliche Memories ab; widersprüchliche Informationen werden nicht ausreichend gedämpft.
- **Half-Life kennt keine Quellenverlässlichkeit:** `resolveHalfLifeDays` hängt nur von `category` / `memoryClass` ab. „Hörensagen"-Memories überleben zu lange.

**Empfohlene Maßnahmen:**

1. Für `source === "graph"` Boosts reduzieren oder separat kappen.
2. Retrieval-Reinforcement nach `source` und `score` gewichten.
3. `sourceReliability` einführen und in Half-Life einfließen lassen.
4. Retroactive Interference nur bei erkannter Widersprüchlichkeit oder hoher Similarity anwenden.

---

## 7. Recall Pipeline Bewertung

**Gesamtnote: H1**

Die Pipeline ist funktional vollständig (Embedding → Vector Search → Boosts → Reranker → Graph Spread → Dedup → Canonical → Budget/Trim → Compression → Prompt). Die Architektur ist dokumentiert. Allerdings gibt es **Lücken in der Trennung von direkten und assoziativen Treffern** und im Schutz gegen schlechte Top-Results.

**Schwächen:**

- **Graph-Only-Hydration ohne Query-Revalidierung:** `hydrateGraphResults` lädt graph-only IDs nach und prüft nur `status === 'active'`, nicht die semantische Passung zur Query.
- **Budget-Modell nicht verwendet:** `lib/recall-budget.js:allocateMemoryTiers` existiert, wird aber in `index.js` nicht aufgerufen. Stattdessen liefert `runRecallPipeline` bis zu 40 graph-only Kandidaten, bevor ein nachträgliches Gate greift.
- **Query Refiner verstärkt schlechte Top-Results:** `refineQuery` nimmt Keywords aus dem Top-Result, auch wenn dieses unter `recallMinScore` liegt.
- **Reranker sieht nicht, ob Kandidat assoziativ ist:** Der Reranker arbeitet auf Text-Summaries und hat keinen Zugriff auf `source`, `depth` oder den ursprünglichen Vector-Score.
- **Emotionaler Boost kann Relevanz überlagern:** `emotionalState.computeRecallBoost` multipliziert den Score; bei nahen Vector-Scores kann Stimmung inhaltlich bessere Treffer überholen.
- **Dedup erkennt keine semantischen Widersprüche:** `dedupResults` basiert auf Jaccard-Ähnlichkeit; gegensätzliche Sätze mit unterschiedlichen Wörtern überleben beide.

**Empfohlene Maßnahmen:**

1. Graph-only Kandidaten nach Hydration auf Query-Relevanz prüfen.
2. `allocateMemoryTiers` in den Hauptfluss integrieren.
3. Query-Refinement nur bei qualitativ guten Top-Results auslösen.
4. Reranker-Input um Herkunftskennzeichnung erweitern oder Reranker nur auf Vector-Pool anwenden.
5. Emotionalen Boost begrenzen oder als Tie-Breaker nutzen.

---

## 8. Graph / Association Bewertung

**Gesamtnote: H1**

Der Memory-Graph ist der Hauptverdächtige für „quere Assoziationen als Fakten". Die Edge-Generierung ist zu großzügig, die Traversierung zu tief und die Score-Propagation zu stark.

**Schwächen:**

- **Edge-Typen werden nicht differenziert gewichtet:** `traverseGraph` verwendet nur `edge.strength`, nicht den `type`. Eine emotionale Kante mit Stärke 0.6 wird wie eine semantische Kante mit Stärke 0.6 behandelt.
- **Emotionale Edges verbinden inhaltlich Unabhängiges:** Zwei Memories mit gleicher `emotionalDominant`-Emotion bekommen eine Kante, unabhängig vom Inhalt.
- **Entity-Edges bei 30 % Topic-Overlap:** Generische Begriffe wie „Projekt", „API", „Meeting" erzeugen Verbindungen zwischen inhaltlich verschiedenen Dingen.
- **Zeitliche Edges zu stark:** `temporalStrength(deltaMinutes) = Math.exp(-deltaMinutes / 15) * 0.7`. Innerhalb von 15 Minuten entsteht fast eine 0.7-Kante, nach 30 Minuten noch ~0.35. Zeitliche Nähe wird als starke Assoziation kodiert.
- **Semantic-Edge-Threshold 0.78 zu niedrig:** Viele oberflächlich ähnliche Memories werden verbunden.
- **Tiefe-3-Hops erlaubt:** `maxDepth: 3` und `minCumulativeRelevance: 0.2` erlauben weit entfernte Assoziationen.
- **Score-Propagation:** Der Seed-Score wird in die Tiefe getragen; der Pfad-Score drückt nicht die lokale Evidenz aus.
- **Semantic-Link-Discovery im Obsidian-Bridge-Kontext:** Verwendet Vektorähnlichkeit ≥ 0.78 ohne Qualitätsprüfung; kontradiktorische Fakten können als „verwandt" verlinkt werden.

**Empfohlene Maßnahmen:**

1. Type-weight-Faktor einführen (semantic=1.0, entity=0.8, temporal=0.5, emotional=0.4, episode=0.6).
2. Emotionale/zeitliche Edges nur bei zusätzlichem inhaltlichem Overlap erzeugen.
3. Entity-Threshold auf ≥0.5 erhöhen und Mindest-Overlap ≥2 fordern.
4. `maxDepth` auf 2 reduzieren oder `minCumulativeRelevance` pro Tiefe anheben.
5. Pfad-Score stärker von Kantenstärken und Tiefe abhängig machen.

---

## 9. Correction / Contradiction Bewertung

**Gesamtnote: M1-H1**

Das Overlay-System ist architektonisch gut durchdacht: Overlays sind append-only, haben Confidence, können `superseded`, `provisional` oder `disabled` sein, und Korrekturen erzeugen neue Versionen statt alte zu überschreiben. Der Grundsatz „Never rewrite the past. Revise the meaning of the past." ist im Code erkennbar.

**Schwächen:**

- **Keine Widerspruchserkennung auf Memory-Text-Ebene:** Der `ContradictionDetector` prüft nur `shiftType === "meaning"`-Overlays. Direkte Widersprüche zwischen aktiven Fakten-Memories bleiben unentdeckt.
- **Contradiction-LLM-Prompt ohne Original-Kontext:** `_askLLM` enthält nur die beiden `shiftDescription`-Texte, nicht den Original-Memory-Text. Falsch positive Widersprüche sind wahrscheinlich.
- **Auto-Overlays auf assoziativen Memories:** `autoCreateOnRecall` generiert Overlays auch für graph-sourced Items. Assoziationen werden so zu persistierten Interpretationen.
- **Nur neuestes Overlay pro Target:** `loadForTargets` rendert nur das neueste aktive Overlay; Alternativen und Unsicherheit werden unterdrückt.
- **Overlay-Confidence nicht extern validiert:** Die LLM-Confidence wird direkt übernommen, ohne durch Signal-Stärke oder Evidenz zu modulieren.
- **Auto-Overlay-Trigger zu empfindlich:** Wörter wie `now`, `mittlerweile`, `nicht mehr` lösen bereits Overlay-Generierung aus, auch wenn sie nicht zur Memory gehören.

**Empfohlene Maßnahmen:**

1. ContradictionDetector um Memory-Text-Modus erweitern.
2. Original-Memory-Text in den Contradiction-LLM-Prompt aufnehmen.
3. Auto-Overlays nur für Vector-Quellen erlauben und `confidenceThreshold` anheben.
4. Mehrere aktive Overlays pro Target rendern.
5. Confidence durch Signal-Stärke modulieren.

---

## 10. Prompt Rendering / Evidence Boundary Bewertung

**Gesamtnote: H1**

Der Prompt enthält eine `RECALL SAFETY`-Preamble und trennt prinzipiell zwischen `<relevant-memories>`, `<memory-semantic-lens>`, `<memory-continuity>` und `<memory-reactivation>`. Die Trennung ist jedoch für das LLM nicht stark genug.

**Schwächen:**

- **Graph-sourced Items verlieren Origin-Source:** `source="associative"` ersetzt den ursprünglichen Ursprung.
- **Keine Relevanz-Score-Exposition:** Der finale Score oder die Assoziationsstärke werden nicht gerendert. Der Bot kann Evidenzstärke nicht kalibrieren.
- **Tiefe 1–2 nicht als faded markiert:** Nur `depth >= 3` erzwingt `faded="true"`.
- **Semantic-Lens-Block ohne `untrusted`-Markierung:** Der Block steht außerhalb von `<relevant-memories>`, hat aber keine `mode="associative-hint-only"` oder `untrusted="true"`.
- **Pattern-Block nutzt numerische Confidence:** Hohe Zahlen können trotz Humility-Language als Fakten-Score missverstanden werden.
- **CRR-Block verliert Original-Source:** Reactivation-Memories erscheinen alle als `source="reactivation"`.
- **RECALL SAFETY Preamble widerspricht sich:** Sie betont Provenance, aber graph-sourced Items verlieren genau diese Provenance.

**Empfohlene Maßnahmen:**

1. Origin-Source beibehalten und `graph-source="associative"` ergänzen.
2. `association-strength` oder `relevance-score` als Attribut rendern.
3. Bereits ab `depth >= 1` / `depth >= 2` für graph-sourced Items `faded="true"` setzen.
4. Semantic-Lens-Block mit `untrusted="true"` und stärkerer Präambel versehen.
5. Pattern-Confidence in Vertrauensbereiche übersetzen.
6. Preamble ergänzen, wenn assoziative Items vorhanden sind.

---

## 11. Golden-Set-Ergebnisse

### 11.1 Bestehende Golden-Set-Tests

`tests/recall-golden-set.test.js` deckt ab:

- Tokenisierung bewahrt Akronyme.
- `computeDecayedStrength` korrekt für `person`, `project`, `general`, `core`.
- `dedupResults` lässt ähnliche Projekt-Memories bei Threshold 0.78 durch.
- `generateSummary` respektiert Satzgrenzen.

**Ergebnis:** Alle bestehenden Golden-Set-Tests passen.

### 11.2 Lücken im Golden-Set

Das bestehende Golden-Set deckt **nicht** ab:

- Kategorisierungsfehler (`categorizeMemory`).
- Importance-Validation.
- Merge-Safety.
- Assoziationen vs. Fakten im Prompt.
- Tiefe-Abstrafung von Graph-Treffern.
- Widerspruchserkennung auf Memory-Text-Ebene.
- Importance-/Emotion-Boost-Verzerrung.

### 11.3 Vorgeschlagene neue Behavioral Test Cases (mindestens 20)

#### A — Direkte User-Facts

| ID | Query / Input | Erwartete Memories | Unerwartete Memories | Urteil |
|----|---------------|--------------------|----------------------|--------|
| A-01 | „Welche DB nutzen wir?" mit aktivem Memory „Wir nutzen MySQL statt Postgres" und überschriebenem „Wir nutzen Postgres" | Nur aktives Memory | Altes superseded Memory | PASS/WARN |
| A-02 | „Wie heißt der User?" mit person-Memory nach 200 Tagen | Memory bleibt >0.85 strength | — | PASS |
| A-03 | Tokenisierung von „AI API GPU CUDA machine learning project" | ai, api, gpu, cuda erhalten | — | PASS |
| A-04 | Fakt vs. Preference Decay | preference verfällt langsamer als conversation | — | PASS |

#### B — Kreative Inhalte

| ID | Query / Input | Erwartete Memories | Unerwartete Memories | Urteil |
|----|---------------|--------------------|----------------------|--------|
| B-01 | „Erzähl mir etwas über Drachen" | Drachen-Roman-Memory vor User-Preference „mag kurze Antworten" | Preference dominiert | WARN |
| B-02 | Einmaliges Brainstorming „Wir planen eine Raumstation aus Käse" | Wird nicht als dauerhafte User-Preference gespeichert | Wird als fact/preference gespeichert | FAIL |
| B-03 | Kreativer Inhalt mit category=conversation | Niedrigere Importance-Defaults | Hoher Default-Importance | WARN |

#### C — Korrekturen

| ID | Query / Input | Erwartete Memories | Unerwartete Memories | Urteil |
|----|---------------|--------------------|----------------------|--------|
| C-01 | `updateCard` von „Postgres" zu „MySQL" | Neue Version aktiv, alte superseded | Beide aktiv | PASS/WARN |
| C-02 | Zwei aktive Memories „Wir nutzen Postgres" vs. „Wir nutzen MySQL" | Nur aktuellste / Markierung als widersprüchlich | Beide unmarkiert | FAIL |
| C-03 | `InterpretationOverlay` für ein Memory | Overlay wird als Overlay gerendert | Overlay ersetzt Original-Fakt | PASS |

#### D — Assoziative Fallen

| ID | Query / Input | Erwartete Memories | Unerwartete Memories | Urteil |
|----|---------------|--------------------|----------------------|--------|
| D-01 | „Wie soll ich antworten?" mit Graph-Edge zu „Gestern hat es geregnet" | Antwort-Preference | Wetter-Memory | FAIL |
| D-02 | Zwei gleich-emotionale aber thematisch unterschiedliche Memories | Keine emotionale Edge / kein Recall | Beide verbunden | WARN |
| D-03 | Tiefe-3-Graph-Assoziation | Nicht in Top-N | In Top-N | FAIL |
| D-04 | Semantic-Lens-Community mit irrelevanter Bridge-Memory | Bridge-Memory nicht ausgewählt | Bridge-Memory ausgewählt | FAIL |
| D-05 | `filterAssociativeCandidates` mit hoher memoryStrength aber geringer Relevanz | Blockiert | Durchgelassen | FAIL |

#### E — Zeit / Staleness

| ID | Query / Input | Erwartete Memories | Unerwartete Memories | Urteil |
|----|---------------|--------------------|----------------------|--------|
| E-01 | person-Memory nach 100 Tagen | strength > 0.88 | strength ≤ 0.88 | PASS |
| E-02 | general-Memory nach 100 Tagen | strength < 0.5 | strength ≥ 0.5 | PASS |
| E-03 | Memory mit strength < fadedThreshold | `faded="true"` | Kein faded | PASS |
| E-04 | Graph-sourced Memory Tiefe ≥3 | `faded="true"` | Kein faded | PASS |
| E-05 | Memory ohne `halfLifeDays` bei person-ähnlichem Text | Nicht stillschweigend 30 Tage | 30 Tage default | WARN |

**Zusammenfassung der erwarteten Ergebnisse:** Mindestens 7 der 20 Fälle würden voraussichtlich **FAIL** oder **WARN** ergeben, wenn sie heute implementiert würden. Das bestätigt die Notwendigkeit einer Fix-Runde.

---

## 12. Entscheidungsweg-/Trace-Bewertung

**Gesamtnote: H1**

Das System hat praktisch **keine strukturierte Decision-Trace-Datenstruktur**. Die finale Memory-Auswahl setzt sich aus vielen Stufen zusammen, aber pro Turn ist nirgends dokumentiert, warum eine bestimmte Memory gewählt wurde.

**Schwächen:**

- `explainResult` summiert unterschiedlich skalierte Komponenten (`vectorSimilarity + importanceBoost + rerankScore + temporalBoost`), was irreführende Prozentsätze ergibt.
- `--explain` wird in `index.js` ohne `componentsFn` aufgerufen, sodass immer 100 % „semantische Ähnlichkeit" angezeigt werden.
- `explainability.js` kennt keine assoziative Komponente (`graphDepth`, `semanticLens`, `associativeScore`).
- Das Retrieval-Ledger speichert nur `queryHash`, `selectedIds`, `resultsCount`, aber keine Quellen-Aufschlüsselung.
- Es gibt keinen `recallTrace` / `memoryDecisionTrace`, der pro Memory dokumentiert: baseSimilarity, keywordBoost, categoryBoost, recencyBoost, strengthBoost, graphBoost, correctionPenalty/Boost, contradictionPenalty, finalScore, reasonLabels.

**Empfohlene Maßnahmen:**

1. `runRecallPipeline` liefert pro Result ein `scoreBreakdown` (vectorScore, importanceBoost, rerankScore, temporalBoost, strengthBoost, emotionalBoost, graphBoost).
2. Optionaler `trace: true`-Modus schreibt ein strukturiertes `RecallDecisionTrace`-Objekt.
3. `explainability.js` um assoziative Komponenten erweitern.
4. Retrieval-Ledger um `sourceCounts`, `graphDepths`, `overlayTriggers` erweitern.

---

## 13. Konkrete Fix-Reihenfolge

### P0 — Sofort (kritisch, niedriges Risiko)

1. **Assoziative Treffer im Prompt klarer abgrenzen:**
   - Origin-Source beibehalten (`graph-source="associative"`).
   - Bereits ab `depth >= 1` `faded="true"` für graph-sourced Items.
   - `association-strength` Attribut rendern.
2. **ContinuityGate auf assoziative Relevanz umstellen:** `filterAssociativeCandidates` verwendet `relevanceScore` / `associatedScore`, nicht `memoryStrength`.
3. **Assoziativen Recall auf Opt-in umstellen:** `useAssociative = assocCfg.enabled === true` statt implizitem Default-on.
4. **Semantic Lens / CRR `minOverlap` erhöhen:** Mindestens 2–3 signifikante Tokens, Stopwords filtern.

### P1 — Kurzfristig (hoher Impact, mittleres Risiko)

5. **Graph-Score von Vector-Score trennen:** Keine Vermischung im selben Ranking; graph-only Tier separat oder stark gecappt.
6. **Graph-Edge-Qualität verschärfen:** Type-Weights, emotionale/zeitliche Edges nur mit Inhalts-Overlap, Entity-Threshold erhöhen.
7. **Graph-Traversierung begrenzen:** `maxDepth` auf 2 oder `minCumulativeRelevance` pro Tiefe anheben.
8. **Query-Refiner sicherer machen:** Nur bei guten Top-Results Keywords übernehmen.
9. **Importance-/Emotion-Boost kontextualisieren:** Nur bei hoher Vektor-Ähnlichkeit oder als Tie-Breaker wirken lassen.
10. **Widerspruchserkennung auf Memory-Text-Ebene einführen:** Hintergrund-Job oder Pipeline-Schritt für Fakten-Memories.

### P2 — Mittelfristig (Architektur, höheres Risiko)

11. **Budget/Tier-Modell in Produktion integrieren:** `allocateMemoryTiers` nach `runRecallPipeline` aufrufen.
12. **Score-Breakdown / Decision-Trace implementieren:** Pro Memory finalScore-Komponenten und optionalen Trace-Modus.
13. **Merge-/Dedup-Sicherheit erhöhen:** Semantische Konsistenzprüfung nach LLM-Merge, Jaccard/Keyword im Grenzbereich 0.90–0.98.
14. **Overlay-System konservativer machen:** Auto-Overlays nur für Vector-Quellen, Confidence-Validierung, Original-Kontext im Contradiction-Prompt.
15. **Kategorisierung und Importance-Validation verbessern.**

---

## 14. Welche Tests fehlen

### Unit-Tests

1. `tests/memory-graph-association-quality.test.js` — `traverseGraph`, `mergeAssociativeResults`, Edge-Typ-Gewichtung, Tiefe-Abstrafung.
2. `tests/memory-graph-edges.test.js` — `buildEdgesForSession`: emotionale, entity, temporale Edges bei inhaltlich unabhängigen Memories.
3. `tests/continuity-gate-score-vs-strength.test.js` — Gate verwendet `relevanceScore`, nicht `memoryStrength`.
4. `tests/feedback-log.test.js` — Feedback-Verstärkung unterscheidet nach Abruf-Source.
5. `tests/importance-validation.test.js` — Clamping, Logging hoher Werte.
6. `tests/categorize-golden-set.test.js` — 50 Sätze mit erwarteten Kategorien.
7. `tests/merge-safety.test.js` — Zwei ähnliche aber inhaltlich verschiedene Memories dürfen nicht gemerged werden.
8. `tests/contradiction-memory-text.test.js` — Widersprüche zwischen aktiven Fakten-Memories.

### Integrationstests

9. `tests/recall-pipeline-associative-gate.test.js` — Graph-only Assoziation landet nicht in Top-N ohne semantische Relevanz.
10. `tests/recall-pipeline-budget.test.js` — Budget/Tier-Allocation begrenzt associative Memories.
11. `tests/relevant-memory-context-evidence.test.js` — graph-sourced Items haben `graph-source`, `faded`, `association-strength`.
12. `tests/semantic-lens-query-relevance.test.js` — Lens-Kandidaten ohne Query-Overlap werden nicht ausgegeben.
13. `tests/conversation-reactivation-stopword.test.js` — Einzelnes gemeinsames Token reicht nicht.
14. `tests/recall-trace.test.js` — Pipeline liefert `scoreBreakdown` / `trace`.
15. `tests/explainability-accuracy.test.js` — `--explain` zeigt korrekte Komponenten.

### Golden-Set-Erweiterungen

16. `tests/recall-associative-traps.test.js` — Kategorien A–E aus Kapitel 11.

---

## 15. Was geprüft wurde, aber nicht problematisch war

- **Schema-Migrationen:** Robust, idempotent, fehlerisolierend (getestet in `tests/schema-migration.test.js`, `tests/migration-robustness.test.js`).
- **ACL / Auth-Gating:** Obsidian-destruktive Befehle werden korrekt blockiert (`tests/auth-003-obsidian-command-gate.test.js`).
- **Archive-first bei Merge/Update:** Originale werden vor dem Löschen archiviert (`tests/memory-store-merge-archive-first.test.js`).
- **Timeout-Handling:** LanceDB-Operationen haben Timeouts (`tests/db-adapter-timeouts.test.js`).
- **Schema-Default-Typen:** Recall- und Runtime-Defaults stimmen mit Schema überein (`tests/config-audit.test.js`).
- **Sanitization:** `memory-context-sanitize` filtert unsichere Quellen und Attribute (`tests/memory-context-sanitize.test.js`).
- **Overlay-Lifecycle:** Append-only, Supersede, Disable, Lineage funktionieren korrekt (`tests/interpretation-overlay*.test.js`).
- **Halbwertszeit-Grundlogik:** Exponentieller Decay, person/project vs. transient/episodic sind sauber (`tests/recall-golden-set.test.js`).
- **Dedup-Grundlogik:** Zwei near-identical project memories überleben bei 0.78 (`tests/recall-golden-set.test.js`).

---

## 16. Offene Fragen / Risiken

1. **Produktions-Config:** Ist `continuityEngine.associativeRecall.enabled` in der Produktion explizit `true` oder läuft es auf dem impliziten Default? Eine Umstellung auf Opt-in würde das Verhalten ändern.
2. **Graph-Dichte in realen Workspaces:** Wie viele schwache emotionale/temporale/entity-Edges existieren bereits? Eine Änderung der Edge-Generierung erfordert möglicherweise eine Migration oder Rebuild.
3. **Reranker-Abhängigkeit:** Wird der Reranker in der Produktion aktiv genutzt? Wenn ja, wie stark verstärkt er Keyword-Matches in assoziativen Summaries?
4. **Obsidian-Semantic-Link-Discovery:** Ist `obsidianBridge.graphLinks.semanticDiscovery.enabled` aktiv? Wenn ja, entstehen dort zusätzliche schwache Kanten.
5. **Overlay-Review-Prozess:** Werden provisorische Overlays regelmäßig von Menschen reviewed? Ohne Review können sie sich ansammeln und später aktiviert werden.
6. **Multi-Agent / Multi-Workspace:** Könnten Assoziationen über Workspaces hinweg kreuzen? Der aktuelle Audit fokussierte sich auf einen Workspace-Kontext.
7. **LLM-Embedding-Modell:** Die Thresholds (0.78, 0.95) sind modellabhängig. Wechselt das Embedding-Modell, ändern sich die Graph-/Recall-Eigenschaften.

---

## Anhang A: Methodik

1. Git-Hygiene durchgeführt (`git switch main`, `git fetch origin`, `git reset --hard origin/main`).
2. Audit-Branch erstellt: `audit/memory-quality-recall-2026-06-16`.
3. `npm test` verifiziert: 1204 passing / 0 failing.
4. `npm audit --audit-level=moderate`: 0 vulnerabilities.
5. 8 parallele Audit-Subagenten mit disjunkten Scopes dispatched:
   - Memory Formation / Promotion
   - Weighting / Decay / Reinforcement
   - Recall Pipeline / Candidate Selection
   - Graph / Association / Spreading Activation
   - Contradiction / Correction / Interpretation Overlay
   - Prompt Context / Evidence Boundary
   - Golden Set / Behavioral Recall Test
   - Decision Trace / Explainability
6. Befunde der Subagenten konsolidiert, dedupliziert und in K1/H1/M1/L1 klassifiziert.
7. Audit-Dokument erstellt; keine Runtime-Code-Änderungen, keine Commits, keine neuen Testdateien im Repo.

---

## Anhang B: Statistik

| Schwere | Anzahl |
|---------|--------|
| K1 — Kritisch | 6 |
| H1 — Hoch | 14 |
| M1 — Mittel | 20 |
| L1 — Niedrig | 8 |
| **Gesamt** | **48** |

**Top-5-Befunde:**

1. **K1-02:** Assoziativer Recall ist unabhängig vom `continuityEngine`-Schalter aktiv.
2. **K1-01:** Graph-only-Hydration lädt assoziierte Memories ohne semantische Re-Validierung gegen die Query.
3. **H1-01:** Graph-only Treffer werden score-mäßig mit Vektor-Treffern vermischt.
4. **H1-08:** Graph-sourced Items verlieren ihre Origin-Provenance im Prompt.
5. **K1-06:** Keine Widerspruchserkennung auf Memory-Text-Ebene in der Recall-Pipeline.
