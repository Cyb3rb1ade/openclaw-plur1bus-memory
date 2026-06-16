# Memory Association Safety Fix Followup

**Projekt:** `/Users/cyberblade/openclaw-plur1bus-memory`  
**Branch:** `fix/memory-association-safety-2026-06-16`  
**Datum:** 2026-06-16  
**Ziel:** P0 Association-Safety Fixes — verhindern, dass assoziative Memories im Prompt wie direkte Fakten wirken.

---

## 1. Behobene Audit-Befunde

| Audit-ID | Schwere | Titel | Status |
|----------|---------|-------|--------|
| K1-02 | K1 | Assoziativer Recall ist default-on | Behoben |
| K1-01 | K1 | Graph-only Hydration ohne Query-Relevanzprüfung | Behoben |
| H1-05 | H1 | ContinuityGate nutzt `memoryStrength` statt Assoziations-Relevanz | Behoben |
| H1-08 | H1 | Graph-sourced Items verlieren Origin-Provenance | Behoben |
| H1-09 | H1 | Graph-sourced Items der Tiefe 1–2 werden nicht als faded markiert | Behoben |
| K1-03 | K1 | Semantic Lens / CRR reichen einzelnes Token als Relevanz | Behoben |

---

## 2. Geänderte Dateien

### Produktionscode

- `index.js` — `useAssociative` wird über `computeUseAssociative()` aus `lib/recall-pipeline.js` berechnet.
- `lib/recall-pipeline.js` — Neue exportierte Funktion `computeUseAssociative()`; `hydrateGraphResults` revalidiert graph-only Kandidaten gegen den Query-Vektor; neuer interner Helper `computeQueryRelevance()`.
- `lib/continuity-gate.js` — `filterAssociativeCandidates` verwendet `relevanceScore / associatedScore / associationStrength` als Gate-Score.
- `lib/relevant-memory-context.js` — Graph-sourced Items behalten Original-Source, bekommen `graph-source="associative"`, `faded="true"` ab `depth >= 1` und optionales `association-strength`.
- `lib/semantic-lens-index.js` — Filterung generischer Tokens; Mindest-Overlap von 2 signifikanten Tokens.
- `lib/conversation-reactivation-recall.js` — Filterung generischer Tokens; Mindest-Overlap von 2 signifikanten Tokens.

### Tests

- `tests/recall-pipeline-associative-toggle.test.js` (neu)
- `tests/recall-pipeline-graph-hydration-relevance.test.js` (neu)
- `tests/continuity-gate-association-score.test.js` (neu)
- `tests/relevant-memory-context-evidence-boundary.test.js` (neu)
- `tests/conversation-reactivation-stopword.test.js` (neu)
- `tests/semantic-lens-query-relevance.test.js` (neu)
- `tests/continuity-gate.test.js` (angepasst)
- `tests/conversation-reactivation-recall.test.js` (angepasst)
- `tests/relevant-memory-context.test.js` (angepasst)
- `tests/semantic-lens-index.test.js` (angepasst)

---

## 3. Neue Tests

| Testdatei | Abgedecktes Verhalten |
|-----------|----------------------|
| `tests/recall-pipeline-associative-toggle.test.js` | `continuityEngine.enabled=false` → kein assoziativer Spread; `continuity on + assoc off` → kein Spread; `continuity on + assoc on` → Spread erlaubt. |
| `tests/recall-pipeline-graph-hydration-relevance.test.js` | Irrelevantes graph-only Memory wird gefiltert; relevantes bleibt; Embedding-Fehler crasst nicht. |
| `tests/continuity-gate-association-score.test.js` | Hohe `memoryStrength` + niedrige Relevanz → blockiert; niedrige `memoryStrength` + hohe Relevanz → erlaubt; Score-Priorität `relevanceScore > associatedScore > associationStrength`. |
| `tests/relevant-memory-context-evidence-boundary.test.js` | Graph-sourced Item behält `source`, bekommt `graph-source="associative"`, `faded="true"` ab `depth=1`, `association-strength`; direktes Item bleibt unverändert. |
| `tests/conversation-reactivation-stopword.test.js` | Einzelnes generisches Token reicht nicht; 2–3 spezifische Tokens erlauben Reaktivierung. |
| `tests/semantic-lens-query-relevance.test.js` | Lens-Kandidat mit nur generischem Overlap wird verworfen; Kandidat mit 2+ spezifischen Tokens wird ausgewählt. |

---

## 4. Behavior-Changes

### 4.1 Assoziativer Recall ist jetzt Opt-in

**Vorher:**
```js
const useAssociative = continuityEnabled ? assocCfg.enabled !== false : true;
```
Wenn `continuityEngine.enabled === false`, war assoziativer Recall trotzdem aktiv.

**Nachher:**
```js
const useAssociative = computeUseAssociative(continuityEnabled, assocCfg);
// = continuityEnabled === true && assocCfg.enabled === true
```
Assoziativer Recall läuft nur, wenn beide Schalter explizit `true` sind.

### 4.2 Graph-only Hydration prüft Query-Relevanz

**Vorher:** Graph-only IDs wurden aus der DB geladen und in die finalen Ergebnisse übernommen, ohne die semantische Passung zur Query zu prüfen.

**Nachher:** Nach dem Hydrate wird die Cosine-Ähnlichkeit zwischen Query-Vektor und Memory-Vektor geprüft. Kandidaten unter dem Threshold (`graphHydrationRelevanceThreshold`, Default `0.25`) werden verworfen. Fehler führen nicht zum Crash.

### 4.3 ContinuityGate verwendet Assoziations-Relevanz

**Vorher:** Gate-Score war `item.memoryStrength ?? 1.0`.

**Nachher:** Gate-Score ist `item.relevanceScore ?? item.associatedScore ?? item.associationStrength ?? 0`. Fehlende Relevanz-Werte blockieren den Kandidaten konservativ.

### 4.4 Prompt Evidence Boundary für graph-sourced Items

**Vorher:**
```xml
<memory-record category="fact" source="associative" depth="1">
  <quoted-evidence>...</quoted-evidence>
</memory-record>
```
Original-Source ging verloren; Tiefe 1–2 wurde nicht als faded markiert.

**Nachher:**
```xml
<memory-record category="fact" source="group" graph-source="associative" id="..." faded="true" depth="1" association-strength="0.72">
  <quoted-evidence>...</quoted-evidence>
</memory-record>
```
Original-Source bleibt erhalten, assoziative Herkunft ist separat markiert, Tiefe 1+ ist faded, Assoziationsstärke ist sichtbar.

### 4.5 Semantic Lens / CRR Token-Overlap

**Vorher:** Ein einziges gemeinsames Token (z. B. `api`, `project`, `memory`) reichte für die Reaktivierung.

**Nachher:** Generische Tokens werden gefiltert; mindestens 2 signifikante, nicht-generische Tokens müssen überlappen.

---

## 5. Vorher/Nachher-Beispiele für Prompt Rendering

### Beispiel 1: Graph-sourced Item Tiefe 1

**Vorher:**
```xml
<memory-record category="fact" source="associative" id="mem-123" depth="1">
  <quoted-evidence>User prefers short answers.</quoted-evidence>
</memory-record>
```

**Nachher:**
```xml
<memory-record category="fact" source="dm" graph-source="associative" id="mem-123" faded="true" depth="1" association-strength="0.68">
  <quoted-evidence>User prefers short answers.</quoted-evidence>
</memory-record>
```

### Beispiel 2: Graph-sourced Item Tiefe 3

**Vorher:**
```xml
<memory-record category="fact" source="associative" id="mem-456" depth="3">
  <quoted-evidence>Yesterday it rained.</quoted-evidence>
</memory-record>
```

**Nachher:**
```xml
<memory-record category="fact" source="group" graph-source="associative" id="mem-456" very-faded="true" faded="true" depth="3" association-strength="0.21">
  <quoted-evidence>Yesterday it rained.</quoted-evidence>
</memory-record>
```

### Beispiel 3: Direkter Vektor-Treffer (unverändert)

```xml
<memory-record category="fact" source="dm" id="mem-789">
  <quoted-evidence>Dreamdale is a festival, not a place.</quoted-evidence>
</memory-record>
```

---

## 6. Offene Risiken

- **Behavior-Change bei `continuityEngine.enabled=false`:** Installationen, die bisher unbewusst auf impliziten assoziativen Recall angewiesen waren, verlieren diesen jetzt. Das ist korrekt, sollte aber kommuniziert werden.
- **Graph-Hydration Threshold:** Default `0.25` ist konservativ gewählt. In der Produktion kann er über `graphConfig.graphHydrationRelevanceThreshold` konfiguriert werden; derzeit wird er noch nicht aus `openclaw.plugin.json` durchgereicht.
- **Generische Token-Liste:** Die Filterliste in `semantic-lens-index.js` und `conversation-reactivation-recall.js` umfasst die im Audit genannten Domain-Tokens. Eine spätere Runde könnte allgemeine Stopwords ergänzen.
- **Semantische Similarity für Lens/CRR:** Die Audit-Empfehlung, zusätzlich Embedding-Similarity zu prüfen, wurde in dieser P0-Runde nicht umgesetzt.
- **Source `"dm"` fällt weiterhin auf `"memory"` zurück:** `DISPLAY_SOURCES` in `lib/memory-context-sanitize.js` enthält nicht `"dm"` (separater Befund M1-19).

---

## 7. Empfohlene nächste Fix-Runde

### P1 — Mittelfristig

1. **Graph-Scores von Vector-Scores trennen:** Keine Vermischung in `mergeAssociativeResults`; graph-only Tier separat oder stark gecappt.
2. **Graph-Edge-Qualität verschärfen:** Type-Weights, emotionale/zeitliche Edges nur mit Inhalts-Overlap, Entity-Threshold erhöhen.
3. **Graph-Traversierung begrenzen:** `maxDepth` auf 2 oder `minCumulativeRelevance` pro Tiefe anheben.
4. **Widerspruchserkennung auf Memory-Text-Ebene einführen.**
5. **Importance-/Emotion-Boost kontextualisieren:** Nur bei hoher Vektor-Ähnlichkeit oder als Tie-Breaker wirken lassen.

### P2 — Architektur

6. **Budget/Tier-Modell in Produktion integrieren:** `allocateMemoryTiers` nach `runRecallPipeline` aufrufen.
7. **Score-Breakdown / Decision-Trace implementieren.**
8. **Merge-/Dedup-Sicherheit erhöhen.**
9. **Kategorisierung und Importance-Validation verbessern.**

---

## 8. Finaler Teststatus

```bash
npm test
```

```
ℹ tests 1230
ℹ suites 229
ℹ pass 1230
ℹ fail 0
ℹ duration_ms 30931.540125
```

```bash
npm run lint
```

```
# Keine Fehler
```

---

## 9. Commit-Strategie

Empfohlene logische Commits:

1. `fix(recall): make associative recall explicit opt-in`
2. `fix(recall): revalidate graph-only hydration against query`
3. `fix(continuity): gate associative candidates by relevance`
4. `fix(context): mark associative memories as weak evidence`
5. `fix(recall): harden semantic lens and reactivation overlap`
6. `docs(audit): add memory association safety followup`
