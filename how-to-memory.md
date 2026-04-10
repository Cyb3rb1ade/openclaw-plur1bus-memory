# How-To: Memory-System — Warum die Bots niemals vergessen

## Das Problem

Jede Agent-Session startet mit einem leeren Kontext. Ohne Gegenmassnahmen wäre jede Unterhaltung eine Begegnung mit einem Neugeborenen: kein Erinnern an gestrige Gespräche, keine Lernkurve, kein Persistieren von Entscheidungen oder Vorlieben.

OpenClaw löst das mit einem **dreischichtigen Memory-System**, das vollständig automatisch arbeitet — der Agent muss sich nicht aktiv um sein Gedächtnis kümmern.

Darauf sitzt zusätzlich ein **Adaptive-Learning-Overlay**: wiederkehrende Korrekturen, erfolgreiche Workflows und globale Skill-Ideen werden nicht nur erinnert, sondern in Regeln, Skill-Drafts und Curator-Review überführt.

---

## Die drei Schichten

```
Gespräch
   │
   ├─► Schicht 1: Flat-File Memory (Markdown)
   │       workspace/memory/YYYY-MM-DD.md
   │       Thematische Dateien (tools-guide.md, working-buffer.md, …)
   │       → Direkt lesbar, durchsuchbar, für Menschen lesbar
   │       → Agent schreibt selbst; beim Start liest er heute + gestern
   │
   ├─► Schicht 2: openclaw memory (Workspace-Indexer)
   │       ~/.openclaw/memory/{agentId}.sqlite  (sqlite-vec)
   │       Provider: OpenAI text-embedding-3-large (3072 dims)
   │       Hybrid-Search: 80% Vektor + 20% BM25
   │       → Indexiert automatisch alle Workspace-.md-Dateien
   │       → Gateway-integriert, kein separates Plugin nötig
   │       → Suche: openclaw memory search "<query>"
   │
   └─► Schicht 3: LanceDB (Konversations-Fakten)
           ~/.openclaw/memory/lancedb-namespaced/{agentId}/
           Provider: OpenAI text-embedding-3-large + Cohere Rerank v3.5
           → Explizit gespeicherte Fakten/Entscheidungen aus Gesprächen
           → Automatischer Recall vor jedem Turn (Top-5)
           → Tools: memory_store, memory_recall, memory_forget
```

**Wichtige Unterscheidung Schicht 2 vs. 3:**
- Schicht 2 indexiert **Dateien** — SOUL.md, AGENTS.md, Session-Logs, Tool-Dokumentation
- Schicht 3 speichert **extrahierte Fakten** — "Christian mag keine Rückfragen", "Deployment läuft Donnerstag"

**Adaptive-Learning-Overlay:**
- Nutzt Schicht 1-3 als Faktenbasis, ist aber **keine vierte Memory-DB**
- Formt wiederkehrende Muster zu `SOUL.md`-/`AGENTS.md`-/`TOOLS.md`-Regeln oder neuen Skills
- Hält globale Freigaben über Bernd als Curator getrennt von lokalen Learnings

---

## Schicht 1: Flat-File Memory

### Was ist das?

Jeder Agent schreibt am Ende einer Session (und bei wichtigen Ereignissen mittendrin) eine strukturierte Markdown-Datei ins `workspace/memory/`-Verzeichnis. Das sind normale Textdateien — für Menschen lesbar, per `cat` oder `grep` durchsuchbar.

### Wie wird geschrieben?

Automatisch durch eine Regel in `SOUL.md` (jeder Agent):

```
Memory Auto-Capture
Wenn der User wichtige Informationen, Fakten, Entscheidungen oder
Kontext teilt: FRAGE NICHT "Soll ich speichern?" — handle es direkt.
```

Der Agent entscheidet selbst was wichtig ist und schreibt, ohne zu fragen. Das Ergebnis sind Dateien wie:

- `2026-03-21.md` — tägliches Session-Log mit Gesprächszusammenfassung
- `2026-03-05-daemon-logic.md` — thematisch, zu einem spezifischen Thema
- `working-buffer.md` — laufend aktualisiertes Notizbuch für offene Punkte
- `pinchtab-guide.md` — extrahiertes Wissen aus Gesprächen über ein Tool

### Wo liegen die Dateien?

| Agent | Pfad |
|-------|------|
| Bernd | `/root/.openclaw/workspace/memory/` |
| Bernhardine | `/root/.openclaw/workspace-bernhardine/memory/` |
| Heisenberg | `/root/.openclaw/workspace-heisenberg/memory/` |

### Wie liest der Agent?

Beim Sessionstart lädt der Agent sein `ONBOARDING.md`, das ihn anweist die heutige und gestrige Memory-Datei zu lesen. So ist er in ~2 Sekunden auf dem Stand des letzten Gesprächs.

---

## Schicht 2: openclaw memory — Workspace-Indexer

### Was ist das?

Ein in den OpenClaw-Gateway eingebauter Workspace-Indexer. Er durchsucht alle `.md`-Dateien im Workspace-Verzeichnis, chunked sie, vektorisiert sie mit OpenAI-Embeddings und speichert alles in einer SQLite-Datenbank mit `sqlite-vec`-Extension.

Das ist **kein separates Plugin** — es ist Teil von OpenClaw selbst, konfiguriert über den `memorySearch`-Block in `openclaw.json`.

### Konfiguration (in openclaw.json)

```json
"memorySearch": {
  "provider": "openai",
  "model": "text-embedding-3-large",
  "query": {
    "minScore": 0.2,
    "hybrid": {
      "enabled": true,
      "vectorWeight": 0.8,
      "textWeight": 0.2,
      "candidateMultiplier": 10
    }
  }
}
```

### Datenbanken (pro Agent)

```
~/.openclaw/memory/
├── main.sqlite              ← Bernd (82 Dateien, 653 Chunks, 947 Cache-Einträge)
├── researcher.sqlite
├── bernhardine.sqlite       ← Bernhardine (81 Dateien, 332 Chunks)
├── heisenberg.sqlite        ← Heisenberg (30 Dateien, 203 Chunks)
└── {subagent}.sqlite        ← pro Subagent eine DB
```

### CLI-Verwaltung

```bash
openclaw memory status --deep     # Alle Agenten, Embedding-Provider, Chunk-Counts
openclaw memory search "query"    # Workspace-Dateien semantisch durchsuchen
openclaw memory index --force     # Vollständiger Neuindex (alle Agenten)
openclaw memory index --agent main --force   # Nur einen Agenten neu indexieren
```

### Was wird indexiert?

Alle `.md`-Dateien im `workspace/`-Verzeichnis des jeweiligen Agenten plus konfigurierte `extraPaths` (bei uns: `.learnings/`, `notes/`). Das umfasst SOUL.md, AGENTS.md, TOOLS.md, ONBOARDING.md, alle Session-Logs in `memory/`, Guides usw.

**Was nicht indexiert wird:** JSON-Dateien, SQLite-DBs (z.B. nightscout.db), Binaries.

### Abgrenzung zum alten QMD

`/usr/local/bin/qmd` ist der Vorgänger dieses Systems — lokal, node-llama-cpp, embeddinggemma, kein OpenAI-Support, 3+ Minuten pro 100 Chunks. `openclaw memory` hat ihn vollständig abgelöst. QMD nicht reaktivieren.

---

## Schicht 3: LanceDB — Konversations-Fakten

### Was ist das?

Eine eingebettete Vektordatenbank (LanceDB), in der jeder Agent gezielt Fakten, Entscheidungen, Präferenzen und Entitäten als **Vektor-Embeddings** speichert. Das ermöglicht semantische Suche: nicht "enthält das Wort X", sondern "ist inhaltlich ähnlich wie X".

**Beispiel:** Gespeichert: *"Christian mag es nicht, wenn der Agent zu viele Rückfragen stellt."*
Suchanfrage: *"Wie soll ich mich bei Unsicherheit verhalten?"*
→ Wird gefunden, obwohl kein gemeinsames Wort.

### Plugin: `memory-lancedb-namespaced`

Das Plugin liegt unter `/root/.openclaw/extensions/memory-lancedb-namespaced/` und ist ein OpenClaw-Gateway-Plugin, das sich in den Agenten-Lifecycle einhängt.

**Per-Agent-Isolation:** Jeder Agent bekommt seine eigene Datenbank:

```
~/.openclaw/memory/lancedb-namespaced/
├── main/           ← Bernd       (~119 MB)
├── bernhardine/    ← Bernhardine (~65 MB)
├── heisenberg/     ← Heisenberg
└── ...
```

### Schema

```
{ id, text, summary, origin, vector[3072], importance, category, createdAt, mergedFrom, expiresAt, storedBy }
```

- **id** — UUID
- **text** — Vollständiger Originaltext (lossless gespeichert)
- **summary** — L0-Summary (automatisch generiert, ≤150 Wörter, kein LLM)
- **origin** — Herkunftskontext: `dm` (Direktchat, Default) | `group` (Telegram-Gruppe) | `cron` (Hintergrundtask) | `internal` (agent-generiert)
- **vector** — Embedding-Vektor (3072 Dimensionen)
- **importance** — Gewichtung 0–1 (vom Agent beim Speichern angegeben)
- **category** — `preference | fact | decision | entity | other`
- **createdAt** — Unix-Timestamp
- **mergedFrom** — JSON-Array mit IDs der zusammengeführten Vorgänger (leer = kein Merge)
- **expiresAt** — Unix-Timestamp (ms) bis zum Ablauf; `0` = permanent
- **storedBy** — agentId des speichernden Agenten (Traceability)

### Origin-Feld: Kontext-Transparenz beim Recall

Memories werden beim Recall mit ihrer Herkunft angezeigt:

```xml
<relevant-memories>
  - [fact] Christian bevorzugt direkte Antworten… (ID: abc-123)          ← dm (kein Tag = dm)
  - [fact|group] In der Gruppe wurde beschlossen… (ID: def-456)          ← aus Gruppe!
  - [decision|cron] Täglicher Report: Status grün (ID: ghi-789)          ← Cron-Job
</relevant-memories>
```

**Warum wichtig:** Eine Aussage aus einer Telegram-Gruppe (mit anderen Beteiligten, anderem Kontext) hat eine andere Qualität als eine direkte Äußerung des Users im DM. Das `origin`-Feld macht das beim Recall sichtbar — ohne es explizit nachfragen zu müssen.

### L0-Summaries: Token-Ersparnis ohne LLM

Jede Memory bekommt beim Speichern automatisch eine Kurzzusammenfassung (≤150 Wörter) generiert — **ohne LLM-Aufruf**, rein durch Textkürzen mit Satzbegrenzungs-Awareness.

**Warum?** Auto-Recall injiziert mehrere Memories vor jedem Turn. Volltext wäre zu teuer (~2000 Zeichen pro Memory). Summaries sparen ~80% Token bei gleichem Informationsgehalt.

**Wichtig:** Die Summary ist nur die Recall-Vorschau. Der **vollständige Originaltext** liegt in der DB. `memory_recall` mit `full_text: true` holt alles zurück — lossless.

### Re-Ranker: Zwei-Stufen-Retrieval

```
Query → Embedding → Vektorsuche (Top-20) → Cohere Rerank v3.5 → Top-5
```

Das Plugin nutzt die **Cohere Rerank v2 API** (`rerank-v3.5`). Bei Ausfall wird automatisch auf die Vektor-Reihenfolge zurückgefallen.

```json
"reranker": {
  "enabled": true,
  "apiKey": "${COHERE_API_KEY}",
  "model": "rerank-v3.5",
  "candidates": 20
}
```

### Auto-Recall: Gedächtnis kommt von selbst

Vor jedem Agent-Turn (Hook: `before_agent_start`) durchsucht das Plugin automatisch die Datenbank nach relevanten Memories. Die Top-5 werden als `<relevant-memories>`-Block vor den Kontext injiziert:

```xml
<relevant-memories>
  - [fact] Christian bevorzugt direkte Antworten ohne Präambel… (ID: abc-123)
  - [decision|group] In der Gruppe beschlossen: PinchTab für Scraping… (ID: def-456)
  - [preference] Antworten auf Deutsch, Reasoning ebenfalls Deutsch… (ID: ghi-789)
</relevant-memories>
```

**Schwellenwert:** Nur Memories mit Score ≥ `autoRecallMinScore` (Standard: 0.2) werden injiziert. Maximal 5. Mit Reranker: zuerst Top-20 per Vektorsuche, dann Cohere Rerank → Top-5.

### Auto-Capture: Automatische Indexierung nach jedem Turn

Nach jedem erfolgreichen Turn (`agent_end`-Hook) speichert das Plugin automatisch relevante Nachrichten als Memories — **zusätzlich** zu den proaktiv per `memory_store` gespeicherten Fakten.

**Konfiguration (aktiv bei uns):**
```json
"autoCapture": true,
"captureMaxChars": 5000
```

Logik: Texte 20–5000 Zeichen aus User- und Assistant-Nachrichten → Duplikat-Check → max. 5 pro Turn (neueste) → `importance: 0.7`, auto-kategorisiert. Origin wird automatisch erkannt (Gruppen-Signale → `"group"`, sonst `"dm"`).

**User-URLs werden priorisiert erfasst (seit 2026-04-03)**

Auto-Capture erkennt User-Nachrichten mit URLs (`https://...`) und erfasst sie bevorzugt — unabhängig davon wie viele Antworten danach kamen. Technisch: User-URL-Nachrichten werden als eigene Liste geführt und immer zuerst in den Capture-Slot eingefügt, bevor die letzten N allgemeinen Texte aufgefüllt werden.

Zusätzlich sind alle Agenten in AGENTS.md angewiesen, User-URLs sofort proaktiv via `memory_store` zu sichern — als doppeltes Netz.

### Die drei Tools

| Tool | Funktion |
|------|---------|
| `memory_store` | Speichert einen Fakt mit Kategorie, Importance, Origin (`dm`/`group`/`cron`/`internal`) + optionalem TTL (`session`/`short`) |
| `memory_recall` | Semantische Suche (Summaries, optional Volltext via `full_text: true`, zeigt Origin) |
| `memory_forget` | Löscht per ID oder semantischer Suche |

### Duplikat-Schutz & LLM-Merging

`memory_store` durchläuft beim Speichern drei Stufen:

1. **Duplikat-Check** (Score ≥ `duplicateThreshold`, Standard: 0.95) — fast-identische Texte werden abgewiesen.
2. **Merge-Check** (Score in [`mergingThreshold`…0.95), Standard: 0.70–0.94) — logisch verwandte Memories werden via schnellem LLM-Call zusammengeführt. Konfiguration: `merging.*` in der Plugin-Config. LLM: `kimi-for-coding` ohne Thinking (`budget_tokens: 0`). Timeout: 30s; bei Timeout wird normal gespeichert. Qualitätsprüfung: `mergedText` muss länger als das kürzere der beiden Fragmente sein.
3. **Normaler Store** — falls keine der oberen Stufen greift.

Jede Operation wird in `{workspaceDir}/.adaptive-learning/curation-log.jsonl` protokolliert (events: `memory.stored`, `memory.rejected_duplicate`, `memory.merged`).

### TTL — zeitlich begrenzte Memories

`memory_store` akzeptiert einen optionalen `ttl`-Parameter mit zwei festen Werten:

| Wert | Ablauf | Verwendung |
|------|--------|-----------|
| `"session"` | Nächster Tag (+24h) | Temporäre Infos (laufende Aufgabe, kurzfristige Abmachung) |
| `"short"` | 14 Tage | Kurzfristige Präferenzen, Projekt-Contexts |
| *(kein Wert)* | Permanent | Default — immer opt-in |

Abgelaufene Memories werden beim nächsten `before_agent_start` opportunistisch gelöscht (`gc.enabled: true` per Default). Kein implizites TTL per Kategorie. Zusätzlich läuft `scripts/memory-gc.mjs` täglich um **03:00 Uhr** via System-Cron (`/etc/crontab`) — unabhängig von Agent-Aktivität, für alle drei Agenten.

### Conflict-Log — Decision-Memories zwischen Agenten

Wenn eine neue `decision`-Memory semantisch ähnlich ist (Score 0.70–0.94) zu einer bestehenden Memory **eines anderen Agenten**, wird das in `{workspaceDir}/.adaptive-learning/conflict-log.jsonl` geloggt — kein Block, kein Advisory-Hinweis. Jeder Eintrag trägt `schemaVersion: 1` für zukünftige Migrationen.

Jede Memory speichert `storedBy: agentId` für Traceability — auch innerhalb desselben Agenten über verschiedene Sessions (DM, Cron, Subagent).

**Namespace-Hinweis:** Da jeder Agent eine eigene LanceDB hat, sieht `findMergeCandidate` nur Memories desselben Agenten. Cross-Agent-Konflikte können in der aktuellen Konfiguration nicht automatisch detektiert werden — `storedBy` ist primär Vorbereitung für ein zukünftiges Shared-Namespace-Szenario.

**Aktives Management:** Wenn das Log >1 MB wird oder der älteste Eintrag >30 Tage alt ist, injiziert der `before_agent_start`-Hook einen `<conflict-review-reminder>`. Der Agent spricht den Nutzer dann proaktiv an und rotiert das Log **nur** auf explizite Bestätigung. Das Log ist ein Audit-Trail, kein normales Logfile — unreviewed Konflikte sind nicht "abgelaufen".

### Schicht 1.5 — KNOWLEDGE.md (Hybrid-Modell)

Strukturierte Wissensbasis für Entscheidungen und wichtige Fakten — **kein Auto-Trigger**, sondern drei Sicherheitsnetze:

1. **Explizites `knowledge_update`-Tool** — der Agent ruft es bewusst auf. Fetcht pending-Memories aus DB, integriert sie per LLM (`kimi-for-coding` ohne Thinking) in `{workspaceDir}/memory/KNOWLEDGE.md`. Atomares Write (tmp + rename). Compaction-Pass bei >200 Zeilen (Ziel ≤150, Dry-Run-Check — alte Datei bleibt bei Expansion).
2. **Overlay-Nudge** — wenn `pendingCount ≥ 3` unverarbeitete high-importance Stores: `<knowledge-update-reminder>`-Block wird vor jedem Turn injiziert.
3. **SOUL.md-Regeln** — alle drei Agenten haben explizite Trigger: Architekturentscheidung, stabile Präferenz, Projektabschluss, `importance ≥ 0.85`.

Pending-Tracking: `{workspaceDir}/.adaptive-learning/knowledge-pending.json` (Zähler + IDs der letzten 50 relevanten Stores).

Konfiguration: `schicht15.enabled: true` (aktiv), `schicht15.minImportance: 0.7` — Stores mit `category=decision` oder `category=fact + importance ≥ 0.7` triggern das Tracking.

---

## Adaptive Learning (Hermes-Stil)

### Was ist das?

Das Plugin `adaptive-learning-loop` ergänzt das Memory-System um einen **Meta-Layer für Selbstverbesserung**:

- wiederkehrende lokale Learnings werden als Kandidaten gespeichert
- explizites positives und negatives Nutzerfeedback wird als eigener Signalstrom erfasst
- user-scoped Feedback praegt zunaechst den aktuellen Menschen statt sofort alle Nutzer des Agents
- komplexe, erfolgreiche Abläufe werden als Skill-Drafts extrahiert
- globale Vorschläge gehen **nicht direkt** in fremde Workspaces, sondern in eine Curator-Queue

### Namespace-Modell

Lernen bleibt pro Primär-Agent isoliert:

| Primär-Agent | Workspace | Namespace |
|---|---|---|
| Bernd | `/root/.openclaw/workspace` | `main` |
| Bernhardine | `/root/.openclaw/workspace-bernhardine` | `bernhardine` |
| Heisenberg | `/root/.openclaw/workspace-heisenberg` | `heisenberg` |

Sub-Agents teilen die Lernbasis ihres Primär-Agents, weil sie denselben Workspace nutzen.
Zusätzlich erben Sub-Agents den aktiven User-Scope des Parent-Sessions über eine globale Binding-Datei.

### Dateien

Pro Workspace:

```text
.adaptive-learning/
├── state.json
├── rules.json
├── candidates.jsonl
├── feedback.jsonl
├── skills/*.draft.md
└── inbox/*.md
```

Global:

```text
/root/.openclaw/cross-agent-learning/queue.jsonl
/root/.openclaw/cross-agent-learning/subagent-bindings.json
```

### Werkzeuge

- `adaptive_learning_log` — lokalen Kandidaten oder globale Skill-Idee erfassen
- `adaptive_learning_feedback` — positives/negatives Nutzerfeedback auf bestehende oder neue Muster erfassen
- `adaptive_learning_review` — lokale Kandidaten oder Curator-Queue ansehen
- `adaptive_learning_apply` — lokal promoten oder als Bernd global reviewen

### Feedback-Modell

- `positive` erhöht die Bestätigung eines Musters.
- `negative` schwächt ein Muster ab oder markiert es zur Review.
- `local_only` Feedback mit auflösbarem Nutzer wird standardmäßig user-scoped gespeichert.
- `confirmed` bedeutet: das Muster wurde durch positives Feedback oder wiederholte Nutzung stabil bestätigt.
- `suppressed` bedeutet: das Muster soll vorerst nicht weiter verstärkt werden.
- `review_required` bedeutet: gemischte oder konfliktäre Rückmeldungen, also kein stilles Auto-Lernen.

Standard-Schwellenwerte:

- `positiveFeedbackThreshold = 2`
- `negativeFeedbackThreshold = 2`
- `mixedFeedbackReviewThreshold = 3`

Praktisch heißt das:

- `+2/-0` führt typischerweise zu `confirmed`
- `+2/-1` führt typischerweise zu `review_required`
- `+0/-2` führt typischerweise zu `suppressed`
- bereits durable Regeln werden bei negativem Feedback **nicht automatisch gelöscht**, sondern zur Review markiert

### Typischer Ablauf

1. Ein Nutzer sagt mehrfach: "Bitte kuenftig immer so."
2. Der Agent erfasst das per `adaptive_learning_feedback`.
3. Das Muster wird fuer diesen Nutzer bestaerkt und vor dem naechsten Turn injiziert; nur explizit globale Faelle schlagen direkt allgemein durch.
4. Erst wenn das Muster stabil ist, wird es lokal promotet oder als globaler Vorschlag an Bernd gereicht.

Beispiel:

```json
{
  "summary": "Antworten fuer Eva kurz und direkt halten",
  "type": "behavior_rule",
  "suggestedTarget": "SOUL.md",
  "feedback": "positive",
  "comment": "Eva sagte: genau so, bitte kuenftig immer so.",
  "originHuman": "Eva"
}
```

### Promotion-Ziele

- `behavior_rule` → `SOUL.md`
- `workflow_rule` → `AGENTS.md`
- `tool_rule` → `TOOLS.md`
- `skill_workflow` → `skills/<name>/SKILL.md`
- `cross_promotion_candidate` → Curator-Queue für Bernd

### Curator-Flow

- Bernhardine und Heisenberg dürfen globale Relevanz markieren, aber **nie direkt** in Bernds Workspace schreiben.
- Wenn ein User explizit sagt, dass etwas "für alle sinnvoll" ist, geht daraus ein Queue-Eintrag hervor.
- Bernd (`main`) reviewt diesen Eintrag und entscheidet über Ablehnung, Draft oder globale Promotion.

### Konfiguration (openclaw.json — aktuelle Werte)

```json
"adaptive-learning-loop": {
  "workspaceScoped": true,
  "promoteAfterRecurrences": 3,
  "promoteMinDistinctSessions": 2,
  "promoteWindowDays": 30,
  "maxInjectedRules": 5,
  "maxInjectedSkills": 3,
  "maxInjectedFeedback": 5,
  "userScopedFeedback": true,
  "maxInjectedUserFeedback": 4,
  "inheritUserScopeToSubagents": true,
  "autoDraftSkills": true,
  "autoApplyLocalPromotions": false,
  "positiveFeedbackThreshold": 2,
  "negativeFeedbackThreshold": 2,
  "mixedFeedbackReviewThreshold": 3,
  "crossPromotionQueuePath": "/root/.openclaw/cross-agent-learning/queue.jsonl",
  "curatorAgentId": "main"
}
```

| Key | Wert | Bedeutung |
|-----|------|-----------|
| `promoteAfterRecurrences` | 3 | Mind. 3× aufgetaucht bevor Promotion möglich |
| `promoteMinDistinctSessions` | 2 | Mind. 2 verschiedene Sessions |
| `autoApplyLocalPromotions` | false | Bernd muss lokale Promotions manuell freigeben |
| `userScopedFeedback` | true | `local_only` Feedback landet zunächst user-scoped |
| `maxInjectedUserFeedback` | 4 | Max. 4 user-spezifische Feedback-Einträge per Turn injiziert |
| `inheritUserScopeToSubagents` | true | Subagents erben den User-Scope des Parent via `subagent-bindings.json` |

### Abgrenzung zu `.learnings/`

`.learnings/` bleibt das menschlich lesbare Audit-Log.

`adaptive-learning-loop` ist die operative Schicht, die aus wiederkehrenden Learnings dauerhaftes Verhalten und Skills macht.

---

## Retrieval-Pipeline (Schicht 3, vollständig)

```
Nutzer schreibt etwas
    │
    ▼
Embedding des Prompts (OpenAI text-embedding-3-large)
    │
    ▼
Vektorsuche in LanceDB (Top-20, Score ≥ autoRecallMinScore)
    │
    ▼
Cohere Rerank v3.5 — bewertet alle 20 gemeinsam mit dem Query
    │
    ▼
Top-5 als <relevant-memories> vor den Turn injiziert
```

Ohne Reranker: Schritt "Cohere Rerank" entfällt, direkt Top-5 per Vektor-Score.

---

## Konfiguration (Schicht 3 Plugin)

In `openclaw.json`:

```json
{
  "plugins": {
    "memory-lancedb-namespaced": {
      "embedding": {
        "apiKey": "${OPENAI_API_KEY}",
        "model": "text-embedding-3-large",
        "dimensions": 3072
      },
      "baseDbPath": "~/.openclaw/memory/lancedb-namespaced",
      "autoRecall": true,

      "recallMinScore":     0.15,
      "autoRecallMinScore": 0.20,
      "duplicateThreshold": 0.95,
      "forgetThreshold":    0.30,
      "summaryMaxWords":    150,

      "reranker": {
        "enabled":    true,
        "apiKey":     "${COHERE_API_KEY}",
        "model":      "rerank-v3.5",
        "candidates": 20
      },
      "merging": {
        "enabled":        true,
        "threshold":      0.70,
        "model":          "kimi-for-coding",
        "baseUrl":        "https://api.kimi.com/coding/v1",
        "apiKey":         "sk-kimi-...",
        "disableThinking": true,
        "headers":        { "User-Agent": "claude-code/1.0" }
      },
      "schicht15": {
        "enabled":        true,
        "model":          "kimi-for-coding",
        "baseUrl":        "https://api.kimi.com/coding/v1",
        "apiKey":         "sk-kimi-...",
        "disableThinking": true,
        "headers":        { "User-Agent": "claude-code/1.0" },
        "minImportance":  0.7
      }
    }
  }
}
```

| Parameter | Wirkung |
|-----------|---------|
| `recallMinScore` | Minimaler Score für manuelles `memory_recall` |
| `autoRecallMinScore` | Minimaler Score für automatischen Pre-Turn-Recall |
| `duplicateThreshold` | Ab wann ein Store-Versuch als Duplikat gilt |
| `forgetThreshold` | Minimaler Score für `memory_forget` per Query |
| `summaryMaxWords` | Max. Wörter einer generierten L0-Summary |
| `merging.enabled` | LLM-Merge für logisch verwandte Memories (Score 0.70–0.94) |
| `merging.threshold` | Untergrenze der Merge-Zone (Standard: 0.70) |
| `merging.disableThinking` | Thinking beim Merge-LLM deaktivieren (`budget_tokens: 0`) — empfohlen für Klassifikations-Tasks |
| `merging.headers` | Zusätzliche HTTP-Header (z.B. `User-Agent` für kimi-coding API) |
| `schicht15.enabled` | Schicht 1.5 aktivieren: `knowledge_update`-Tool + Overlay-Nudge + Pending-Tracking |
| `schicht15.minImportance` | Mindest-Importance für fact-Kategorie (Standard: 0.7) |
| `schicht15.disableThinking` | Thinking beim KNOWLEDGE.md-LLM deaktivieren |
| `gc.enabled` | Abgelaufene Memories beim Agent-Start löschen (Standard: `true`) |

---

## Zusammenspiel: Was passiert wann?

```
Neuer Agent-Turn startet
    │
    ▼
[Schicht 2] openclaw memory: Workspace-Dateien durchsuchbar im Kontext
    │
    ▼
[Schicht 3 Auto-Recall] LanceDB: relevante Konversations-Fakten holen
    → Injiziert bis zu 5 als <relevant-memories> in Kontext
    │
    ▼
Agent verarbeitet Turn
    │
    ├─ Wichtige Info erkannt?
    │       → memory_store (LanceDB, persistent, vektorisiert) [Schicht 3]
    │       → YYYY-MM-DD.md schreiben (Flat-File, direkt lesbar) [Schicht 1]
    │         → Schicht 2 indexiert die neue .md-Datei automatisch
    │
    └─ Braucht Agent Wissen aus der Vergangenheit?
            → memory_recall (semantische Suche in LanceDB) [Schicht 3]
            → openclaw memory search (Workspace-Dateien) [Schicht 2]
            → Oder: direkt die Markdown-Dateien lesen [Schicht 1]
```

---

## Warum drei Schichten?

| | Flat-File | openclaw memory | LanceDB |
|--|-----------|-----------------|---------|
| Inhalt | Session-Logs, Guides | Workspace-.md-Dateien (indexiert) | Extrahierte Fakten/Entscheidungen |
| Suche | manuell / grep | Hybrid: Vektor + BM25 | Semantisch + Reranker |
| Auto-Recall | Nein (ONBOARDING liest heute+gestern) | Nein (CLI-Tool) | Ja (vor jedem Turn) |
| Schreibt Agent | Ja | Nein (liest nur) | Ja (memory_store) |
| Für Menschen | Direkt lesbar | Via CLI | Via memory_recall |
| Skalierung | ~100 Dateien OK | Tausende Chunks | Millionen Einträge |

---

## Abgrenzung: Was unser Memory-System NICHT ist

### LCM (Lossless Context Management) — NICHT INSTALLIERT

LCM (`@martian-engineering/lossless-claw`) ist ein Plugin aus der OpenClaw-Dokumentation mit DAG-basierter Kompression und Tools wie `lcm_expand`, `lcm_grep`, `lcm_describe`. Es klingt beeindruckend — ist aber **in unserem Setup nicht installiert und nicht in Betrieb**.

Unser "lossless" Ansatz: `before-compact-save` speichert den Kontext-Buffer als `YYYY-MM-DD-compact.md` **bevor** OpenClaw ihn komprimiert. Die Schicht-2-Indexierung macht diese Datei dann semantisch durchsuchbar.

### L0-Summaries sind kein Verlust

Die L0-Summaries (≤150 Wörter) sind **Recall-Vorschauen**, nicht der gespeicherte Inhalt. Im `memory-lancedb-namespaced` Plugin liegt der **vollständige Originaltext** in der DB. `memory_recall` mit `full_text: true` holt alles zurück — lossless.

---

## Schicht 4: Dreaming — Langzeit-Gedächtnis aus LanceDB-Daten

OpenClaw v2026.4.5 bringt ein eingebautes Dreaming-System (`memory-core`), das drei Phasen kennt: **Leichtschlaf** (Einlesen täglicher Notizen), **Tiefschlaf** (Promotion zu MEMORY.md) und **REM** (narrative Zusammenfassung). Da unser Plugin `memory-lancedb-namespaced` den `plugins.slots.memory`-Slot belegt, ist `memory-core` deaktiviert — das Dreaming-System kann nicht selbst laufen.

Lösung: Zwei externe Python-Skripte replizieren die relevanten Phasen.

### Architektur

```
LanceDB (lancedb-namespaced)
   │
   │  23:30 täglich
   ▼
dreaming-bridge.py          ← Leichtschlaf-Äquivalent
   │
   ├─► memory/YYYY-MM-DD.md     (tägliche Bridge-Einträge mit Anker-Kommentaren)
   └─► memory/.dreams/
           short-term-recall.json    (Recall-Store, OpenClaw-kompatibles Format)
           bridge-state.json         (exportierte IDs + Importance)
   │
   │  23:35 täglich
   ▼
dreaming-promote.py         ← Tiefschlaf-Äquivalent
   │
   └─► memory/MEMORY.md          (Promotions mit openclaw-memory-promotion:-Markern)
```

### dreaming-bridge.py — Leichtschlaf

Liest LanceDB-Einträge (`importance ≥ 0.65`, `expiresAt = 0`) und schreibt sie als tägliche `.md`-Dateien mit HTML-Anker-Kommentaren für genaue Zeilennummern.

**Akkumulations-Mechanismus:** Bei jedem Lauf werden bereits exportierte Einträge **refreshed** — `recallDays` bekommt das heutige Datum hinzugefügt, `recallCount` wird inkrementiert. So akkumuliert das Signal über Tage, ohne Duplikate zu schreiben.

```
short-term-recall.json Format:
{
  "version": 1,
  "entries": {
    "memory:memory/YYYY-MM-DD.md:startLine:endLine": {
      "path": "memory/YYYY-MM-DD.md",
      "source": "memory",
      "startLine": 42,
      "endLine": 42,
      "snippet": "...",
      "recallCount": 3,
      "totalScore": 2.85,
      "recallDays": ["2026-04-05", "2026-04-06"],
      "concepts": ["kimi", "cooldown", "timeout"]
    }
  }
}
```

### dreaming-promote.py — Tiefschlaf

Liest `short-term-recall.json`, berechnet Composite-Score nach dem **exakten OpenClaw-Algorithmus** und promotet Kandidaten in `MEMORY.md`.

**Score-Formel:**
```
score = 0.25 × frequency   (log1p(recallCount) / log1p(10))
      + 0.30 × relevance   (totalScore / recallCount)
      + 0.15 × diversity   (uniqueDays / 5)
      + 0.15 × recency     (exp(-ln2 × ageDays / 14))
      + 0.10 × consolidation (uniqueDays / 5)
      + 0.05 × conceptual  (len(concepts) / 6)
```

**Promotion-Schwellen (OpenClaw-Defaults):**

| Parameter | Wert | Bedeutung |
|---|---|---|
| `MIN_SCORE` | 0.75 | Composite-Score-Cutoff |
| `MIN_RECALL_COUNT` | 3 | Mind. 3 Recall-Signale |
| `MIN_UNIQUE_QUERIES` | 2 | Mind. 2 verschiedene Tage |
| `MAX_PROMOTE` | 10 | Max. Promotions pro Lauf/Agent |

**MEMORY.md-Format** (OpenClaw-kompatibel):
```markdown
## Promoted From Short-Term Memory (YYYY-MM-DD)

<!-- openclaw-memory-promotion:memory:memory/YYYY-MM-DD.md:42:42 -->
- Snippet-Text [score=0.753 recalls=4 avg=0.950 source=memory/...:42-42]
```

Die `openclaw-memory-promotion:`-Marker sind identisch zum nativen OpenClaw-Format — Deduplication funktioniert, auch wenn `memory-core` später re-enabled wird.

### Cron

```cron
30 23 * * * python3 /root/.openclaw/scripts/dreaming-bridge.py --quiet >> /root/.openclaw/logs/dreaming-bridge.log 2>&1
35 23 * * * python3 /root/.openclaw/scripts/dreaming-promote.py --quiet >> /root/.openclaw/logs/dreaming-promote.log 2>&1
```

### Agents / Workspaces

| Namespace | Workspace |
|---|---|
| `main` | `/root/.openclaw/workspace` |
| `bernhardine` | `/root/.openclaw/workspace-bernhardine` |
| `heisenberg` | `/root/.openclaw/workspace-heisenberg` |

### Git-Branch

Das Dreaming-System ist als **separater Branch** im Memory-Repo versioniert — bewusst getrennt vom Plugin selbst:

```
/root/openclaw-memory-system/
  main                        ← memory-lancedb-namespaced Plugin
  dreaming-bridge/v1.0.0     ← Dreaming-Pipeline (dieser Branch)
    scripts/dreaming-bridge.py
    scripts/dreaming-promote.py
    dreaming-bridge.md
```

### Reset

```bash
# Nur Dream-State zurücksetzen (tägliche .md-Dateien bleiben erhalten):
rm memory/.dreams/bridge-state.json
rm memory/.dreams/short-term-recall.json
# → Bridge exportiert beim nächsten Lauf alles neu
```

---

*Dokumentation erstellt: 2026-03-22, aktualisiert: 2026-04-06*
*Änderungen 2026-04-03 (Features): relative Pfade im Plugin, captureMaxChars-Default 5000, URL/Attachment-Priorisierung, Daily-Notes-Fix via LanceDB, install-memory-system.sh mit Auto-Erkennung + --update-plugin-only + --rollback + Snapshot*
*Änderungen 2026-04-03 (Security): SQL-Injection-Fix (UUID-Validation), atomares Lock-File (wx-Flag + Staleness + Retry-Backoff), JSON-Parse + Schema-Validierung in callMergeCheck, Embedding-Retry mit Backoff, Auto-Capture Promise-Queue, GC-Pfade relativ*
*Änderungen 2026-04-04 (Security follow-up): purgeExpired() Timestamp-Validierung, Lock-File Retry mit exponentiellem Backoff (5 Versuche), eval→printf-v in install-memory-system.sh (Command Injection Fix)*
*Änderungen 2026-04-11 (Plugin): kind `memory` → `extension` (OpenClaw 4.9 Native-Dreaming-Kompatibilität); `required: ["embedding"]` aus configSchema entfernt (per-Agent-Validation ohne explizite embedding-Config)*
*Änderungen 2026-04-06 (Dreaming): dreaming-bridge.py + dreaming-promote.py als Leichtschlaf/Tiefschlaf-Äquivalent für LanceDB-Plugin; Branch dreaming-bridge/v1.0.0 im Memory-Repo*
*Nicht fixbar: LanceDB parametrisierte Queries (API unterstützt nur String), TOCTOU (openSync wx ist per POSIX atomar)*
*Plugin-Pfad: `/root/.openclaw/extensions/memory-lancedb-namespaced/`*
*Plugin-README: `/root/.openclaw/extensions/memory-lancedb-namespaced/README.md`*
*Workspace-Indexer: `openclaw memory status --deep`*
*Git-Repo: `/root/openclaw-memory-system/` — Plugin: Branch main; Dreaming: Branch dreaming-bridge/v1.0.0*
