# PLUR1BUS-Benchmark — LOCOMO und LongMemEval

Ein Messstand für das Gedächtnis, der **nie über den Gateway und nie gegen die
Produktivdatenbank** läuft. Er treibt `lib/recall-pipeline.js` direkt und
schreibt in eigene LanceDB-Stores unter `db/` beziehungsweise `db-capture/`.

## Schnellstart

```bash
node ingest-capture.mjs locomo          # Stores aus data/ aufbauen (~6 min)
node run.mjs locomo --db db-capture --top-n 15
```

Die Schlüssel stehen in `.env.bench` in diesem Verzeichnis oder in der
Umgebung, immer mit eigenem Präfix: `BENCH_OPENAI_API_KEY` (Einbettungen),
`BENCH_COHERE_API_KEY` (Reranker), `BENCH_DEEPSEEK_API_KEY` (Antwort und Jury
mit der Vorgabe `--provider deepseek`), für `ingest-capture.mjs --jev`
zusätzlich `BENCH_TYPESAFE_API_KEY`. `.env.bench` und ihre Sicherungskopien
sind im Git ausgeschlossen.

`run.mjs` misst den Plugin-Code unter `PLUR1BUS_RELEASE` (Vorgabe:
`plur1bus-release` im Zustandsverzeichnis des Gateways) und liest Daten,
Stores und `.env.bench` aus `BENCH_HOME` (Vorgabe: dieses Verzeichnis).

`data/` und die Stores stehen bewusst nicht im Git — die Datensätze gehören
Dritten, die Stores sind mehrere hundert Megabyte und aus `data/` in Minuten
reproduzierbar.

## Was gemessen wird

| Größe | Bedeutung |
|---|---|
| **cat1–4** | Trefferquote nach Standardprotokoll. **Kategorie 5 gehört nicht in die Wertung** — genau dieser Fehler hat Zeps gemeldete 84 % auf 58,44 % gedrückt. |
| **Belegquote** | Hat der Recall die *richtige* Erinnerung geliefert? Unabhängig vom Antwortmodell und deshalb die aussagekräftigste Zahl. |
| **Erinnerungen** | Wie viele Zeilen im Prompt landeten. Muss zur Konfiguration passen, sonst misst man den Kontext statt das Gedächtnis. |
| **unbewertet** | Fragen, bei denen die Jury nicht geantwortet hat. **Nicht** als falsch zählen. |

## Ergebnisse

| Lauf | cat1–4 | Beleg | Erinn. |
|---|---|---|---|
| Grundlinie `gpt-5.6`, topN 12 | 51,9 % | 65,8 % | 11,8 |
| `deepseek`, topN 12, Kappung vor Rerank | 46,8 % | 68,0 % | 11,8 |
| `deepseek`, topN 30, Kappung vor Rerank | 51,9 % | 75,8 % | 29,3 |
| **`deepseek`, topN 15, wie Produktion** | **60,9 %** | **91,3 %** | **14,7** |

Der Sprung in der letzten Zeile kommt **allein** daraus, dass die Kappung auf
`topN` hinter das Reranking wanderte — siehe
[findings/2026-09-20-harness-defer-final-cap.md](findings/2026-09-20-harness-defer-final-cap.md).
Keine neue Einbettung, kein anderes Modell, kein größerer Kontext.

Nach Kategorie (letzter Lauf): mehrstufig 45,0 %, zeitlich 59,2 %,
Schlussfolgern 21,9 %, einfach 71,3 %. Bis 23.11.2026 standen hier die
Namen verschoben (cat1 als „einfach“, cat3 als „zeitlich“). LOCOMO nummeriert:
cat1 mehrstufig (immer mehrere Belege), cat2 zeitlich, cat3 Schlussfolgern
(wenige Fragen, Allgemeinwissen), cat4 einfach, cat5 adversarial.

## Messung vom 23.11.2026 (7.20.5)

Jahre der Daten auf 2026 verschoben (letzte Session in den letzten zwei
Wochen), Stores über den Capture-Pfad mit Jev-Aufteilung (`ingest-capture.mjs
--jev`), Kappung wie in der Produktion über `mergeNamespaceRecallResults`,
DeepSeek als Antwortmodell und Jury.

| Datensatz | Ergebnis |
|---|---|
| LongMemEval oracle, 100 Fragen, ungeteilt | 90 % |
| LongMemEval oracle, 100 Fragen, Jev-Aufteilung, 7.20.3 → 7.20.4 → 7.20.5 | 83 → 86 → 89 % |
| LOCOMO conv-44/47/50, mehrstufig (82), Antwort „so kurz wie möglich“ | 47,6 % |
| dieselben, Antwort „alle Punkte nennen, über alle Erinnerungen zählen“ | 58,5 % |

Die Antwortanweisung fragt seitdem bei Aufzählungen nach allen Punkten: 7 von
12 Fehlern mit vollständigem Recall waren unvollständige Listen, die die Jury
nach LongMemEval-Regel als falsch wertet. Mehr Recall-Plätze (30 statt 15,
Pool 100 statt 40) hoben die Fragen mit allen Belegen von 35 auf 51 von 82,
die Trefferquote aber nicht (47,6 → 48,8 %).

## Messstand ab 7.20.6 (23.11.2026)

Neue Schalter in `run.mjs`:

- `--render full|prod|prod2` (Komma-Liste): `full` ist die Messstand-Darstellung,
  `prod` rendert den Block wie die Produktion (`resolveEffectiveConfig` aus
  `openclaw.json`, `formatRelevantMemoriesContext`). `prod2` rendert wie `prod`
  mit den Render-Funktionen aus `--prod2-release PFAD` — so lassen sich zwei
  Blockfassungen auf byte-gleichem Recall vergleichen.
- `--repeat N` wiederholt Antwort und Jury N-mal je Frage und Darstellung; der
  Recall läuft einmal. `--category` nimmt eine Komma-Liste, `--ids` einzelne
  Fragen, `--save-blocks` schreibt den gerenderten Block mit.
- `ingest-capture.mjs --jev` baut die Stores über den Capture-Pfad mit
  Jev-Aufteilung; Sprecher kommen als `role: user` an.
- `report-reps.mjs <präfix> [<präfix> …]` wertet Wiederholungen aus
  (Mittel, Spanne, je Kategorie) und rechnet zusätzlich ohne die Fragen aus
  [`excluded.json`](excluded.json): falsche Musterantworten und Artefakte der
  Jahresverschiebung. Ausgeschlossen wird nur in der Auswertung.
- `shift-data.py` (in `data/` ausführen) verschiebt LOCOMO conv-44/47/50 und
  LongMemEval oracle ins Jahr 2026, damit kein mehrjähriger Decay wirkt.

Reranker, Einbettungen, Antwortmodell und Jury laufen nur mit eigenen
Schlüsseln (`BENCH_COHERE_API_KEY`, `BENCH_OPENAI_API_KEY`,
`BENCH_DEEPSEEK_API_KEY`, für `--jev` `BENCH_TYPESAFE_API_KEY`; aus der
Umgebung oder `.env.bench`). `makeReranker`, `makeEmbeddings`, `chatClient`
und `ingest-capture.mjs --jev` brechen ohne sie ab. `loadEnv` lehnt jede Datei
ab, die nach Auflösen von Symlinks und relativen Pfaden unter `~/.openclaw`,
`$OPENCLAW_HOME` oder `$OPENCLAW_STATE_DIR` liegt, und liest sie gar nicht
erst. Am 23.11.2026 haben Messläufe über den Gateway-Schlüssel das Monatslimit
des Produktiv-Rerankers aufgebraucht.

Basis 7.20.6, LOCOMO Kat. 1–4 (431 Fragen), `db-capture-jev2`, topN 15,
Pool 40, 3 Wiederholungen:

| Darstellung | Ergebnis | ohne Ausschlüsse |
|---|---|---|
| `full` | 72,2 % (71,0–73,3) | 75,8 % |
| `prod` | 71,2 % (70,5–71,9) | 74,7 % |

## Messstand ab 7.21.1 (24./25.11.2026)

### Recall-Cache

`run.mjs` holt den Recall je Frage aus `results/recall-cache/`, wenn Store,
Plugin-Code, Recall-Einstellungen, Modelle, Frage und Zeitpunkt gleich sind
(`lib/recall-cache.mjs`). Ein Treffer ruft weder Einbettung noch Cohere auf.
Der Schlüssel ist sha256 über das kanonische JSON aus:

- Store: realpath, Tabellenname, `table.version()` und das neueste Manifest
  (Name, Größe, mtime). Jede Schreibaktion am Store macht die Einträge
  ungültig, ebenso ein Kopieren ohne `-p`.
- Plugin: Version, realpath von `PLUR1BUS_RELEASE`, sha256 über alle Dateien
  unter `lib/` und die LanceDB-Version des Releases. Ein Worktree mit gleicher
  Version, aber geändertem Code trifft also keinen alten Eintrag.
- alle Parameter an `runRecallPipeline` außer Tabelle, Providern, Logger,
  Frage und Zeitpunkt (`topN`, `candidateTopK`, `deferFinalCap`,
  `temporalFilterMode` usw.).
- Reranker (Klasse, Modell, Timeout, `maxDocChars`) und Einbettung (Klasse,
  Modell, Dimension, Basis-URL). API-Schlüssel gehen nicht ein.
- Frage und Recall-Zeitpunkt. Ohne Zeitpunkt wird nicht gecacht.

Gespeichert wird das ganze Pipeline-Ergebnis typgetreu, dazu die Logzeilen der
Pipeline. Bei einem Treffer gehen sie an den Logger des Skripts, die Erkennung
eines Rerank-Ausfalls bleibt also gleich. Ergebnisse mit Rerank-Ausfall werden
nie gespeichert. Ein Eintrag (40 Kandidaten mit Anfragevektor) ist etwa
137 KB groß, 552 LOCOMO-Fragen ergeben rund 75 MB je Konfiguration. Der Cache
steht nicht im Git.

Weil der realpath von `PLUR1BUS_RELEASE` und der Code-Hash im Schlüssel stehen,
laufen beide Seiten eines A/B-Vergleichs am besten aus festen Worktree-Pfaden.
Nach einem Deploy in denselben Pfad sind die alten Einträge nicht mehr
erreichbar. Mit Cache antworten Läufe mit verschiedenen Tags auf byte-gleichen
Recall; das Rauschen des Rerankers zwischen Läufen fällt weg, der Cache friert
aber eine Stichprobe davon ein. Wer die Streuung des Recalls messen will,
nimmt `--no-recall-cache`.

- `--no-recall-cache`: Cache weder lesen noch schreiben.
- `--recall-cache-only`: nur Treffer. Ein Fehlgriff wird zur Fehlerzeile und
  nie zu einem API-Aufruf; gedacht für Nachanalysen ohne Kosten.
- `--recall-cache-dir PFAD`: andere Ablage, etwa für Tests mit Attrappen.
- `--recall-only`: nur Recall und Rendern, kein Antwortmodell, keine Jury,
  kein Chat-Client. Ausgabe `results/<which>-<tag>-recall.jsonl` mit
  Treffer-IDs, Belegtreffer und Blockgröße je Darstellung (`--save-blocks`
  schreibt den Block mit). So lässt sich der Cache vorab füllen.

Treffer, Fehlgriffe und die gezählten Provider-Aufrufe (`apiCalls`) stehen am
Ende in der Meta-Datei unter `recallCache`; jede Ergebniszeile trägt ihren
Status.

### Reranker

`lib/common.mjs` nennt das Cohere-Modell ausdrücklich:
`BENCH_DEFAULT_RERANK_MODEL` ist `rerank-v5.0-fast`, seit 7.21.1 auch der
Default des Plugins. Das gilt auch gegen ältere Releases, deren Default noch
`rerank-v3.5` war; das alte Modell gibt es mit `--rerank-model rerank-v3.5`.
Das Modell steht im Cache-Schlüssel, in der Kopfzeile des Laufs und als
`rerankModel` in der Meta-Datei.

`--rerank-max-doc-chars` gibt es nicht, der Schalter bricht mit Begründung ab.
Der Messstand übergibt kein `maxDocChars` und misst damit den Default des
Plugins, wie eine Produktion ohne eigenen `reranker.maxDocChars`: bis 7.20.9
keine Längengrenze, ab 7.20.10 kürzt der Cohere-Provider jedes Dokument auf
1400 Zeichen. Rerank-Dokument ist je Kandidat `summary`, sonst die gekürzte
Zusammenfassung des Texts. Ein eigener Wert nur im Messstand würde etwas
messen, das die Produktion nicht tut. Der wirksame Wert steht im
Cache-Schlüssel.

`--cohere-billing` summiert `meta.billed_units` aller Cohere-Antworten und
schreibt die Summe als `cohereBilling` in die Meta-Datei und die Schlusszeile.
`rerank-v5.0-fast` rechnet nach `input_tokens` ab, nicht je Suche. Der volle
Lauf unten (LOCOMO 431 und LME 100, Breite 30/100) kam auf 3,66 Mio. Tokens,
bei 0,02 $ je Million laut Cohere etwa 0,07 $.

### Weitere Schalter

- `--auto-policy off|base|full` wendet die Auto-Recall-Regeln nachträglich auf
  das (gecachte) Pipeline-Ergebnis an, an derselben Stelle wie die Produktion:
  nach Rerank und Small-to-Big, vor der Kappung auf `topN`. `base` entspricht
  7.20.10 (Echo-Ausschluss, Qualitätsgewicht), `full` 7.21.1 (zusätzlich
  `staleAssistant` und `mergeTurnParts`). Alle drei Stufen teilen sich einen
  Cache-Eintrag. `base` braucht PLUR1BUS ab 7.20.10, `full` ab 7.21.1.
- `--temporal-mode intent|legacy|off` setzt `temporalFilterMode` der Pipeline
  (ab 7.20.8, sonst Abbruch). Ohne Schalter gilt der Default des Plugins.
  Anders als der frühere Umweg über `validAt` bleibt `fetchLimit` dabei
  unverändert.
- `--judge-provider P` lässt die Jury bei einem anderen Anbieter laufen als
  die Antwort, etwa `--provider codex --judge-provider deepseek`. `codex` nutzt
  die ChatGPT-Anmeldung aus `$CODEX_HOME/auth.json` (Vorgabe `~/.codex`), also
  das Abonnement statt eines API-Schlüssels.

Die Meta-Datei hält `autoPolicy`, `temporalFilterMode` und `judgeProvider` fest.

### Ergebnisse 7.21.1

Plugin 7.21.1, Breite 30/100 (`--top-n 30 --candidate-top-k 100`),
`--render prod`, LOCOMO Kat. 1–4 aus `db-capture-jev2` (431 Fragen),
LongMemEval oracle aus `db-capture-jev` (100 Fragen), Antwort
`deepseek-flash`, Jury `deepseek-v4-pro`. Die Antwortläufe lasen nur
Cache-Treffer (`--recall-cache-only`).

| Konfiguration | LOCOMO (431) | LME (100) |
|---|---:|---:|
| `rerank-v3.5`, ohne Regeln | 75,9 % | 90 % |
| `rerank-v3.5`, Regeln 7.20.10 | 76,3 % | 90 % |
| `rerank-v3.5`, Regeln 7.21.1 | 74,2 % | 91 % |
| `rerank-v5.0-fast`, Regeln 7.21.1 | 74,7 % | 94 % |

Belegtreffer in den Top 30: LOCOMO 414 (v3.5) bzw. 418 (v5.0-fast) von 429,
LME 100 von 100. Bei LOCOMO war der Recall in allen drei v3.5-Zeilen identisch
(431 von 431 gleiche ID-Listen); die Unterschiede dort (bis 2,1 pp) sind
Rauschen des Antwortmodells und kein Effekt der Regeln. Bei LME ordnen die
Regeln von 7.20.10 85 von 100 Recalls um, die von 7.21.1 gegenüber 7.20.10
noch 5. v5.0-fast gegen v3.5, beide mit den Regeln von 7.21.1: LOCOMO
+0,5 pp (KI −2,6 … +3,5), LME +3 pp (KI −1 … +8), beides nicht signifikant.
Weil v5.0-fast nicht schlechter abschnitt, ist es seit 7.21.1 der Default des
Plugins.

### Gold-Prüfung (24.11.2026)

21 verdächtige Musterantworten haben je drei Prüfer bewertet: einer streng am
Text, einer als Verteidiger der Musterantwort, einer mit Blick auf Datum und
Sprecher. Ausgeschlossen wird nur bei mindestens zwei Stimmen einschließlich
des Verteidigers. Drei Fragen kamen dazu, alle mit 3 von 3 Stimmen:
conv-47#11 (Datum in der Frage falsch), conv-44#33 und conv-50#7 (Kat. 3,
Musterantwort ohne Beleg im Gespräch). [`excluded.json`](excluded.json) führt
jetzt 25 Fragen. Die übrigen 18 Musterantworten stimmen; diese Fragen
scheitern an fehlenden Belegen oder an Teilantworten, die die Jury zu Recht
ablehnt.

## Vergleichbarkeit mit anderen Systemen

Gemeldete LOCOMO-Werte liegen zwischen 58 % und 96 %, und die Anbieter streiten
öffentlich über die Methodik. Wer vergleichen will, muss **drei** Dinge
angleichen — Mem0 formuliert die Regel selbst: *„Always compare systems using
the same retrieval budget, the same model, and the same latency budget."*

| | Anbieter-Standard | dieser Messstand |
|---|---|---|
| Abrufbudget | **top-k 200** (zusätzlich 10/20/50) | 15 (Produktivwert) |
| Antwortmodell | `gpt-4o` | frei wählbar |
| Jury | `gpt-4o` | frei wählbar |

Unsere Zahlen sind also **nicht** direkt neben ein Leaderboard zu stellen. Ein
eigener Befund relativiert das aber: Von 15 auf 39 Erinnerungen steigt die
Belegquote nur von 90 auf 93 Prozent. Die Menge ist bei uns kein Engpass mehr —
was 200 Plätze anderswo holen, holen hier fünfzehn.

## Fallstricke, die je einen halben Tag gekostet haben

1. **`deferFinalCap`** — ohne diese Option kappt die Pipeline vor dem
   Reranking und misst eine schwächere Variante als die ausgelieferte. Alle
   Läufe vor dem 20.09.2026 sind dadurch zu niedrig.
2. **Kappung beim Aufrufer** — mit `deferFinalCap` liefert die Pipeline bis zu
   `candidateHardLimit` Zeilen; wer nicht selbst kappt, hat plötzlich 39 statt
   15 Erinnerungen im Prompt und misst den Kontext.
3. **Tokenbudget der Jury** — sie soll nur „yes" oder „no" sagen, aber
   Denk-Tokens zählen gegen `max_tokens`. Mit 5 kamen 165 von 1.986 Urteilen
   **leer** zurück, HTTP 200, und wurden als falsch gezählt: 45,9 % statt
   50,0 %. Jetzt 4.000 plus ein Wiederholungsversuch.
4. **Fragetexte sind nicht eindeutig** — 12 LOCOMO-Fragen kommen in mehreren
   Gesprächen vor. Belege über `<store>#<index>` zuordnen, nie über den Text.
5. **Kategorie 5** gehört nicht in die Wertung.
6. **`openclaw infer model run` schreibt ins Gedächtnis** — der Aufruf löst
   die Capture-Hooks des angegebenen Agenten aus. Ein Messlauf über einen
   produktiven Agenten hat am 24.11.2026 Hunderte Messerinnerungen in dessen
   Store und Neo-Store geschrieben. Antwortmodelle über den Gateway deshalb
   nur mit einem Wegwerf-Agenten mit eigenem Workspace ansprechen.

## Analysen

- [`analysis/emotion-format/`](analysis/emotion-format/) — volle gegen
  gekürzte Emotionskarte, A/B/A mit Rauschboden aus zwei identischen Läufen.
- [`analysis/deepseek-compare/`](analysis/deepseek-compare/) —
  `deepseek-flash` gegen `kimi-for-coding-highspeed` auf identischen
  Erinnerungen.

Die Stichproben dieser Analysen stehen **nicht** im Git: Sie enthalten echte
Erinnerungen aus den Produktivstores.
