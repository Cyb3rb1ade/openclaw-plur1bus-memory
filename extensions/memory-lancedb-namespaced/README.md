# memory-lancedb-namespaced

Per-Agent isoliertes LanceDB-Memory-Plugin für OpenClaw.
Jeder Agent hat seine eigene Datenbank unter `{baseDbPath}/{agentId}/`.

**Aktuelle Version:** `3.2.1` — OpenClaw-native Memory-Augment-Integration. Die Kompatibilität umfasst stabile Tool-Contracts fuer `memory_recall`, `memory_store`, `memory_forget` und `knowledge_update`, die optionale OpenClaw-native Embedding-Provider-Bridge fuer `plur1bus-openai`, `plur1bus-openai-compatible` und `plur1bus-e5-small`, Hook-basiertes Auto-Capture/Auto-Recall, Turn Journal, MemoryCandidates, Origin/Trust-Metadaten, BehaviorCards, Curation und Corpus-/Prompt-Supplements.

**Mindestversion:** OpenClaw `2026.5.12-beta.6` oder neuer. PLUR1BUS v3.2 ist
gegen OpenClaw `2026.5.12` validiert; ältere OpenClaw-Versionen bleiben
beim v2.1.x-Zweig.

**ClawHub-Installationsbeispiel:**

```bash
openclaw plugins install clawhub:@cyb3rb1ade/plur1bus-memory
```

PLUR1BUS bleibt ein Augment-Plugin. `memory-core` bleibt OpenClaw-Memory-Slot-
Owner; PLUR1BUS setzt kein `kind:"memory"` und nutzt keine Memory-Capability-
Registrierung.

---

## Features

- **Auto-Recall** — injiziert relevante Memories als `<relevant-memories>` vor jedem Turn (Summaries, nicht Volltext)
- **Auto-Capture** — speichert relevante Nachrichten automatisch nach jedem Turn
- **Re-Ranker** — provider-aware: Cohere ist stabiler Remote-Default, disabled bleibt Vector-only, lokaler GTE-Reranker ist experimental bis zum grünen Local-Model-Smoke
- **LLM-Summaries** — automatische ≤150-Wort-Kurzfassung via LLM bei Store und Recall
- **TTL** — optionale Lebensdauer (`session` = 1 Tag, `short` = 14 Tage, default = permanent)
- **Conflict-Logging** — widersprüchliche `decision`-Memories verschiedener Agenten werden in `conflict-log.jsonl` protokolliert
- **Merging** — semantisch ähnliche Memories (Score 0.70–0.94) werden via LLM zusammengeführt
- **Provider-neutral** — der OpenClaw-Haupt-LLM bleibt frei; Embeddings nutzen OpenAI/OpenAI-kompatible Provider oder experimentell lokal `intfloat/multilingual-e5-small`; optionale LLM-Features brauchen ein explizit gesetztes OpenAI-kompatibles Chat-Modell
- **OpenClaw-native Provider-Bridge** — `contracts.memoryEmbeddingProviders` und `api.registerMemoryEmbeddingProvider` exponieren `plur1bus-openai`, `plur1bus-openai-compatible` und experimental `plur1bus-e5-small`, ohne `kind:"memory"` zu setzen oder die Memory-Capability-API zu nutzen; `memory-core` bleibt Slot-Owner
- **Chat-provider-neutral** — OpenClaw-Chat-Routen bleiben frei wählbar; plur1bus konfiguriert nur seine Memory-internen Embedding- und optionalen LLM-Endpunkte
- **Per-Agent-Isolation** — jeder Agent hat eine eigene LanceDB unter `{baseDbPath}/{agentId}/`
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

Wird beim `before_prompt_build`-Hook ausgelöst. Injiziert bis zu 5 relevante Memories als kompakten Kontext:

```xml
<relevant-memories>
  - [fact] Kurze Summary des ersten Treffers… (ID: abc-123)
  - [preference] Kurze Summary des zweiten Treffers… (ID: def-456)
</relevant-memories>
```

**Token-Ersparnis:** ~80 % gegenüber Volltext-Injection (150 Wörter vs. ≤2000 Zeichen pro Memory).

**Ablauf mit Re-Ranker:**
1. Vektorsuche holt bis zu `candidates` (Standard: 20) Treffer über `autoRecallMinScore`
2. Der konfigurierte Reranker sortiert diese 20 nach tatsächlicher semantischer Relevanz
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
        "provider": "openai",
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
        "provider":   "cohere",
        "enabled":    true,
        "apiKey":     "${COHERE_API_KEY}",
        "model":      "rerank-v3.5",
        "candidates": 20
      }
    }
  }
}
```

Für Auto-Capture muss das OpenClaw-Profil Conversation Access erlauben:

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-namespaced": {
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": true
        }
      }
    }
  }
}
```

### Embedding-Provider

| Provider-ID | Status | Beschreibung |
|-------------|--------|--------------|
| `plur1bus-openai` | empfohlen | OpenAI `text-embedding-3-large` mit Remote-Auth über OpenClaw/PLUR1BUS-Konfiguration |
| `plur1bus-openai-compatible` | stabil | OpenAI-kompatible Base URL, API-Key und Headers aus expliziter Remote-Konfiguration |
| `plur1bus-e5-small` | experimental | lokales `intfloat/multilingual-e5-small`; bleibt blocked/experimental bis ein echter Local-Model-Smoke grün ist |

Inspect/Register-Sicherheit:

- kein Modell-Download bei `plugins inspect` oder Provider-Registrierung
- kein Hugging-Face-Import bei `plugins inspect` oder Provider-Registrierung
- keine Secret-Auflösung bei `plugins inspect` oder Provider-Registrierung
- E5 wird erst bei echter `embedQuery`/`embedBatch`-Nutzung lazy geladen

### Reranker

| Provider | Status | Beschreibung |
|----------|--------|--------------|
| `cohere` | stabil | Remote-Reranker, empfohlen für produktive Re-Ranking-Pfade |
| `disabled` | stabil | Vector-only Recall ohne Re-Ranking |
| `local-transformers` | experimental | lokaler GTE-Reranker; blocked/experimental bis Local-Model-Smoke grün ist |

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
| `reranker.provider` | `cohere` | `cohere`, `local-transformers` oder `disabled` |
| `reranker.enabled` | `true` | An/Aus (fehlt `apiKey`, automatisch deaktiviert) |
| `reranker.apiKey` | — | Cohere API Key (`${COHERE_API_KEY}` empfohlen) |
| `reranker.model` | `rerank-v3.5` | Cohere Rerank-Modell |
| `reranker.candidates` | `20` | Vektor-Kandidaten vor dem Re-Ranking |

**Fallback:** Schlägt der Reranker fehl (Netzwerk, Rate-Limit, lokaler Model-Smoke), wird automatisch auf Vektor-Reihenfolge zurückgefallen. Kein Absturz. `local-transformers` fuer `Alibaba-NLP/gte-reranker-modernbert-base` ist experimental und English-primary.

---

## Schema

```
{ id, text, summary, origin, vector[3072], importance, category, createdAt, mergedFrom, expiresAt, storedBy }
```

- `summary` — LLM-generierte Kurzfassung (≤`summaryMaxWords` Wörter)
- `origin` — Herkunft/Evidenz, z. B. `"dm"` (Default), `"group"` (Gruppen-Chat),
  `"cron"` oder `"internal"`; kein Besitzsignal
- `expiresAt` — Unix-Timestamp (ms), `0` = permanent (TTL-Feld)
- `storedBy` — agentId des speichernden Agenten (Traceability)
- `mergedFrom` — IDs der zusammengeführten Quell-Memories
- Migration erfolgt automatisch beim ersten Zugriff auf bestehende DBs

Wenn PLUR1BUS Memories an einen Agenten zurückliefert, sind sie sein
zugänglicher Memory-Kontext fuer den aktuellen Agenten/Workspace. Ob ein
Memory agent-private, workspace-shared oder global-user sichtbar ist, ergibt
sich aus `scope`, `storedBy`, `agentId` und Namespace, nicht aus `origin`.

---

## Conflict-Log

`{workspaceDir}/.adaptive-learning/conflict-log.jsonl` protokolliert widersprüchliche `decision`-Memories zwischen verschiedenen Agenten.

**Trigger:** Neue `decision`-Memory ähnelt einer bestehenden eines anderen Agenten (Score 0.70–0.94).

**Kein Block** — nur Logging. Rotation nur nach expliziter Nutzer-Bestätigung.

Schema einer Zeile:
```json
{
  "timestamp": "2026-03-28T12:00:00.000Z",
  "newMemoryId": "uuid-neu",
  "newAgentId": "agent-a",
  "newText": "Wir nutzen PostgreSQL.",
  "existingMemoryId": "uuid-alt",
  "existingAgentId": "agent-b",
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
| Default agent | `~/.openclaw/memory/lancedb-namespaced/main/` |
| Agent A | `~/.openclaw/memory/lancedb-namespaced/agent-a/` |
| Agent B | `~/.openclaw/memory/lancedb-namespaced/agent-b/` |
| Person B | `~/.openclaw/memory/lancedb-namespaced/person-b/` |
