# Der Benchmark maß eine schwächere Pipeline als die Produktion

**Datum:** 2026-09-20 · **Betrifft:** alle LOCOMO- und LongMemEval-Läufe vor diesem Datum

## Der Fehler

`run.mjs` ruft `runRecallPipeline()` direkt auf. Zwei Optionen, die `index.js`
im Produktivbetrieb setzt, fehlten dabei:

```js
deferFinalCap: true,
candidateHardLimit: 100,
```

(gesetzt in `index.js:882`, im Mehr-Namensraum-Pfad des Recalls)

## Warum das so viel ausmacht

Die Pipeline hat diese Stufenfolge (`lib/recall-pipeline.js`):

```
2012  budget   applyRecallBudget kappt auf topN
2039  rerank   Reranker sortiert um
2089  dedup
```

Ohne `deferFinalCap` kappt die Pipeline **vor** dem Reranker. Der darf dann nur
noch umsortieren, was die Kappung übrig ließ — eine Erinnerung auf Platz 16
kann er nicht mehr hereinholen. Mit `deferFinalCap: true` wird die Kappung
hinter das Reranking verschoben; der Reranker wählt aus bis zu
`candidateHardLimit` Kandidaten die besten `topN` aus. Das ist seine
eigentliche Aufgabe.

## Die Messung

80 Fragen, bei denen ein früherer Lauf den Gold-Beleg als „nicht geliefert"
gezählt hatte, erneut durch die Pipeline — ohne LLM-Aufrufe, nur Recall:

| Konfiguration | Beleg gefunden |
|---|---|
| wie Produktion (Kappung **nach** Rerank) | **65 von 80 = 81 %** |
| wie Benchmark bisher (Kappung **vor** Rerank) | 11 von 80 = 14 % |

## Wie es sich getarnt hat

Zwei Beobachtungen wiesen in die falsche Richtung und stützten sich gegenseitig:

1. **„Der Reranker bewirkt nichts."** Ein Vergleich mit und ohne Cohere-Reranker
   ergab identische Ergebnisse (11 von 80 in beiden Fällen). Der Reranker
   funktioniert einwandfrei — isoliert getestet sortiert er korrekt (relevantes
   Dokument 0,77 gegen 0,019 für den Rest). Er kam nur zu spät.
2. **„Das Abrufbudget ist zu klein."** `topN` von 12 auf 30 brachte 7,9 Punkte
   Belegquote. Das schien die Ursache zu bestätigen — tatsächlich glich die
   größere Trefferzahl nur die kaputte Reihenfolge teilweise aus: Je mehr
   Plätze, desto weniger wirft die verfrühte Kappung weg.

## Betroffene Zahlen

Alle Läufe vor dem 20.09.2026 sind **zu niedrig**, insbesondere:

- `locomo-g56-fix` — 51,9 % (cat1–4), Grundlinie
- `locomo-nach-umbau-7.12.66` — 46,8 %, Belegquote 68,0 %
- `locomo-topn30` — 51,9 %, Belegquote 75,8 %

Sie sind nicht falsch gerechnet, aber an einer Konfiguration gemessen, die im
Produktivbetrieb nicht vorkommt.

## Befund für die Bibliothek selbst

`deferFinalCap` steht in `runRecallPipeline` per Vorgabe auf `false`. Nur weil
`index.js` es überschreibt, läuft im Produktivbetrieb die bessere Variante. Wer
die Pipeline direkt aufruft — ein Benchmark, ein Skript, ein Test — bekommt
stillschweigend die schwächere. Die Vorgabe sollte umgekehrt sein, oder die
Stufenfolge sollte die Kappung grundsätzlich hinter das Reranking legen.
