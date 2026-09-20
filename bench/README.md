# PLUR1BUS-Benchmark — LOCOMO und LongMemEval

Ein Messstand für das Gedächtnis, der **nie über den Gateway und nie gegen die
Produktivdatenbank** läuft. Er treibt `lib/recall-pipeline.js` direkt und
schreibt in eigene LanceDB-Stores unter `db/` beziehungsweise `db-capture/`.

## Schnellstart

```bash
node ingest-capture.mjs locomo          # Stores aus data/ aufbauen (~6 min)
DEEPSEEK_API_KEY=… node run.mjs locomo --db db-capture --top-n 15
```

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

Nach Kategorie (letzter Lauf): einfach 45,0 %, mehrstufig 59,2 %,
**zeitlich 21,9 %**, offen 71,3 %. Zeitliches Schließen ist die verbliebene
Schwäche und liegt nicht am Ranking.

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

## Analysen

- [`analysis/emotion-format/`](analysis/emotion-format/) — volle gegen
  gekürzte Emotionskarte, A/B/A mit Rauschboden aus zwei identischen Läufen.
- [`analysis/deepseek-compare/`](analysis/deepseek-compare/) —
  `deepseek-flash` gegen `kimi-for-coding-highspeed` auf identischen
  Erinnerungen.

Die Stichproben dieser Analysen stehen **nicht** im Git: Sie enthalten echte
Erinnerungen aus den Produktivstores.
