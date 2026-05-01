# memory-lancedb-namespaced

Per-Agent isoliertes LanceDB-Memory-Plugin für OpenClaw.
Jeder Agent hat seine eigene Datenbank unter `{baseDbPath}/{agentId}/`.

**Aktuelle Version:** `2.1.9` — getestet mit OpenClaw `2026.4.29`. Die 4.29-Kompatibilität umfasst `~/.openclaw/plugins/installs.json` als primären Install-Record, schema-konforme Message-Policy-Werte, robuste Journal-/Plugin-List-Checks und einen Installer, der bestehende Provider/Modelle respektiert.

**Mindestversion:** OpenClaw `2026.4.29` oder neuer.

---

## Features

- **Auto-Recall** — injiziert relevante Memories als `<relevant-memories>` vor jedem Turn (Summaries, nicht Volltext)
- **Auto-Capture** — speichert relevante Nachrichten automatisch nach jedem Turn
- **Re-Ranker** — Cohere Rerank API v2 sortiert Vektor-Kandidaten neu, bevor sie injiziert oder zurückgegeben werden
- **LLM-Summaries** — automatische ≤150-Wort-Kurzfassung via LLM bei Store und Recall
- **TTL** — optionale Lebensdauer (`session` = 1 Tag, `short` = 14 Tage, default = permanent)
- **Conflict-Logging** — widersprüchliche `decision`-Memories verschiedener Agenten werden in `conflict-log.jsonl` protokolliert
- **Merging** — semantisch ähnliche Memories (Score 0.70–0.94) werden via LLM zusammengeführt
- **Per-Agent-Isolation** — Bernd, Bernhardine, Heisenberg haben getrennte DBs
- **Schema-Migration** — bestehende DBs erhalten neue Spalten automatisch beim ersten Zugriff
- **Konfigurierbare Thresholds** — alle Score-Grenzen per `openclaw.json` einstellbar

---

## Tools

### `memory_recall`

Semantische Suche in den Memories des Agenten.

| Parameter | Typ | Default | Beschreibung |
|-----------|-----|---------|--------------|
| `query` | string | — | Suchbegriff |
| `limit` | number | 5 | Max. Ergebnisse |
| `full_text` | boolean | false | Volltext statt Summary zurückgeben |

**Output (default, Summary):**
```
[fact] Kurze Zusammenfassung… (score: 0.82, ID: abc-123)
[decision] Andere Summary… (score: 0.71, ID: def-456)
```

**Output mit `full_text: true`:**
```
[fact] Vollständiger Originaltext ohne Kürzung (score: 0.82, ID: abc-123)
```

---

### `memory_store`

Speichert eine Information dauerhaft im Memory des Agenten.

| Parameter | Typ | Default | Beschreibung |
|-----------|-----|---------|--------------|
| `text` | string | — | Zu merkender Text |
| `category` | enum | auto | `preference` / `fact` / `decision` / `entity` / `other` |
| `importance` | number | 0.5 | Gewichtung 0–1 |
| `ttl` | enum | — | `session` (1 Tag) oder `short` (14 Tage). Ohne Angabe = permanent. |

Duplikate (Score ≥ `duplicateThreshold`) werden abgewiesen.
Die Summary wird automatisch via LLM erzeugt und persistiert.

---

### `memory_forget`

Entfernt eine Memory per ID oder Suchanfrage.

| Parameter | Typ | Beschreibung |
|-----------|-----|--------------|
| `memoryId` | string | Direkte Löschung per ID |
| `query` | string | Suche + Löschung (bei Eindeutigkeit) |

Bei mehreren Treffern werden alle IDs aufgelistet — dann `memoryId` angeben.

---

## Auto-Recall

Wird beim `before_agent_start`-Hook ausgelöst. Injiziert bis zu 5 relevante Memories als kompakten Kontext:

```xml
<relevant-memories>
  - [fact] Kurze Summary des ersten Treffers… (ID: abc-123)
  - [preference] Kurze Summary des zweiten Treffers… (ID: def-456)
</relevant-memories>
```

**Token-Ersparnis:** ~80 % gegenüber Volltext-Injection (150 Wörter vs. ≤2000 Zeichen pro Memory).

**Ablauf mit Re-Ranker:**
1. Vektorsuche holt bis zu `candidates` (Standard: 20) Treffer über `autoRecallMinScore`
2. Cohere Rerank sortiert diese 20 nach tatsächlicher semantischer Relevanz
3. Die Top-5 werden injiziert

Ohne Re-Ranker: direkt Top-5 per Vektor-Score.

Deaktivierbar via `"autoRecall": false` in der Plugin-Config.

---

## Konfiguration (`openclaw.json`)

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
      "autoCapture": true,
      "captureMaxChars": 5000,

      "recallMinScore":     0.15,
      "autoRecallMinScore": 0.2,
      "duplicateThreshold": 0.95,
      "forgetThreshold":    0.3,
      "summaryMaxWords":    150,

      "gc": { "enabled": true },

      "merging": {
        "enabled": true,
        "minScore": 0.70,
        "maxScore": 0.94
      },

      "reranker": {
        "enabled":    true,
        "apiKey":     "${COHERE_API_KEY}",
        "model":      "rerank-v3.5",
        "candidates": 20
      }
    }
  }
}
```

### Threshold-Referenz

| Key | Default | Wirkung |
|-----|---------|---------|
| `recallMinScore` | `0.15` | Minimaler Score für `memory_recall` |
| `autoRecallMinScore` | `0.2` | Minimaler Score für Auto-Recall (pre-turn) |
| `duplicateThreshold` | `0.95` | Ab wann ein Store-Versuch als Duplikat gilt |
| `forgetThreshold` | `0.3` | Minimaler Score für `memory_forget` per Query |
| `summaryMaxWords` | `150` | Max. Wörter in einer generierten LLM-Summary |
| `captureMaxChars` | `5000` | Max. Zeichen pro Auto-Capture-Nachricht |

### Re-Ranker-Konfiguration

| Key | Default | Beschreibung |
|-----|---------|--------------|
| `reranker.enabled` | `true` | An/Aus (fehlt `apiKey`, automatisch deaktiviert) |
| `reranker.apiKey` | — | Cohere API Key (`${COHERE_API_KEY}` empfohlen) |
| `reranker.model` | `rerank-v3.5` | Cohere Rerank-Modell |
| `reranker.candidates` | `20` | Vektor-Kandidaten vor dem Re-Ranking |

**Fallback:** Schlägt Cohere fehl (Netzwerk, Rate-Limit), wird automatisch auf Vektor-Reihenfolge zurückgefallen. Kein Absturz.

---

## Schema

```
{ id, text, summary, origin, vector[3072], importance, category, createdAt, mergedFrom, expiresAt, storedBy }
```

- `summary` — LLM-generierte Kurzfassung (≤`summaryMaxWords` Wörter)
- `origin` — `"dm"` (Default) oder `"group"` (Gruppen-Chat)
- `expiresAt` — Unix-Timestamp (ms), `0` = permanent (TTL-Feld)
- `storedBy` — agentId des speichernden Agenten (Traceability)
- `mergedFrom` — IDs der zusammengeführten Quell-Memories
- Migration erfolgt automatisch beim ersten Zugriff auf bestehende DBs

---

## Conflict-Log

`{workspaceDir}/.adaptive-learning/conflict-log.jsonl` protokolliert widersprüchliche `decision`-Memories zwischen verschiedenen Agenten (Bernd, Bernhardine, Heisenberg).

**Trigger:** Neue `decision`-Memory ähnelt einer bestehenden eines anderen Agenten (Score 0.70–0.94).

**Kein Block** — nur Logging. Rotation nur nach expliziter Nutzer-Bestätigung.

Schema einer Zeile:
```json
{
  "timestamp": "2026-03-28T12:00:00.000Z",
  "newMemoryId": "uuid-neu",
  "newAgentId": "main",
  "newText": "Wir nutzen PostgreSQL.",
  "existingMemoryId": "uuid-alt",
  "existingAgentId": "bernhardine",
  "existingText": "Wir nutzen MongoDB.",
  "score": 0.83,
  "category": "decision",
  "mergeDecision": "stored_separately"
}
```

`mergeDecision`: `"merged"` | `"stored_separately"` | `"no_merge_llm_call"`

---

## DB-Pfade

| Agent | Pfad |
|-------|------|
| Bernd | `~/.openclaw/memory/lancedb-namespaced/main/` |
| Bernhardine | `~/.openclaw/memory/lancedb-namespaced/bernhardine/` |
| Heisenberg | `~/.openclaw/memory/lancedb-namespaced/heisenberg/` |
| Person B | `~/.openclaw/memory/lancedb-namespaced/person-b/` |
