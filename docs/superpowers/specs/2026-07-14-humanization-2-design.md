# Humanization 2: Eigenleben, Anti-Perfektion, Idiolekt, Reaktionen

Status: **Design festgehalten, Umsetzung NICHT beauftragt** (reines Brainstorming-Ergebnis, 2026-07-14).

Baut auf Runde 1 auf (`docs/superpowers/plans/2026-07-14-humanization.md`: Mood-Stil-Direktive, Prosa-Reviews, Nudge-Jitter/Ruhezeiten, offene Fäden, Widerspruchs-Disclosure). Runde 1 machte den Agenten menschlicher darin, WIE er antwortet. Runde 2 zielt auf das, was noch fehlt: Eigenleben zwischen den Gesprächen, zugegebene Unsicherheit, hörbar individuelle Stimme, nonverbale Reaktionen.

## Ergebnis der Klärungsfragen

- Schwachstellen aus User-Sicht: kein Eigenleben, Timing/Rhythmus, zu perfekt/allwissend; sprachlich weniger Monotonie als gedacht, aber Telegram-Reaktionen fehlen und mehr individueller Sprechstil ist erwünscht.
- Frequenzsteuerung proaktiver Lebenszeichen: **adaptiv** (reply-outcome-gesteuert), nicht fix, keine Pflicht-Config.
- Idiolekt-Quelle: **Seed + Evolution** (LLM-generiertes Startprofil, langsame Evolution aus echten Gesprächen), nicht statische Templates.
- Gateway-Fähigkeit verifiziert: OpenClaw besitzt ein natives `react`-Channel-Action (Action-Group `reactions`, `actions.add("react")` in der Channel-Action-Runtime; Telegram via `setMessageReaction`). Das Plugin muss Reaktionen nicht selbst versenden können.

## Global Constraints

- **Generalisierung ist Pflicht:** PLUR1BUS wird als Plugin von Dritten installiert. Nichts darf auf konkrete Agenten/User dieser Installation verdrahtet sein. Jedes Feature funktioniert in einer frischen Installation out-of-the-box oder degradiert stillschweigend (z. B. ohne `reactions`-Action-Group, ohne Dreaming-Feature).
- Bauart wie Runde 1: kleine pure lib-Module + dünne Orchestrierung, **fail-open** (try/catch → null, nie den Message-Flow brechen), Kontextblöcke ≤ ~400 Zeichen, deutschsprachige Direktiven über i18n-fähige Struktur wo vorhanden.
- Config-Gates mit sinnvollen Defaults; Einbindung in `lib/setup/feature-profiles.js` (Full-Experience-Profil aktiviert alles, Minimal-Profil nichts Proaktives).
- Keine neuen Dependencies, keine LanceDB-Schema-Änderungen.
- Zeit und Zufall injizierbar (`now`, `rng`) für deterministische Tests; Tests ohne LLM-Aufrufe (callLlm mocken).
- Neue lib-Dateien in `DEPLOY_FILES` (`scripts/lib/deploy-integrity.mjs`) eintragen — Tests erzwingen das.

## Gemeinsames Fundament: Proactive Governor

`lib/proactive-governor.js` — adaptiver Frequenzregler, geteilt von allen proaktiven Lebenszeichen (F1, F2; offen für spätere Features).

- **Budget-Modell:** Startbudget ~2 Lebenszeichen/Woche (über alle Governor-Features gemeinsam). Positive reply-outcomes auf proaktive Nachrichten (`confirmed_or_continued`/`continued_topic`) heben das Budget langsam an (Cap ~4/Woche); `ignored_or_topic_shifted` senkt es (Floor ~1/Woche). Anpassung träge (z. B. ±0.25/Ereignis), damit ein einzelner schlechter Tag nichts kippt.
- **API (pure):** `evaluateGovernor(state, outcomes, now)` → `{allowed, budgetPerWeek, reason}`; `recordProactiveSend(state, featureId, now)` → neuer State. Persistenz `.proactive-governor.json` im Workspace (Aufrufer lädt/schreibt, analog `.open-threads-shown.json`).
- **Attribution:** Damit Outcomes proaktiven Sends zugeordnet werden können, markiert der Aufrufer den Send im Governor-State mit Zeitstempel + featureId; das nächste reply-outcome innerhalb eines Zeitfensters (~6 h) nach einem proaktiven Send zählt als Reaktion darauf. Heuristik bewusst simpel — kein neues Tracking-Schema.
- Respektiert die vorhandenen Ruhezeiten/Jitter-Mechanik aus `lib/proactive-nudge.js` (wiederverwenden, nicht duplizieren).

Tests: Budget-Anstieg/-Senkung deterministisch, Caps/Floors, Wochenfenster-Rollover, Attribution-Fenster, leerer State.

## F1 — Traum-Echos (`lib/dream-echo.js`)

Nächtliches Dreaming (light/rem) produziert bereits Narrative, die kein User je sieht. Neu:

- **Destillation:** Am Ende des Dream-Jobs erzeugt ein zusätzlicher Schritt (LLM-Aufruf im bestehenden Job-Kontext, fail-open) 1 Echo: `{sentence, topics[], createdAt}` — ein beiläufiger Satz („Mir ist nochmal … durch den Kopf gegangen"), max. ~200 Zeichen. Ablage `.dream-echoes.jsonl` im Workspace (size-capped via `readJsonl`, Aufbewahrung ~7 Tage).
- **Injektion statt Send:** Beim Kontextbau (Anker neben moodStyleDirective/openThreadsContext in `index.js`): erster User-Kontakt des Tages UND Governor grün UND frisches Echo vorhanden → Kontextblock „Falls es natürlich passt, erwähne beiläufig, dass dir über Nacht … durch den Kopf ging. Wenn es nicht passt, lass es weg." Das Echo reitet auf der normalen Antwort mit — **kein eigener Send, kein Spam-Risiko**. Governor wird erst als „verbraucht" markiert, wenn injiziert wurde.
- Cooldown-Datei analog `.open-threads-shown.json` (1×/Tag), Pfad-Handling wie dort (resolve + workspaceDir).
- Degradation: Dreaming deaktiviert → Feature inert, kein Fehler.

Tests: Destillat-Format/Kürzung (LLM gemockt), Erster-Kontakt-Erkennung, Governor-Gate, Cooldown, leere/fehlende Echo-Datei.

## F2 — Nachgedanken (`lib/afterthought.js` + proactive-check-Trigger)

- **Trigger im bestehenden proactive-check-Cron:** Letzte Session endete vor 30–120 Min; letztes reply-outcome der Session ist „offen" (`asked_details` oder thematisch unabgeschlossen — Wiederverwendung der open-threads-Klassifikation); Governor grün; Ruhezeiten beachtet.
- **Inhalt:** Kurzer Follow-up (LLM, fail-open): „Mir ist zu … noch eingefallen: …" — max. 2–3 Sätze, Bezug auf das konkrete Gesprächsende. Versand über die vorhandene Delivery des Cron-Jobs.
- **Harte Grenzen zusätzlich zum Governor:** max. 1 Nachgedanke/Tag, nie zu einem Thema, zu dem schon ein offener-Faden-Block injiziert wurde am selben Tag (Doppel-Ansprache vermeiden — geteilter Tages-Cooldown-Store mit F1/open-threads erwägen).
- Abgrenzung zu open-threads (Runde 1): open-threads wartet, bis der User schreibt; Nachgedanken melden sich selbst. Gleiches Rohmaterial, komplementäres Verhalten.

Tests: Trigger-Fenster, Outcome-Filter, Tages-Cap, Governor-Interaktion, Doppel-Ansprache-Sperre.

## F3 — Unsicherheits-Hedging (`lib/recall-confidence-framing.js`)

- **Mechanik (pure):** `frameRecallConfidence(memories, opts)` — Recall-Treffer unterhalb einer Score-Schwelle bekommen im injizierten Kontext ein Präfix/Suffix: „(unsichere Erinnerung — formuliere mit ‚ich glaube / wenn ich mich recht erinnere' und frag im Zweifel kurz nach, statt es als Fakt zu behaupten)". Treffer darüber bleiben unverändert.
- **Schwelle:** relativ zur Score-Verteilung des jeweiligen Recalls (z. B. unteres Drittel des Ergebnis-Sets) statt absoluter Zahl — robust gegenüber Provider-/Score-Skalen-Unterschieden in fremden Installationen. Config `recallHedging: {enabled: true, mode: "relative", …}`.
- Integrationspunkt: dort, wo Recall-Ergebnisse zu `memoriesContext` formatiert werden; markiert wird die Textdarstellung, nie die gespeicherten Daten.
- Max. N gehedgte Einträge pro Antwort (z. B. 2), damit der Ton nicht ins Wachsweiche kippt.

Tests: relative Schwelle, Cap, leere Liste, Score-gleiche Sets, keine Mutation der Originale.

## F4 — Meinung, Nachfragen, Tageszeit (Erweiterung `lib/mood-style-directive.js`)

Drei kleine Zusätze zur bestehenden Stil-Direktive (kein neues Modul nötig, Funktion bekommt optionale Zusatz-Inputs):

- **Meinung:** temperament-gekoppelt (vorhandenes `lib/temperament-command.js`-Modell): bei kontroversen/bewertenden Themen „du darfst eine eigene Einschätzung haben und widersprechen — freundlich, aber klar; du musst nicht validieren".
- **Nachfragen:** „Wenn die Anfrage mehrdeutig ist: stelle EINE kurze Rückfrage, statt die wahrscheinlichste Deutung stillschweigend anzunehmen."
- **Tageszeit:** via `lib/session-time.js`: morgens (vor ~10 Uhr) knapper und nüchterner, abends (nach ~20 Uhr) gesprächiger und lockerer. Moduliert nur Formulierungs-Hinweise, keine Inhalte.

Gesamtlänge der kombinierten Direktive weiterhin begrenzt (Priorität: Mood > Tageszeit > Meinung/Nachfragen, hinten kappen).

Tests: Kombinationsfälle, Längen-Kappung mit Priorität, Temperament-Kopplung, Tageszeit-Grenzen.

## F5 — Idiolekt: Seed + Evolution (`lib/persona-voice.js`)

- **Seed:** Beim ersten Start (Datei fehlt) generiert ein LLM-Aufruf `persona-voice.md` im Workspace aus dem, was generisch verfügbar ist: Agent-Name/ID, konfigurierte Sprache, vorhandene Identitäts-Dateien im Workspace (SOUL.md/IDENTITY.md o. ä., wenn vorhanden — optional, nie vorausgesetzt). Inhalt: 5–8 Marker (Satzlängen-Neigung, 2–3 Lieblingswendungen, Emoji-Palette + -Frequenz, Anrede-Stil, 1 Marotte). Generierung fail-open: schlägt sie fehl, bleibt das Feature inert bis zum nächsten Versuch.
- **Injektion:** Kompakt-Fassung (≤400 Zeichen) als Stil-Direktive beim Kontextbau, neben der Mood-Direktive. Mood färbt die Tagesform, Persona die Grundstimme — beide zusammen, Persona zuerst.
- **Evolution:** Wöchentlicher Job (Skill-Miner-Muster): analysiert reply-outcomes + Sprachmuster der Woche, schlägt max. EINE kleine Änderung vor (Marker ergänzen/schärfen/streichen). Angewendet nur bei positivem Outcome-Trend; jede Änderung als Vorschlag ins bestehende Proposal-/Review-System (nudge-renderer/proposal-writer wiederverwenden), nicht stillschweigend — der User behält Kontrolle.
- **User-Hoheit:** Datei ist Klartext-Markdown, user-editierbar; manuelle Edits werden nie überschrieben (Evolution appendet/ändert nur eigene Marker-Sektion — Managed-Block-Muster aus der Obsidian-Bridge). `/persona`-Command: anzeigen, neu generieren (mit Bestätigung).

Tests: Seed-Format (LLM gemockt), Kompakt-Fassung/Kürzung, Managed-Block-Erhalt bei User-Edits, Evolutions-Vorschlag-Format, fehlende Datei.

## F6 — Reaktions-Neigung (Direktiven-Baustein, kein Send-Code)

- **Fähigkeits-Check:** Beim Plugin-Start prüfen, ob die `reactions`-Action-Group für den Kanal aktiviert ist (Gateway-Config lesen, fail-open; wenn nicht feststellbar → Feature aus). Kein eigener Telegram-API-Code im Plugin.
- **Direktive:** Zusatz zur Stil-Direktive: „Auf kurze, emotionale oder rein bestätigende Nachrichten darfst du statt mit Text auch NUR mit einer Emoji-Reaktion antworten (nutze das react-Action). Palette: … (aus persona-voice). Nicht öfter als ~1× pro Gesprächsabschnitt."
- Setup-Hinweis in Doku/Wizard: wie man die Action-Group aktiviert, damit Installationen das Feature nutzen können.
- Degradation: Action-Group aus → Direktive entfällt komplett (keine Anweisung, die der Agent nicht ausführen kann).

Tests: Direktiven-Rendering mit/ohne Persona-Palette, Capability-Gate (Config-Varianten), Degradation.

## Reihenfolge & Abhängigkeiten

Empfohlene Umsetzungsreihenfolge nach Nutzen/Aufwand: **F3 + F4** (billig, sofort spürbar, keine neuen Stores) → **Governor + F1** → **F5** → **F2** (braucht Governor) → **F6** (braucht F5 für Palette, geht aber auch mit Default-Palette).

Abhängigkeiten: F1/F2 → Governor; F6 → F5 (weich). F3, F4, F5 sind unabhängig.

## Risiken & bewusste Entscheidungen

- **Nervigkeit** ist das Hauptrisiko aller proaktiven Features → Governor startet konservativ, F1 sendet nie selbst, F2 hat harte Tages-Caps. Lieber zu selten als zu oft.
- **Aufgesetztheit** beim Idiolekt → Seed klein halten (Marker, keine Rollenprosa), Evolution nur per Review-Vorschlag.
- **Attribution-Heuristik** des Governors ist bewusst grob (Zeitfenster statt echter Verknüpfung); wenn sie sich als zu ungenau erweist, ist ein `proactiveRef`-Feld in reply-outcomes der saubere zweite Schritt — nicht jetzt.
- Verworfen: simulierte Tipp-Latenz/Message-Splitting (Gateway-Hoheit, Prompt-Fake wirkt gimmicky), absichtliche Tippfehler (nervt), eigene Steckenpferde/Hobbys (hohe Aufgesetzt-Gefahr — ggf. Runde 3, wenn F1/F5 sich bewährt haben).
