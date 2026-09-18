# Importance aus Kodierung und Gebrauch statt aus Schlüsselwortlisten

Entwurf vom 19.09.2026 · Stand: zur Prüfung · PLUR1BUS 7.12.62

## Ziel

Das Gedächtnis soll sich verhalten wie menschliches Erinnern, nicht wie ein
optimierter Retrieval-Index. Prüfstein sind zwei Alltagsfälle: Was ich vorgestern
gefrühstückt habe, ist weg. Ein einmaliges, einschneidendes Ereignis ist auch
nach Jahrzehnten da, ohne je wiederholt worden zu sein.

Nicht Ziel: bessere Werte in LOCOMO oder LongMemEval. Beide dienen hier als
Leitplanke gegen Regressionen, nicht als Zielgröße.

## Warum der heutige Zustand nicht trägt

`computeMemoryImportance()` leitet den Wert aus Schlüsselwortlisten ab und
arbeitet dabei fast nur mit Untergrenzen (`Math.max`): Jedes erkannte Muster hebt
auf einen Boden, nach unten gibt es nur zwei Deckel. Gemessen am 18./19.09.2026:

| Befund | Beleg |
|---|---|
| Die Skala ist kollabiert | `main`: 71,1 % aller 9.572 aktiven Zeilen auf exakt 0,70; `bernhardine`: 71,0 % von 12.298. Drei Viertel liegen auf oder über der Promotionsschwelle. |
| Die Regel „named entity" feuert bei fast jedem deutschen Satz | `extractNamedEntities()` zählt jedes großgeschriebene Wort als Eigennamen. Im Deutschen ist jedes Substantiv großgeschrieben. 99 % einer 800er-Stichprobe tragen diese Begründung. |
| Zeitangaben wurden bestraft statt belohnt | „Ich war gestern beim Arzt" fällt über `TEMPORAL_MARKERS` auf 0,45 — in einem Gedächtnis ist die Zeitangabe aber gerade das Wertvolle. |
| Der Wert trennt nicht | Auf LOCOMO: Gold-Evidenz 0,641 im Schnitt, übrige Turns 0,650. Der `importanceBoost` reiht damit nach Rauschen um und drückte die Evidenz-Trefferquote von 84 % auf 63 %. |

Der Teilstring-Fehler in `containsPhrase()` (behoben in 7.12.62) war ein
Symptom dieser Bauweise, nicht ihre Ursache: Nach seiner Behebung ändern sich die
Benchmark-Zahlen nicht.

## Das Modell

Ein Wert beschreibt, wie präsent eine Erinnerung ist: `memoryStrength`. Vier
Kräfte schieben ihn, jede mit einem eigenen Zuständigkeitsbereich.

1. **Kodierung** setzt den Startpunkt. Das LLM urteilt im stündlichen Cron über
   Emotion und Bedeutung; daraus folgen Anfangsstärke und Halbwertszeit.
2. **Blitzlicht** ist der Sonderfall der Kodierung. Oberhalb einer Schwelle aus
   Intensität und Bedeutung springt die Stärke auf 0,95 und die Halbwertszeit auf
   Jahre. Ohne Wiederholung, ohne Zutun des Agenten.
3. **Gebrauch** ist der zweite Weg nach oben: Jeder Abruf hebt Stärke und
   Halbwertszeit mit abnehmendem Ertrag. Wiederholung ist ein Weg, keine
   Voraussetzung.
4. **Zeit und Interferenz** drücken dagegen: exponentieller Zerfall, und neue
   ähnliche Erinnerungen schwächen ältere (`applyRetroactiveInterference`), was
   Alltagswiederholungen zu einem Schema verschmelzen lässt.

`importance` bleibt als Feld erhalten, aber nur noch als Urteil über Bedeutung
beim Kodieren. Es hat genau drei Abnehmer: die Blitzlicht-Schwelle, die
Promotion nach KNOWLEDGE.md und die Lektions-Regel in `computeRecallBoost()`
(starke negative Emotion plus hohe Bedeutung). Aus dem allgemeinen Ranking
verschwindet es.

### Die beiden Skalen

| | `importance` | `memoryStrength` |
|---|---|---|
| Bedeutung | wie bedeutsam | wie präsent |
| Quelle | LLM beim Kodieren; Agent von Hand | Kodierung, Gebrauch, Zerfall, Interferenz |
| Automatismen | höchstens 0,94 | keine Grenze |
| Agentenband | 0,95 bis 1,00, allein der Agent | existiert nicht |
| Blitzlicht setzt | nichts | 0,95 plus lange Halbwertszeit |

Die Trennung ist inhaltlich begründet: „hat sich eingebrannt" und „will ich
behalten" sind zwei verschiedene Vorgänge. Es gibt genug, woran man sich
erinnert, obwohl man lieber nicht würde.

## Komponenten

### 1. Schreibpfad: Bänder durchsetzen

Die Unterscheidung Agent gegen Automatismus existiert bereits als
`explicitImportance` — beide Agenten-Werkzeuge reichen sie durch, der
Capture-Pfad nicht. `computeMemoryImportance()` berechnet daraus schon `isExplicit`.

- Ohne `explicitImportance` wird das Ergebnis auf 0,94 begrenzt.
- `MANUAL_CORE_IMPORTANCE` sinkt von 1,0 auf 0,95, damit `applyDynamicsDefaults()`
  ab 0,95 tatsächlich `neverForget` und die Kern-Halbwertszeit setzt. Heute ist
  das Band eine Verabredung ohne Wirkung: Der Schutz hängt an `memoryClass` und
  `neverForget`, nicht an der Zahl.
- Die bestehenden Automatismen bei 0,9 (`reminder-store`, `wiki-command`,
  `promoted-memory-reindex`) bleiben unverändert zulässig.

Die Schlüsselwortlisten `DURABLE_MARKERS` und `TEMPORAL_MARKERS` und die daran
hängenden Böden entfallen mit dem LLM-Pfad. Frisch erfasste Zeilen bekommen
keinen geschätzten Zwischenwert, sondern die neutrale 0,5 und
`importanceStatus: "pending"` — ein halbgarer Schätzwert wäre wieder genau die
Heuristik, die hier abgelöst wird.

### 2. Kodierung: LLM im Tier-3-Call

Der `emotion-refine`-Cron läuft stündlich je Agent, holt Zeilen mit
`emotionStatus = 'pending_t3'`, höchstens 100 je Lauf, Frist 240 s, und lässt
Zeilen bei Provider-Ausfall stehen statt sie falsch zu bewerten.

Ergänzungen:

- Neue Spalte `importanceStatus`. Eigene Spalte, weil eine Zeile eine fertige
  Emotionsbewertung und eine offene Importance haben kann — bei allen
  Bestandszeilen ist das der Fall. Drei Zustände, und der mittlere ist wichtig:
  `pending` für frisch erfasste Zeilen, die der stündliche Cron nimmt;
  `pending_backfill` für Bestandszeilen, die **ausschließlich** das
  Backfill-Skript bearbeitet; `final`. Ohne diese Trennung würde der Cron nach
  Phase 1 den gesamten Rückstand Zeile für Zeile abarbeiten und dabei genau die
  23.000 Einzelversionen erzeugen, die Phase 2 vermeiden soll.
- Die Auswahl im Cron lautet damit
  `emotionStatus = 'pending_t3' OR importanceStatus = 'pending'`.
- Der Tier-3-Call klärt Emotion und Bedeutung in einer Anfrage und liefert
  zusätzlich eine kurze Begründung, die gespeichert wird. Das ist die
  Nachvollziehbarkeit, die heute fehlt.
- Eigener Einstiegspunkt neben `inferEmotionalValenceAsync()`, damit die
  bestehenden Aufrufer unverändert bleiben.
- Auswahl ohne Vorfilter: jede Zeile bekommt dieselbe Behandlung. Ein Vorfilter
  wäre wieder eine Heuristik und würde dasselbe Problem eine Ebene höher
  wiederholen.

**Das Fenster bis zur Klärung:** Bis der Cron gelaufen ist, zählt `importance`
als neutrale 0,5. Die Erinnerung ist auffindbar, nur nicht gewichtet. Das ist
vertretbar, weil sie in dieser Zeit in derselben Session ohnehin noch im
Kontextfenster steht — sie ist noch „jetzt". Die Ausnahme sind Cron-Turns und
andere Sessions mit leerem Fenster; dort greift die neutrale 0,5.

### 3. Recall

Die heutige Reihenfolge der Terme bleibt, bis auf einen:

| Term | heute | danach |
|---|---|---|
| Vektor-Ähnlichkeit | Basis | unverändert |
| Importance | `+ (importance − 0,5) × 0,3` | **entfällt** |
| Emotion | `× Faktor`, gedeckelt 0,9–1,1 | unverändert, inklusive Lektions-Regel |
| Stärke | `+ (memoryStrength − 1,0)` | unverändert |
| Epistemischer Status | `± 0,4` | unverändert |

Die Stärke ist bereits heute der schärfste Term: Eine zerfallene Erinnerung
bekommt bis zu minus eins auf einen Basiswert um 0,6 und fällt damit unter
`recallMinScore: 0.15`. Vergessen funktioniert also schon; die Verhaltensänderung
kommt aus der Kodierung, nicht aus der Ranking-Formel.

### 4. Halbwertszeiten

Heute aus einer Kategorien-Tabelle: transient 60 Tage (fact, general), episodic
180 (other), longContext und project je 600, Kern 36.500. Emotion verlängert über
`halfLife × (1 + Intensität × Faktor)`, also höchstens eine Verdopplung.

Künftig setzt die Kodierung die Halbwertszeit aus Bedeutung und Intensität statt
aus der Kategorie. Startwerte als Vorschlag, nach dem Pilotlauf zu prüfen:

| Kodierung | Halbwertszeit |
|---|---|
| beiläufig (importance < 0,4) | 30 Tage |
| normal (0,4 bis 0,7) | 180 Tage |
| bedeutsam (0,7 bis 0,94) | 600 Tage |
| Blitzlicht | 3.650 Tage |
| Agentenband ab 0,95 | 36.500 Tage (Kern) |

Die Blitzlicht-Halbwertszeit von zehn Jahren ersetzt die heutigen 90 Tage in
`applyFlashbulbEncoding()` — drei Monate sind kein Einbrennen.

### 5. Tote Pfade anschließen

`applyFlashbulbEncoding()` ist implementiert und getestet, wird aber im gesamten
Paket **nirgends aufgerufen** (nur in der eigenen Datei und in zwei Testdateien).
Der Mechanismus für einmalige einschneidende Ereignisse existiert also, ist aber
nie verdrahtet worden. Er wird an den Kodierungspfad angeschlossen.

`computeFlashbulbScore()` ist heute `0,5 × Intensität + 0,5 × Importance` bei
Schwelle 0,70 — die Hälfte des Auslösers hängt damit an dem Wert, der bei drei
Vierteln aller Zeilen 0,70 beträgt. Mit einer echten Verteilung wird die Formel
erst sinnvoll; die Schwelle ist nach dem Pilotlauf zu justieren.

## Migration des Bestands

Rund 23.000 aktive Zeilen tragen Werte aus dem alten Verfahren. Eine Stichprobe
von 800 Zeilen auf 0,70 ergab beim Nachrechnen: 195 blieben, 303 fielen auf 0,65,
295 auf 0,45.

**Phase 1 — ohne LLM, Minuten.** Rund 320 Zeilen mit `origin: memory-md-migration`
und fünf mit `origin: cron` stehen auf 0,95, ohne je einzeln bewertet worden zu
sein; sie gehen auf 0,94. Zeilen mit `origin: dm` bleiben unangetastet, das waren
Entscheidungen der Agenten. **Erst danach** darf `MANUAL_CORE_IMPORTANCE` sinken,
sonst werden genau diese Altlasten unsterblich. Anschließend bekommen alle aktiven
Zeilen `importanceStatus: "pending_backfill"` — nicht `pending`, damit der
stündliche Cron sie liegen lässt und Phase 2 sie in Stapeln bearbeiten kann.

**Phase 2 — Backfill als eigenes Skript.** Nicht über den stündlichen Cron: Der
ist mit 100 Zeilen je Lauf für den laufenden Betrieb ausgelegt, und sein
`update` je Zeile erzeugt je Zeile eine LanceDB-Version. 23.000 Versionen sind
genau die Fragmentierung, die am 13.09.2026 zu Gateway-Blockaden von bis zu 143 s
geführt hat.

| | stündlicher Cron | Backfill-Skript |
|---|---|---|
| LLM-Calls | nacheinander | parallel, Breite 8 |
| Schreiben | `update` je Zeile | `mergeInsert` in Stapeln zu 500 |
| Versionen bei 23.000 Zeilen | 23.000 | etwa 46 |
| Laufzeit | 9 Tage | gut eine Stunde |

Bedingungen: ruhiges Fenster, weil gleichzeitige Gateway-Updates die
Stapelschreibvorgänge verdrängen („Rewrite transaction was preempted"), und
danach einmal `lancedb-compact-once.mjs`.

Regeln für den Backfill: Die Stärke wird nie gesenkt — ein Modellurteil darf nicht
nachträglich löschen, was der Agent seit Monaten benutzt. Halbwertszeiten wirken
nur nach vorn. Der alte Wert wandert nach `updateEvidence`, zusammen mit
`updateSource: "importance-v2"`; beide Spalten existieren und machen jede
Änderung einzeln rückrechenbar. Vorher ein Snapshot über
`scripts/backup-snapshot.sh`.

**Phase 3 — erst danach** Interferenz und Blitzlicht scharf schalten. Beide
setzen brauchbare Eingangswerte voraus.

**Pilot:** Subagenten-Store `developer` mit 188 Zeilen. Echte Daten, kein Nutzer,
der es merkt. Prüft die ganze Kette in Minuten: Antwortformat, Stapelschreiben,
Rückrechenbarkeit, Verdichtung.

## Prüfung

**Bausteine, testgetrieben.** Deckel bei 0,94; Kopplung 0,95 auf `neverForget`;
Verdrahtung der Blitzlicht-Kodierung; Statuswechsel der Warteschlange;
Stapelschreiben mit Rückrechenbarkeit; Wegfall des Importance-Terms im Ranking.

**Verhalten, deterministisch mit künstlicher Zeit.** Diese drei Fälle sind die
eigentliche Abnahme:

1. Vierzehn ähnliche Frühstücksnotizen an vierzehn Tagen. Nach zwei Wochen darf
   die einzelne Episode nicht mehr auffindbar sein.
2. Ein Einmalereignis mit hoher Intensität. Nach zehn simulierten Jahren ohne
   einen einzigen Abruf muss es oberhalb der Recall-Schwelle liegen.
3. Ein schwach kodierter Sachverhalt, zwanzigmal abgerufen. Muss nach einem Jahr
   noch da sein.

**Leitplanke.** LOCOMO und LongMemEval vorher und nachher über
`/root/plur1bus-bench`. Bestehen heißt: keine Verschlechterung über zwei Punkte
hinaus. Verbesserung wird nicht erwartet.

**Betrieb.** Drei Kennzahlen vorher und nachher:

| Kennzahl | heute | Erwartung |
|---|---|---|
| häufigster Importance-Wert | 71 % auf 0,70 | kein Wert über 25 % |
| Blitzlicht-Rate | 0 %, nicht verdrahtet | unter 2 % der neuen Erinnerungen |
| Promotionen nach KNOWLEDGE.md je Woche | zu erheben | beobachten |

Die Blitzlicht-Rate ist der heikelste Parameter: Liegt sie über zwei Prozent,
entstehen im Wochentakt unvergessliche Belanglosigkeiten.

## Offene Parameter

Bewusst erst nach dem Pilotlauf festzulegen: die Blitzlicht-Schwelle, die
Halbwertszeiten der Kodierungsbänder, die Dämpfung des Gebrauchsterms und die
Parameter der Interferenz (heute Schwelle 0,65 Ähnlichkeit, Faktor 0,9, höchstens
fünf betroffene Zeilen je neuer Erinnerung).

## Nicht Bestandteil

Die Recall-Architektur selbst, Dreaming, das Format von KNOWLEDGE.md, der
Merge-Pfad und die Dedup-Schwelle beim Capture (`duplicateThreshold: 0.95`;
gemessen konservativ und korrekt: entspricht cos ≥ 0,9737 und feuerte in 419
echten Dialog-Turns kein einziges Mal).
