# Design-Spec: Conversation Reactivation Recall (Warm-Recall)

> **Arbeitsname:** Conversation Reactivation Recall / First-User-Turn Warm Recall / Associative Warm-Recall
> **Scope:** Design-Spec, noch keine Implementierung.
> **Ziel:** Einen menschlicher wirkenden, graduierten Warm-Recall entwerfen, der bei Gesprächsreaktivierung (nicht beim nackten technischen Session-Start) kurz Orientierung schafft.

---

## 1. Kurzbeschreibung des Features

`Conversation Reactivation Recall` (CRR) ist ein zusätzlicher, gedeckelter Recall-Pass, der läuft, wenn der User nach einer längeren Pause, nach Context-Compaction oder nach dem Start einer neuen technischen Session **tatsächlich eine erste sinnvolle Nachricht** schreibt. Er erzeugt keinen zusätzlichen Prompt-Block für den User, sondern einen internen Orientierungsblock für den Agenten, der diesem sagt:

- welche Erinnerungen stark und direkt passen (kann sichtbar erwähnt werden),
- welche mittel-/schwach-sicher sind (nur vorsichtig/vage formulieren),
- was nur als leise Orientierung dient (nicht sichtbar).

CRR ergänzt den normalen Auto-Recall, ersetzt ihn nicht. Es soll vor allem verhindern, dass der Agent bei Wiederaufnahme eines Gesprächs klinisch „kalt“ wirkt, ohne dabei Fakten zu erfinden oder schwache Treffer als sichere Erinnerung zu verkaufen.

---

## 2. Warum „Session-Start“ als Haupttrigger falsch ist

- Beim reinen technischen Session-Start liegt noch kein User-Input vor. Ein Recall ohne Such-Seed ist entweder leer, zufällig oder so allgemein, dass er keine echte Orientierung liefert.
- Eine technische Session kann Stunden oder Tage offen bleiben, während ein echtes Gespräch vielleicht nur 20–45 Minuten dauert.
- Der relevante Bezugspunkt ist daher nicht der Prozess-/Session-Start, sondern die **Konversations-Episode** und ihre **Reaktivierung** nach Inaktivität oder Kontextverlust.

**Folge:** CRR triggert erst beim ersten User-Turn nach Start/Pause/Compaction, sobald ein konkreter Such-Seed existiert.

---

## 3. Besseres Trigger-Modell: first user turn after start/idle/compaction

CRR triggert nur, wenn **alle** folgenden Bedingungen erfüllt sind:

1. Ein User-Turn liegt vor (nicht beim technischen Session-Start).
2. Der Turn ist inhaltlich substanziell (z. B. `>= minSeedChars` Zeichen, nicht nur „ja“, „ok“, „mach“, „weiter“).
3. Einer der folgenden Reaktivierungsgründe gilt:
   - Es gibt noch kein `lastUserTurnAt` (erster User-Turn nach technischem Start).
   - `lastUserTurnAt` liegt länger als `idleThresholdMinutes` zurück.
   - `lastCompactionAt` ist neuer als `lastWarmRecallAt`.
   - (optional) starker Themenwechsel mit dünnem normalem Recall.
4. Kein aktiver Cooldown (`warmRecallCooldownMinutes` seit `lastWarmRecallAt`).
5. Das Episode-Limit `maxWarmRecallsPerConversationEpisode` ist nicht erreicht.
6. Der Feature-Flag ist aktiv.
7. Der gleiche Seed wurde nicht gerade erst verarbeitet (Idempotenz via Hash).

**Nicht triggern bei:**
- nacktem technischen Sessionstart ohne User-Input,
- jedem weiteren Turn innerhalb einer Episode,
- kurzen Fortsetzungsantworten,
- gerade erst gelaufenem Warm-Recall,
- sehr starkem/eindeutigem normalem Recall (dann reduziertes Budget oder Skip),
- rein administrativen/irrelevanten Turns ohne konkretes Thema.

---

## 4. Conversation-Episode- und Cooldown-Modell

### State-Felder (pro Workspace/Agent)

| Feld | Typ | Bedeutung |
|------|-----|-----------|
| `lastUserTurnAt` | number (ms) | Zeitstempel des letzten User-Turns |
| `lastAssistantTurnAt` | number (ms) | Zeitstempel des letzten Agent-Turns |
| `lastWarmRecallAt` | number (ms) | Zeitstempel des letzten CRR-Laufs |
| `lastCompactionAt` | number (ms) | Zeitstempel der letzten Context-Compaction |
| `currentConversationEpisodeId` | string | UUID der aktiven Episode |
| `conversationEpisodeStartedAt` | number (ms) | Startzeit der aktuellen Episode |
| `idleThresholdMinutes` | number | Schwellwert für Inaktivität (Default 45) |
| `warmRecallCooldownMinutes` | number | Mindestabstand zwischen CRR (Default 30) |
| `maxWarmRecallsPerHour` | number | Limit pro Stunde (Default 2) |
| `maxWarmRecallsPerConversationEpisode` | number | Limit pro Episode (Default 1) |
| `lastWarmRecallSeedHash` | string | Hash des letzten Seeds |
| `lastWarmRecallMode` | string | Modus des letzten CRR |
| `lastWarmRecallConfidence` | number | Confidence des letzten CRR |

### Beispielregeln

- Kein `lastUserTurnAt` → erster User-Turn triggert CRR.
- `now - lastUserTurnAt > idleThresholdMinutes * 60_000` → nächster User-Turn triggert CRR.
- `lastCompactionAt > lastWarmRecallAt` → nächster substanzieller User-Turn triggert CRR.
- `now - lastWarmRecallAt < warmRecallCooldownMinutes * 60_000` → kein CRR.
- `seedHash === lastWarmRecallSeedHash` → kein CRR.
- Inhalt zu kurz/inhaltsarm → kein CRR.
- `warmRecallsThisEpisode >= maxWarmRecallsPerConversationEpisode` → kein CRR.
- `warmRecallsThisHour >= maxWarmRecallsPerHour` → kein CRR.

### Episoden-Wechsel-Logik

Eine neue Conversation-Episode beginnt, wenn:
- keine `lastUserTurnAt` existiert (frisch nach Start), oder
- die Idle-Zeit `idleThresholdMinutes` überschreitet, oder
- eine Context-Compaction stattgefunden hat.

Die Episode-ID wird mit einem neuen UUID ersetzt und `conversationEpisodeStartedAt` auf `now` gesetzt.

---

## 5. Datenquellen

CRR zieht gezielt breitere Quellen als der normale Auto-Recall heran, gewichtet sie aber streng nach Sicherheit:

| Quelle | Verwendung | Hinweis |
|--------|-----------|---------|
| LanceDB Memories (Vektor) | Primärquelle für direkte Treffer | Limitiertes Budget |
| Normaler Auto-Recall | Eingangsergebnisse, die CRR anreichert/evtl. überspringt | Nicht doppelt injizieren |
| KNOWLEDGE.md / canonical memory | Bestätigungs-/Canonical-Quelle | Kann `direct_memory` boosten |
| Episoden / episode records | episodische Stütze, Vividness | Mittel bis schwach |
| Memory Graph (Neo-Store) | graph-nahe Assoziationen | Nur likely/faint, nicht direct |
| Obsidian Graph Links / Wikilinks | semantische Nachbarschaft | Mittel |
| semantic link index | ähnliche Records | Mittel |
| faded / very-faded memories | nur mit starker Strafung | Tendiert zu faint/silent |
| Interpretation Overlays | Bedeutungsverschiebungen, Confidence-Anpassung | Kann Confidence senken/erhöhen |
| Contradiction Tracking | Widerspruchsstrafe | Senkt Confidence |
| zuletzt aktive Themen / session-time | Zeitkontext | Orientierung, kein Recall-Ersatz |
| Proactive Nudges / Pattern Surface | nur wenn klar passend | Weiterhin über ContinuityGate |

**Grundsatz:** Graph-Nähe allein überschreibt keine direkten Fakten. Sie hebt die Assoziationsstärke, führt aber eher zu `likely_memory` oder `faint_memory`.

---

## 6. Scoring-Modell

Jeder Kandidat erhält einen kombinierten `confidence`-Score (0..1), der neben Relevanz auch die Erinnerungsqualität abbildet.

### Faktoren

| Faktor | Gewichtung (Vorschlag) | Beschreibung |
|--------|------------------------|--------------|
| `directRecallScore` | 0.25 | Vektor-Ähnlichkeit / Rerank-Score zum aktuellen Seed |
| `memoryStrength` | 0.15 | Aktuelle Stärke des Memory-Eintrags (inkl. Halbwertszeit) |
| `importance` | 0.10 | vom User/Agent vergebene Wichtigkeit |
| `recency` | 0.10 | zeitliche Nähe zur aktuellen Episode |
| `evidenceOverlap` | 0.10 | Textuelle Überlappung Seed ↔ Memory (z. B. Jaccard auf Keywords) |
| `canonicalConfirmation` | +0.10 | Memory wird durch KNOWLEDGE.md abgedeckt |
| `sourceQuality` | 0.05 | Herkunft (dm, group, cron, internal, canonical) |
| `graphDistance` | variabel | Tiefe im Graph: 1 = leichter Boost, ≥3 = Strafe |
| `graphEdgeType` | variabel | semantic/entity/episode/emotional – unterschiedliche Stärke |
| `episodeVividness` | 0.05 | Stärke der zugehörigen Episode |
| `overlaySupport` | ±0.05 | Overlay bestätigt oder widerspricht |
| `contradictionPenalty` | −0.10 bis −0.20 | Memory steht im Widerspruch zu anderem |
| `fadedPenalty` | −0.10 bis −0.30 | Je nach Faded-Level |
| `workspace/agent match` | 0.05 | Scope passt zum aktuellen Workspace/Agent |
| `repetition penalty` | −0.05 | Wurde in dieser Episode schon erwähnt |
| `freshness / lastRetrievedAt` | 0.05 | Frische des Abrufs (anti-staleness) |

### Formel (Vorschlag)

```text
baseScore = 0.25*directRecallScore
        + 0.15*memoryStrength
        + 0.10*importance
        + 0.10*recency
        + 0.10*evidenceOverlap
        + 0.05*sourceQuality
        + 0.05*episodeVividness
        + 0.05*workspaceMatch
        + 0.05*freshness

adjustments = +canonicalConfirmation
            + overlaySupport
            + graphDistanceBoostOrPenalty
            - contradictionPenalty
            - fadedPenalty
            - repetitionPenalty

confidence = clamp01(baseScore + adjustments)
```

**Graph-Distance-Regel:**
- distance 1: +0.05
- distance 2: +0.00
- distance ≥3: −0.05 bis −0.15 (abhängig von `memoryStrength`)

**Faded-Penalty:**
- `memoryStrength < fadedThreshold`: −0.10
- `memoryStrength < fadedThreshold / 2`: −0.20
- sehr alt + schwach: −0.30

---

## 7. Ausgabe-Modi direct / likely / faint / silent

CRR klassifiziert jeden Treffer und den Gesamtmodus in eine von vier Stufen.

### 7.1 `direct_memory`

**Bedingungen:**
- `confidence >= 0.78`
- Starke direkte Treffer
- Ideal canonical oder mehrfach gestützt
- Geringer Widerspruch

**Sichtbare Sprache erlaubt:**
- „Dazu erinnere ich mich: …“
- „Wir hatten dazu schon festgehalten, dass …“
- „Das hatten wir am [Datum] geklärt: …“

### 7.2 `likely_memory`

**Bedingungen:**
- `confidence 0.55–0.78`
- Treffer passen gut, aber nicht vollständig
- Graph-nah oder episodisch gestützt

**Sichtbare Sprache:**
- „Ich glaube, das hängt mit unserem früheren Thema X zusammen …“
- „Das kommt mir bekannt vor, wahrscheinlich wegen X …“
- „Die Details würde ich vorsichtig behandeln, aber es ging damals ungefähr um …“

### 7.3 `faint_memory`

**Bedingungen:**
- `confidence 0.32–0.55`
- Schwache, faded oder graph-nahe Erinnerung
- Geringe direkte Evidenz, aber möglicherweise nützlich als Orientierung

**Sichtbare Sprache (sehr sparsam):**
- „Ich erinnere mich dunkel, dass da etwas mit X war …“
- „Da klingelt etwas bei mir …“
- „Ich würde das nicht als sicheren Fakt behandeln, aber X könnte dazugehören …“

### 7.4 `silent_context`

**Bedingungen:**
- `confidence < 0.32`
- Zu unsicher, widersprüchlich oder nicht relevant genug

**Verhalten:**
- Nicht sichtbar erwähnen.
- Nur intern als leise Orientierung im Prompt-Block führen.

---

## 8. Interner Kontextblock

CRR injiziert keinen neuen Block in die User-Sicht, sondern einen kompakten, XML-ähnlichen Orientierungsblock für den Agenten. Er soll kompakt sein und eine Antwortstrategie liefern.

```xml
<conversation-reactivation-recall>
trigger: first_user_turn_after_idle
idle_minutes: 52
seed: "User fragt nach rückwirkendem Obsidian-Graph-Tagging"
mode: faint_memory
confidence: 0.41
reason:
- weak direct recall
- graph-adjacent memories found
- no canonical confirmation
strong_recalls:
- id: mem-abc123
  summary: "Wir hatten eine KNOWLEDGE.md-Section zum Obsidian-Graph-Tagging."
  confidence: 0.82
likely_recalls:
- id: mem-def456
  summary: "Episode vom 2026-06-10: Thema war Knowledge-Graph-Backfill."
  confidence: 0.61
faint_recalls:
- id: mem-ghi789
  summary: "Erwähnung von 'rückwirkend taggen' in alter Cron-Zusammenfassung."
  confidence: 0.38
graph_adjacent:
- source: mem-def456
  target: mem-jkl012
  distance: 2
  edge_type: semantic
recommended_language:
- "Da klingelt etwas bei mir ..."
- "Ich erinnere mich dunkel ..."
instruction:
Use this only as tentative orientation. Do not present weak recalls as facts.
</conversation-reactivation-recall>
```

### Regeln für den Block

- Maximal 1 stark, 2 likely, 3 faint — der Rest bleibt silent.
- Jeder Eintrag enthält nur `id`, `summary` (max 200 Zeichen), `confidence` und ggf. `distance`.
- Keine vollständigen Memory-Texte, um den Prompt nicht zu überladen.
- Der `instruction`-Teil erinnert den Agenten an die Sicherheitsregeln.

---

## 9. Sichtbarkeits-/Taste-Gate

Bevor der Agent eine Erinnerung sichtbar erwähnt, muss das Gate prüfen:

| Kriterium | Auswirkung |
|-----------|------------|
| Hilft es der Antwort? | Nein → silent |
| Ist die Erinnerung zuverlässig genug? | Confidence < 0.55 → nur faint oder silent |
| Würde die Erwähnung den User nerven? | Ja → silent |
| Ist der User im technischen Ausführungsmodus? | Ja → silent (keine Meta-Erinnerung stören) |
| Ist die Erinnerung nur faint? | Ja → nur sehr sparsam, max. 1x pro Episode |
| Gibt es Konflikte? | Ja → Unsicherheit erwähnen oder silent |
| Wurde in dieser Episode schon eine Erinnerung erwähnt? | Ja → silent oder stark reduziert |
| Cooldown / Limit erreicht? | Ja → silent |

**Entscheidungsbaum:**

```
if mode === direct_memory && helps_answer && !execution_mode:
  → sichtbar, klar formuliert
else if mode === likely_memory && helps_answer && !already_mentioned:
  → sichtbar, vorsichtig formuliert
else if mode === faint_memory && helps_answer && not_annoying && first_faint_this_episode:
  → sichtbar, sehr vage formuliert
else:
  → silent_context (nur interner Block)
```

---

## 10. Konfiguration

```js
conversationReactivationRecall: {
  enabled: true,
  featureFlag: "conversationReactivationRecall",

  // Trigger
  idleThresholdMinutes: 45,
  cooldownMinutes: 30,
  maxPerConversationEpisode: 1,
  maxPerHour: 2,
  minSeedChars: 20,
  minSeedWords: 4,

  // Performance
  synchronousBudgetMs: 1500,
  asyncExpansion: true,
  asyncBudgetMs: 5000,

  // Datenquellen
  includeGraph: true,
  includeEpisodes: true,
  includeFaded: true,
  includeObsidianLinks: true,
  includeInterpretationOverlays: true,
  includeContradictions: true,

  // Schwellen
  directThreshold: 0.78,
  likelyThreshold: 0.55,
  faintThreshold: 0.32,

  // Sichtbarkeit
  visibleMention: "auto",   // "auto" | "always" | "never" | "direct-only"

  // Sicherheit
  maxStrongRecallsInBlock: 1,
  maxLikelyRecallsInBlock: 2,
  maxFaintRecallsInBlock: 3,
}
```

### Begründung der Defaults

- `idleThresholdMinutes: 45` — deckt typische Pausen zwischen Gesprächsepisoden ab, ohne zu empfindlich zu sein.
- `cooldownMinutes: 30` — verhindert doppeltes Triggern bei schnellen Folgemeldungen.
- `maxPerConversationEpisode: 1` — CRR soll bei Wiederaufnahme einmalig Orientierung geben, nicht ständig.
- `maxPerHour: 2` — Schutz gegen Spam bei häufigem Hin-und-Her.
- `minSeedChars: 20` / `minSeedWords: 4` — filtert „ja“, „ok“, „mach“ zuverlässig heraus.
- `synchronousBudgetMs: 1500` — erlaubt einen schnellen synchronen Pass für direkte/canonical Treffer.
- `asyncExpansion: true` — graph-nahe/faded/episodische Erinnerungen können im Hintergrund nachgeladen werden.
- `directThreshold: 0.78` — nur wirklich starke Treffer dürfen klare Sprache verwenden.
- `likelyThreshold: 0.55` — ab hier vorsichtige Sprache.
- `faintThreshold: 0.32` — ab hier nur noch vage Hinweise oder silent.

---

## 11. Architektur-Integration in PLUR1BUS/OpenClaw

### Entscheidung: Neues Modul + schmale Erweiterung bestehender Pipeline

| Komponente | Verantwortung | Datei |
|------------|---------------|-------|
| Trigger-Erkennung + State | Prüft, ob CRR laufen soll; verwaltet Episode-/Cooldown-State | `lib/conversation-reactivation-recall.js` (Hauptmodul) |
| Seed-Bildung | Extrahiert aus dem User-Turn einen kompakten Such-Seed | `lib/conversation-reactivation-recall/seed-builder.js` |
| Scoring + Modus | Berechnet Confidence und klassifiziert in direct/likely/faint/silent | `lib/conversation-reactivation-recall/scorer.js` |
| Context-Block Renderer | Erzeugt den internen `<conversation-reactivation-recall>`-Block | `lib/conversation-reactivation-recall/context-renderer.js` |
| State Store | Persistiert State pro Workspace/Agent in einer JSON-Datei | `lib/conversation-reactivation-recall/state-store.js` |
| Integration Auto-Recall | Hook in `index.js` `before_prompt_build` nach normalem Recall | `index.js` |

### Trigger-Erkennung

- In `index.js` innerhalb des bestehenden `before_prompt_build`-Hooks, **nach** dem normalen Auto-Recall.
- Aufruf: `shouldTriggerWarmRecall(event, ctx, stateStore, config)`.
- Die Funktion liest `lastUserTurnAt`, `lastWarmRecallAt`, `lastCompactionAt` aus dem State und entscheidet.

### State-Speicher

- Keine neue DB-Spalte, sondern eine kleine JSON-Datei pro Workspace/Agent.
- Pfad-Vorschlag: `{workspaceDir}/.plur1bus/conversation-reactivation-state.{agentId}.json`
- Schreiben erfolgt atomar (tmp + rename), Lesen vor dem Recall.
- State ist workspace-/agent-isoliert, da Pfad aus `ctx.workspaceDir` und `ctx.agentId` gebildet wird.

### Rendering des internen Blocks

- Der Block wird in `index.js` **zusätzlich** zum normalen `<relevant-memories>`-Block erzeugt.
- Er wird dem Agenten als separates XML-Element injiziert, erscheint aber nicht in der User-Antwort.
- Formatierung in `lib/conversation-reactivation-recall/context-renderer.js`.

### Doppeltes Triggern verhindern

- Cooldown-Zeitstempel (`lastWarmRecallAt`).
- Seed-Hash-Vergleich (`lastWarmRecallSeedHash`).
- Episode-Counter (`maxPerConversationEpisode`).
- Hourly-Counter (`maxPerHour`).
- Idempotente State-Schreibweise (nur aktualisieren, wenn tatsächlich gelaufen).

### Workspace-/Agent-Sicherheit

- State-Pfad enthält `workspaceDir` und `agentId`.
- Recall läuft nur gegen den Pool des aktuellen Agenten (`pool.getDb(agentId)`).
- `checkAccess` / ACL-Middleware bleibt unverändert gültig.
- Keine Daten über Workspace-/Agent-Grenzen hinweg mischen.

### Tests

- Unit-Tests DB-frei in `tests/conversation-reactivation-recall.test.js`.
- Testen der Trigger-Logik, des Scorings, des Renderers und des State-Stores.

---

## 12. Minimal Viable Implementation (MVP)

### MVP-Ziel

Der kleinste sinnvolle erste Schritt, der das Verhalten sofort beobachtbar macht, ohne die Architektur zu überlasten.

### MVP-Umfang

1. **Trigger nur bei:**
   - erstem User-Turn nach `idleThresholdMinutes`, oder
   - erstem User-Turn nach Context-Compaction.
2. **Keine** Trigger bei technischem Session-Start ohne User-Input.
3. **Kleiner synchroner Recall** mit begrenztem Budget (`synchronousBudgetMs: 1500`).
4. **Keine neue DB-Spalte** — State als JSON-Datei pro Workspace/Agent.
5. **Nur interner Orientierungsblock**.
6. **Sichtbare Erwähnung** nur bei `direct_memory` oder `likely_memory`.
7. `faint_memory` zunächst nur intern oder sehr vorsichtig.
8. **Feature-Flag** zum Abschalten.
9. **Tests** für die 18 im User-Request genannten Fälle (soweit MVP-relevant).

### MVP-Dateien

- `lib/conversation-reactivation-recall.js` — Hauptlogik, Trigger, Orchestrierung.
- `lib/conversation-reactivation-recall/seed-builder.js` — Seed-Extraktion.
- `lib/conversation-reactivation-recall/scorer.js` — Confidence + Modus.
- `lib/conversation-reactivation-recall/context-renderer.js` — interner Block.
- `lib/conversation-reactivation-recall/state-store.js` — State-Persistenz.
- `tests/conversation-reactivation-recall.test.js` — Unit-Tests.
- Änderungen in `index.js` — Hook-Integration.
- Änderungen in `lib/providers/config-normalize.js` — Config-Defaults (falls zentralisiert).

### MVP-Bewertung

Der MVP ist **sinnvoll**, weil er:
- das Kernproblem (menschlicher Warm-Recall bei Reaktivierung) sofort löst,
- die bestehende Pipeline kaum berührt,
- keine persistenten Schema-Migrationen erfordert,
- durch Feature-Flag und Limits abschaltbar ist,
- als Grundlage für async-Erweiterungen dient.

---

## 13. Tests

Konkrete Unit-Tests (DB-frei, deterministisch):

1. **Erster User-Turn triggert Warm-Recall.**
   - State ohne `lastUserTurnAt` → `shouldTriggerWarmRecall` returns `true`.

2. **Technischer Session-Start ohne User-Turn triggert nichts.**
   - Event ohne `prompt` oder prompt < `minSeedChars` → `false`.

3. **Normaler Folge-Turn innerhalb Cooldown triggert nichts.**
   - `now - lastWarmRecallAt < cooldownMinutes` → `false`.

4. **Erster Turn nach 45+ Minuten Idle triggert Warm-Recall.**
   - `now - lastUserTurnAt > idleThresholdMinutes` → `true`.

5. **Erster Turn nach Compaction triggert Warm-Recall.**
   - `lastCompactionAt > lastWarmRecallAt` → `true`.

6. **Sehr kurzer User-Turn wie „ja“ triggert nichts.**
   - prompt = "ja" → `false`.

7. **Starke Treffer werden `direct_memory`.**
   - `confidence >= directThreshold` → mode `direct_memory`.

8. **Mittlere Treffer werden `likely_memory`.**
   - `confidence` in `[likelyThreshold, directThreshold)` → mode `likely_memory`.

9. **Schwache graph-nahe Treffer werden `faint_memory`.**
   - `confidence` in `[faintThreshold, likelyThreshold)` und `graphSource === "graph"` → mode `faint_memory`.

10. **Sehr schwache Treffer werden `silent_context`.**
    - `confidence < faintThreshold` → nicht im sichtbaren Block.

11. **Contradiction senkt Confidence.**
    - Overlay mit `contradiction: true` reduziert Score.

12. **Graph-Nachbarn dürfen Confidence erhöhen, aber keine harten Fakten überschreiben.**
    - Graph-Treffer mit hoher Confidence bleibt `likely` oder `faint`, wenn kein direkter Treffer vorliegt.

13. **Feature-Flag off deaktiviert alles.**
    - `enabled: false` → `shouldTriggerWarmRecall` returns `false`.

14. **MaxWarmRecallsPerConversationEpisode verhindert Spam.**
    - Counter ≥ Limit → `false`.

15. **Idempotenz: gleicher Seed triggert nicht mehrfach.**
    - `seedHash === lastWarmRecallSeedHash` → `false`.

16. **Workspace-Grenzen werden eingehalten.**
    - State-Datei enthält Workspace/Agent-Pfad; Cross-Workspace-Zugriff wird abgelehnt.

17. **Keine sichtbare „Ich erinnere mich dunkel“-Sprache bei `silent_context`.**
    - `silent_context`-Block enthält keine `recommended_language`.

18. **Faint Memory darf keine sicheren Fakten formulieren.**
    - `faint_memory`-Modus generiert nur vage recommended_language.

19. **State-Store atomisches Schreiben.**
    - Schreiben + Absturzsimulation → Datei bleibt konsistent.

20. **Cooldown-Reset nach neuer Episode.**
    - Neue Episode setzt `warmRecallsThisEpisode` zurück.

---

## 14. Risiken und Gegenmaßnahmen

| Risiko | Gegenmaßnahme |
|--------|---------------|
| Halluzination durch vage Erinnerungen | `faintThreshold`, `silent_context`, klare Sprachleitplanken, keine Erfindung von Details |
| Zu viel Kontext im Prompt | Begrenzte Budgets, kompakte Summaries, max. 1/2/3 Einträge pro Stufe |
| Performance am Reaktivierungsturn | `synchronousBudgetMs`, optionale async-Erweiterung, early-exit bei starkem normalen Recall |
| Nervige sichtbare Erwähnungen | `maxPerConversationEpisode: 1`, Taste-Gate, User-Deaktivierung, `visibleMention: "never"` |
| Falsche Sicherheit | Schwelle 0.78 für klare Sprache, Contradiction-Penalty, Canonical-Bestätigung erforderlich |
| Datenschutz / Workspace-Leaks | State und Recall pro Workspace/Agent isoliert, keine Überquerung von Scopes |
| Widersprüche in alten Memories | Contradiction-Tracking senkt Confidence; widersprüchliche Treffer → silent |
| Graph-Verbindungen mit schlechter Qualität | Graph-Distance-Strafe ab Tiefe 3, Qualitätsprüfung der Edges, Min-Cumulative-Relevance |
| User will direkte Ausführung, keine Meta-Erinnerung | Taste-Gate erkennt technischen Ausführungsmodus; `visibleMention: "never"` |
| Recall-Spam nach langen Sessions | Hourly-Limit, Episode-Limit, Cooldown, Seed-Hash-Idempotenz |
| Broken State nach Absturz | Atomares Schreiben, Fallback auf leeren State, robustes Parsen |

---

## 15. Empfehlung: Vor oder nach der rückwirkenden Obsidian-Graph-Zuordnung?

**Empfehlung: Zuerst die rückwirkende Obsidian-/Memory-Card-Graph-Zuordnung abschließen, danach CRR implementieren.**

Das ist die aktuelle operative Priorität für dieses Projekt. Die Datenbasis soll vor dem neuen Runtime-Feature verbessert werden.

Begründung:

1. **CRR funktioniert grundsätzlich auch ohne Obsidian.** Es kann direkt auf LanceDB, dem bestehenden Memory Graph und Episoden aufsetzen. Obsidian/Graph-Links sind kein harter Blocker.
2. **Die Qualität des Warm-Recalls steigt deutlich**, wenn Memory-Cards vorher sauber rückwirkend zugeordnet und verlinkt sind. Bessere Graph-/Tag-/Link-Strukturen liefern stärkere `likely_memory`- und `faint_memory`-Signale.
3. **Aktuelle operative Aufgabe ist die Workspace-Karten-Zuordnung.** Diese Arbeit soll nicht durch ein neues Runtime-Feature unterbrochen werden.
4. **CRR wird als optionaler Qualitäts-Booster für Obsidian-Strukturen konzipiert.** Die Datenquellenliste behält Obsidian Graph Links, Wikilinks und den semantic link index bei — sie werden als verstärkende Quellen genutzt, nicht als Voraussetzung.
5. **Kein Blocker für spätere CRR-Erweiterungen:** Auch wenn ein Workspace keine Obsidian-Zuordnung hat, läuft CRR weiterhin mit LanceDB + Memory Graph.

**Reihenfolge:**
1. Rückwirkende Obsidian-/Memory-Card-Graph-Zuordnung in den echten OpenClaw-Workspaces abschließen.
2. CRR als Design-Spec finalisieren und MVP implementieren.
3. CRR so bauen, dass es die verbesserten Graph-/Tag-/Link-Strukturen als zusätzliche Quelle nutzt.
4. CRR im Betrieb evaluieren (Nervfaktor, Latenz, Hilfreichkeit) und ggf. um async-Erweiterungen ergänzen.

---

## 16. Offene Punkte / Nächste Schritte

1. **Priorität 1:** Abschluss der rückwirkenden Obsidian-/Memory-Card-Graph-Zuordnung in den Workspaces.
2. Klärung, ob `lib/providers/config-normalize.js` die beste Stelle für die Defaults ist oder ob die Config besser in `index.js` direkt normalisiert wird.
3. Entscheidung, ob der async-Erweiterungs-Teil direkt mit dem MVP gebaut oder in Phase 2 verschoben wird.
4. Definition der konkreten LLM-Prompts für den Seed-Builder (falls Keyword-Extraktion nicht ausreicht).
5. Festlegung, wie Context-Compaction-Ereignisse (`lastCompactionAt`) aktuell an das Plugin gemeldet werden (Event-Listener vs. expliziter Call).
6. Festlegung, ob der interne Block dem Agenten als eigenes XML-Element oder als Teil des System-Prompts zugeführt wird.
7. Abstimmung, welche Obsidian-/Graph-Quellen konkret in CRR eingebunden werden, sobald die Zuordnung abgeschlossen ist.
