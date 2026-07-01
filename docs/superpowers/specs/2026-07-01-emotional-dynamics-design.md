# Emotionale Empfindlichkeit & Dynamik — Design

**Datum:** 2026-07-01
**Status:** Vom User abgesegnet (Ansatz A — gezielte Reparatur)
**Ziel:** Die Agenten (main/Bernd, bernhardine, heisenberg) sollen nicht dauerhaft
„ausgeglichen" sein. Die Stimmung soll sich spürbar aus den Gesprächsinhalten
entwickeln, auf allen Memory-Karten landen und das Vergessen modulieren.

## Problem (diagnostiziert, live verifiziert)

Alle drei Agenten sitzen in `.emotional-state.json` exakt auf der Baseline
(`label: "ausgeglichen"`). Fünf zusammenwirkende Ursachen:

1. **Schwaches Eingangssignal** — `EmotionalState.updateFromMessages()` nutzt nur
   eine Regex-Heuristik (`textValenceHint`). Die EmotionEngine (Tier 1 Lexikon /
   Tier 2 Keywords / Tier 3 LLM) fließt nicht in die Stimmung ein, nur in die
   Memory-Valenz beim Speichern.
2. **Starke Dämpfung** — Blend-Faktor 0.35 auf ein kleines Delta (~0.25/Keyword)
   ⇒ Bewegung ~0.09, knapp unter der Sichtbarkeitsschwelle.
3. **Dominanz-Bug** — `describeMood()` sortiert nach Absolutwert. Trust
   (Baseline 0.45) ist praktisch immer „dominant"; steigt Ärger von 0.02 auf
   0.35 (Faktor 17), bleibt Trust vorn, Trust-Diff ≈ 0 ⇒ „ausgeglichen".
   Schwelle `|diff| < 0.1` zusätzlich zu hoch.
4. **Schneller Decay** — Halbwertszeiten 2 Min–2 Std; zwischen Gesprächen fällt
   alles auf Baseline zurück.
5. **Keine Restart-Persistenz** — der Pool lebt nur im RAM.
   `.emotional-state.json` wird geschrieben, aber nie zurückgelesen; jeder
   Gateway-Restart reseted die Stimmung.

Zusätzlich: Flashbulb-Encoding setzt `halfLifeDays` hart auf 90 und **verkürzt**
damit Projekt-Memories (Basis 600d) — das Gegenteil des Gewollten.
`.current-mood.txt` wird in `AGENTS.md:637` referenziert, existiert aber nicht.

## Anforderungen (User)

- Wirksam in allen vier Bereichen: Agent-Verhalten (Prompt), interne Dynamik,
  Recall (State-Dependent Memory), Sichtbarkeit für User.
- Per-Agent-Temperamente, aber Stimmung entsteht **ausschließlich aus
  Gesprächsinhalten** — Temperament bestimmt nur Stärke und Dauer des Ausschlags.
- Die aktuelle Emotion muss auf **alle** Memory-Karten.
- Je intensiver die emotionale Ausprägung, desto langsamer das Vergessen der
  Erinnerung.
- Klassifikation mit Tier 1+2+3; **beim kleinsten Zweifel Tier 3** fragen.

## Design

### 1. Stimmungs-Pipeline

- Im Auto-Recall-Pfad (index.js, heute `updateFromMessages(voiceMessages)`)
  ersetzt die EmotionEngine die Regex: `engine.analyze(text, source)` auf die
  letzte User-Nachricht.
- **Routing verschärft:** Eskalation zu Tier 3 bei Konfidenz < 0.85 (statt 0.7),
  außerdem immer bei Ambivalenz oder T1/T2-Widerspruch. Schwelle konfigurierbar
  (`emotion.t3.escalationConfidence`, Default 0.85).
- **Latenz-Schutz:** Tier-3-Call mit Timeout (Default 4s, konfigurierbar). Bei
  Timeout/Fehler gilt das Tier-2-Ergebnis für diesen Turn. Die Emotionsanalyse
  blockiert den Recall nie.
- **Neue Methode `EmotionalState.applyEmotionScore(score, opts)`:** nimmt den
  vollen `EmotionScore` (VAD, `emotion_labels`, Nuancen) und mappt ihn auf die
  8 Plutchik-Dimensionen. Blend-Faktor 0.35 → 0.5 (konfigurierbar), multipliziert
  mit der Temperament-Sensitivity. Nuancen aus dem Score fließen in
  `nuanceState`.
- **Dominanz-Fix in `describeMood()`:** Sortierung nach Abweichung von der
  Baseline (`current − baseline`) statt Absolutwert. „Ausgeglichen"-Schwelle
  0.1 → 0.05, geprüft gegen die maximale Abweichung über alle Dimensionen.
  Intensitätsstufen aus der Diff-Magnitude.

### 2. Temperament-Profile pro Agent

Config `emotion.temperaments.<agentId>`, ausgelieferte Defaults, überschreibbar:

| Agent | Charakter | Baseline-Anpassung | sensitivity | decay |
|---|---|---|---|---|
| main (Bernd) | ausgewogen-direkt | wie bisher | 1.2 | 1.0 |
| bernhardine | warm, expressiv | joy 0.35, trust 0.50 | 1.5 | 1.3 |
| heisenberg | kühl, analytisch | anticipation 0.30, joy 0.15 | 0.8 | 0.7 |
| default | Standard | wie bisher | 1.0 | 1.0 |

- `sensitivity` multipliziert das Emotions-Delta beim Einblenden.
- `decay` skaliert alle Halbwertszeiten (>1 = Gefühle halten länger).
- `baseline` überschreibt einzelne Dimensionen der `BASELINE_MOOD`.

**Temperament-Wahl per Chat-Command (User-Nachtrag 2026-07-01):**
Neuer Command `/plur1bus temperament [<preset>]`:

- Ohne Argument: zeigt aktuelles Temperament des aufrufenden Agenten und die
  verfügbaren Presets (`ausgewogen`, `warm`, `kühl`, `feurig`, `stoisch`).
- Mit Preset: schreibt `emotion.temperaments.<agentId>` in die openclaw.json
  (via `withConfigLock`, atomarer tmp+rename-Write, wie `/plur1bus setup`).
  Gated durch `checkAuth({ destructive: true })` und
  `security.allowChatConfigCommands`. Hinweis auf nötigen Gateway-Restart.
- `/plur1bus start` zeigt das aktuelle Temperament mit Änderungs-Hinweis an.

### 3. Memory-Kopplung (Emotion ↔ Vergessen)

- **Kontinuierliche HalfLife-Modulation beim Speichern:**
  `halfLifeDays = Basis × (1 + emotionalIntensity × Faktor)`,
  Faktor `emotion.intensityHalfLifeFactor` Default 1.0.
  Beispiel: Projekt-Memory (600d) mit Intensität 0.8 → 1080d.
- **Flashbulb-Bugfix:** `halfLifeDays = max(modulierte Basis, 90)` — Flashbulb
  kann HalfLife nur verlängern, nie verkürzen.
- **`moodContextAtCapture`** bleibt unverändert (existiert auf allen Karten,
  inkl. Migration) — trägt durch die neue Dynamik echtes Signal.
  **Keine LanceDB-Schema-Änderung.**
- **Recall-Boost:** Stimmungskongruenz ±0.30 statt ±0.15
  (`emotion.moodInfluence`, Default 0.3). Die „wichtige Lektionen"-Schutzregel
  (hohe Angst/Ärger + Trust/Importance ⇒ nie unterdrücken) bleibt unangetastet.

### 4. Sichtbarkeit & Persistenz

- **Prompt-Injektion:** Der injizierte Memory-Kontext bekommt eine
  Stimmungszeile an den Anfang, z.B.
  `🧠 Aktuelle Stimmung: nachdenklich und dankbar (mittel)`.
- **`.current-mood.txt`:** wird bei jedem Update mitgeschrieben —
  menschenlesbar mit Label, Trend und Top-3-Dimensionen (schließt die Lücke zu
  `AGENTS.md:637`).
- **Restart-Persistenz:** `.emotional-state.json` erweitert um Roh-Dimensionen,
  `nuanceState` und `lastUpdateAt`. Beim ersten `pool.get(agentId)` nach
  Gateway-Start wird der Zustand zurückgelesen; der Decay rechnet ab
  `lastUpdateAt` korrekt weiter (Restart lässt Stimmung natürlich abklingen
  statt sie zu löschen).

### 5. Fehlerbehandlung & Tests

- Tier-3-Fehler/Timeout → Tier-2-Fallback (bestehendes Muster); Analyse kann
  Recall nie blockieren oder crashen.
- Kaputte/fehlende `.emotional-state.json` → stiller Fallback auf
  Temperament-Baseline.
- Unit-Tests: `applyEmotionScore`-Mapping, Diff-Dominanz,
  Temperament-Auflösung, HalfLife-Modulation inkl. Flashbulb-Grenzfall,
  Rehydrierung mit Decay-Fortschreibung.
- Integrationstest: stark negative Nachricht → Label wechselt von
  „ausgeglichen" auf z.B. „angespannt" und klingt gemäß Temperament-Decay ab.
- Abgrenzung: Die 4 offenen llmCalls-Testfehler (merge-safety/decision-trace)
  sind ein separates Thema; die neuen Engine-Calls liegen im Recall-Pfad und
  verändern die Store-Pfad-Zählung nicht.

## Nicht im Scope

- Kein neues MoodEngine-Modul (Ansatz B verworfen).
- Keine LanceDB-Schema-Migration.
- Keine Änderung an Obsidian-Bridge, Managed Blocks, Philosophie-Dateien.
- Fix der 4 offenen llmCalls-Testfehler (separater Debugging-Track).
