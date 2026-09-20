# Emotionskarte: volles Format vs. gekürztes Format

**Datum:** 2026-09-19 · **Modell:** `kimi-for-coding-highspeed` (thinking an, Provider-Default)
**Stichprobe:** 60 echte Erinnerungen aus `main` + `bernhardine`, nach Textlänge geschichtet (20 kurz / 20 mittel / 20 über 2000 Zeichen), fester Seed.
**Arme:** `full` (Produktions-Prompt), `short` (nur mitschwingende Dimensionen), `full2` (zweiter voller Lauf als Rauschboden).
**Produktionscode unverändert** — beide Formate laufen durch denselben `parseEncodingResponse`; fehlende Dimensionen füllt der Parser schon heute mit 0.

## Ergebnis

| Arm | n | Parse-Fehler | nicht-null-Dim. | Antwort-Tokens | Completion-Tokens | importance | „Lektions"-Rate |
|---|---|---|---|---|---|---|---|
| full | 60 | 4 | 3,27 | 159 | 633 | 0,389 | 32,1 % |
| short | 60 | 2 | 0,52 | 81 | 608 | 0,406 | 3,4 % |
| full2 | 60 | 0 | 3,38 | 155 | 690 | 0,406 | 38,3 % |

| Paar | n | \|Δimportance\| | dominant gleich | L1(Vektor) | \|Δintensity\| |
|---|---|---|---|---|---|
| full2 vs full (Rauschboden) | 56 | 0,079 | 76,8 % | 0,412 | 0,092 |
| short vs full (Formateffekt) | 55 | 0,087 | 80,0 % | 0,473 | 0,079 |

## Befunde

1. **Bedeutung und dominante Emotion sind formatunabhängig.** Der Formateffekt liegt auf dem Rauschboden: |Δimportance| 0,087 gegen 0,079; die dominante Dimension stimmt zwischen den Formaten sogar häufiger überein (80,0 %) als zwischen zwei Läufen desselben Formats (76,8 %).

2. **Der volle Prompt erzeugt eine ausgefüllte Tabelle.** Sekundäre Dimensionen im vollen Arm: Median 0,10, 77 % der Werte ≤ 0,2. Im kurzen Arm: Median 0,35, nur 24 % ≤ 0,2. Das Modell nennt im kurzen Format seltener etwas — aber wenn, dann mit Gewicht.

3. **Eine nachgelagerte Regel bricht weg.** `computeRecallBoost` (lib/emotional-state.js) verlangt für die „wichtige Lektion"-Regel `trust > 0` UND `fear|anger > 0`. Diese Kombination tritt im vollen Format bei 32–38 % aller Erinnerungen auf, im kurzen nur bei 3,4 %. Die 32 % sind nach Befund 2 aber überwiegend Tabellenrauschen bei Werten um 0,1 — die Regel feuert heute also fast beliebig.

4. **Der Sparbetrag ist kleiner als gedacht.** Die reinen Antwort-Tokens halbieren sich (159 → 81), die abgerechneten Completion-Tokens kaum (633 → 608): Denk-Tokens dominieren. Bei einem Modell ohne Thinking (Haiku-Pfad) greift die Halbierung voll; hier nicht gemessen.

5. **Nebenbefund für das Token-Budget.** Alle sechs Parse-Fehler sind Abbrüche bei `finish_reason: length`, verursacht ausschließlich von Denk-Tokens (1343–1499 von 1500). Das neue 1500er-Budget reicht für die Antwort, aber nicht für Thinking. Die Produktions-Crons fahren Kimi mit `thinking: off` — dort tritt das nicht auf.

## Einschränkungen

- Nur Kimi gemessen. Für Haiku existiert kein direkter HTTP-Weg (Anthropic läuft über die Claude-CLI, kein API-Key in `models.json`), also keine 2×2-Matrix.
- Thinking war an; der Kostenvergleich ist dadurch für den Haiku-Pfad nicht übertragbar.

## Dateien

`sample.mjs` · `run-ab.mjs` · `analyze.mjs` · `sample.jsonl` · `results.jsonl` (183 Calls, roh) · `ANALYSE.txt`
