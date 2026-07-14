# Humanization: Agenten menschlicher wirken lassen

Ziel: Die PLUR1BUS-Agenten (main/bernhardine/heisenberg) wirken aus User-Sicht menschlicher. Fünf Features, priorisiert: (1) Mood als Stil-Direktive statt Label, (5) Prosa-Reviews, (2) unregelmäßige Proaktivität, (3) offene Fäden aufnehmen, (4) Widersprüche aussprechen.

## Global Constraints

- Pattern-Vorbild: `lib/dreaming/dream-narrative.js` — kleine pure Funktionen, ein dünner Orchestrator, **fail-open** (try/catch → null/Fallback, nie den Message-Flow brechen), Output-Länge begrenzt.
- Alle neuen Kontextblöcke sind größenbegrenzt (max. ~400 Zeichen pro Block) und deutschsprachig.
- Test-Runner: `npm test` (Node test runner, `tests/*.test.js`). Jede neue pure Funktion bekommt eine Testdatei; keine LLM-Aufrufe in Tests (callLlm mocken wie in `tests/dream-narrative.test.js`).
- Keine neuen Dependencies. Keine Schema-Änderungen an LanceDB (siehe Doku: keine Auto-Evolution).
- Bestehende Funktionssignaturen nicht brechen; `index.js`-Integrationen minimal-invasiv an den benannten Ankerstellen.
- Zufall injizierbar machen (`rng`-Parameter, Default `Math.random`) für deterministische Tests.

## Task 1 — Mood-Stil-Direktive statt Label (#1)

Neu: `lib/mood-style-directive.js` mit `buildMoodStyleDirective(mood)` (pure). Input: Ergebnis von `describeMood()` (`{label, dominant, intensity, trend, nuances, emoji}`). Output: 1–3 Sätze deutsche Prompt-Direktive, die beschreibt WIE der Agent schreiben soll (Satzlänge, Wärme, Emoji-Neigung, Energie), plus die explizite Anweisung: „Nenne deine Stimmung nicht als Label/Statuszeile; lass sie nur den Ton färben." Mapping mindestens für die dominanten Dimensionen joy/trust/sadness/fear/anger/anticipation × intensity hoch/mittel/niedrig; trend steigend/fallend moduliert Energie. Bei unbekanntem/leerem Input → `null`.

Integration: In `index.js` (~5634) `formatMoodLine(...)` durch `buildMoodStyleDirective(...)` ersetzen (Fallback: wenn null, gar keine Mood-Injektion — nicht das alte Label). `formatMoodLine` selbst bleibt bestehen (wird von `.current-mood.txt`/Status weiter genutzt).

Tests: `tests/mood-style-directive.test.js` — Mapping-Fälle, Null-Fälle, Längenlimit, Anweisung „nicht als Label nennen" enthalten.

## Task 2 — Prosa-Lead für Reviews (#5)

Neu: `lib/review-narrative-lead.js` mit `buildReviewNarrativeLead(summary, mood)` (pure, fail-open): erzeugt 2–4 deutsche Fließtext-Sätze aus dem Review-`summary` (Anzahl Findings/Proposals/Konflikte/Duplikate; „nichts Auffälliges" wenn leer) + optionaler Mood-Färbung (via `moodToTone`-Idee aus dream-narrative). Kein Bullet-Format, keine Emojis-Pflicht.

Integration: `lib/obsidian-control-room.js` — `renderEveningDeepReviewMarkdown(summary)` und Morning-Pendant stellen den Lead als ersten Absatz voran (nach der Überschrift). `runEveningDeepReview`/`runMorningReview` akzeptieren optional `options.mood` und reichen es durch; wenn nicht gesetzt → Lead ohne Mood-Färbung.

Tests: `tests/review-narrative-lead.test.js` — leerer Summary, voller Summary, mit/ohne Mood, Längenbegrenzung; bestehende `evening-deep-review-guardrails.test.js` bleibt grün.

## Task 3 — Unregelmäßige, anlassbezogene Proaktivität (#2)

Änderung: `lib/proactive-nudge.js` — `shouldShowNudge(pattern, lastShown, now, opts)` bekommt: (a) Jitter: Cooldown 24h ± bis zu 6h, deterministisch aus Hash(pattern-id + Kalendertag) — kein echtes RNG nötig, testbar; (b) Ruhezeiten: keine Nudges 22:00–08:00 lokal (Option `quietHours: {start: 22, end: 8}`, abschaltbar); (c) Tages-Cap bleibt wie vorhanden bzw. max. 2/Tag falls keiner existiert. Bestehende Aufrufer ohne `opts` behalten das heutige Verhalten Cooldown-seitig kompatibel (Jitter default an, quietHours default an — dokumentieren).

Tests: `tests/proactive-nudge-timing.test.js` — Jitter-Determinismus (gleiche Inputs → gleiches Ergebnis), Grenzen 18h–30h, Ruhezeit blockt, Cap greift.

## Task 4 — Offene Fäden aufnehmen (#3)

Neu: `lib/open-threads.js` mit `collectOpenThreads(entries, opts)` (pure): Input = geparste Zeilen aus `reply-outcomes.jsonl` (Aufrufer lädt Datei); filtert Outcomes `ignored_or_topic_shifted` und `asked_details` der letzten `maxAgeDays` (Default 4), die kein späteres `confirmed_or_continued`/`continued_topic` zum selben Topic haben; liefert max. 2 Einträge `{topic, ageDays, hint}`. Plus `formatOpenThreadsContext(threads)` → kurzer Kontextblock: „Offene Fäden aus früheren Gesprächen (nur ansprechen, wenn es natürlich passt, maximal einen): …".

Integration: `index.js` — beim Kontextbau (neben moodLine, ~5634) fail-open laden + formatieren; Block nur injizieren, wenn nicht leer. Ein einfacher In-Memory-/Datei-Cooldown (1x pro Session/Tag pro Thread) verhindert Wiederholung; simpelste tragfähige Lösung wählen (z. B. `.open-threads-shown.json` im Workspace analog zu `cooldowns.json`).

Tests: `tests/open-threads.test.js` — Filterung, Resolved-Erkennung, Cap 2, Formatierung, leerer Input.

## Task 5 — Widersprüche aussprechen (#4)

Neu: `lib/contradiction-disclosure.js` mit `formatContradictionDisclosure(pairs, opts)` (pure): Input = Liste `{winner, loser}`-Paare (Felder wie an der Ankerstelle vorhanden: Beschreibungstexte + Zeitstempel); Output = max. 1 kurzer Kontextblock (nur das erste/wichtigste Paar): „Du hast dazu widersprüchliche Erinnerungen: ‚…' (älter) vs. ‚…' (neuer). Du folgst der neueren — erwähne die Unsicherheit beiläufig, falls das Thema aufkommt." Texte auf je ~120 Zeichen gekürzt.

Integration: `index.js` — direkt nach der `resolveContradictionWinner`-Schleife (~5502–5522): gesammelte Paare an den Formatter, Ergebnis an `fullMemoriesContext` anhängen. Config-Gate `contradictionDisclosure.enabled` (Default true), fail-open.

Tests: `tests/contradiction-disclosure.test.js` — Formatierung, Kürzung, leere Liste, nur-1-Block-Regel.

## Task 6 — Live-System: Cron-Prompts & Deploy (kein Repo-Code)

Nach Merge: (a) Repo → Deploy-Verzeichnis synchen (bestehender Repair-/Deploy-Weg `npm run repair` bzw. verify-plugin-deploy --repair), Gateway-Neustart; (b) die 6 Review-Cron-Prompts ergänzen: Telegram-Review als 3–5 Sätze Prosa führen, Detail-Bullets nur für echte Auffälligkeiten, KEINE „Stimmung:"-Statuszeile ausgeben. Wird vom Controller (nicht Subagent) ausgeführt; Erfolgskriterium: nächster Evening-Review kommt als Prosa ohne Mood-Label.

## Reihenfolge & Unabhängigkeit

Tasks 1–5 sind unabhängig (verschiedene Dateien; index.js-Anker disjunkt), werden aber sequenziell ausgeführt (gemeinsame index.js). Task 6 zuletzt, manuell.
