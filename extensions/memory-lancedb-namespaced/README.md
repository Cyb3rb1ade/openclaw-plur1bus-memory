# memory-lancedb-namespaced

Per-Agent isoliertes LanceDB-Memory-Plugin für OpenClaw.
Jeder Agent hat seine eigene Datenbank unter `{baseDbPath}/{agentId}/`.

**Aktuelle Version:** `4.0.1` — OpenClaw-native Memory-Augment-Integration plus optionaler PLUR1BUS Obsidian Living Dashboard-Schicht. Diese Korrektur harmonisiert Workspace Cards: konfigurierte Workspace-IDs schreiben kanonisch, waehrend alte `_neo/workspaces/<basename>` Daten als Legacy-Aliase lesbar bleiben. LanceDB/PLUR1BUS bleibt das fuehrende Memory-System; Obsidian ist keine zweite Memory-Datenbank. `memory_search` ist ein kompatibler Alias fuer den gleichen PLUR1BUS/LanceDB Recall-Pfad wie `memory_recall`.

**Mindestversion:** OpenClaw `2026.5.12-beta.6` oder neuer. PLUR1BUS v3.2 ist
gegen OpenClaw `2026.5.12` und `2026.5.18` validiert; ältere OpenClaw-Versionen bleiben
beim v2.1.x-Zweig.

**Beta16/2026.5.18-Kompatibilität:** Ab `3.2.3` deklariert PLUR1BUS die vier
stabilen Toolnamen zusätzlich in den OpenClaw-Tool-Factory-Options. Damit zeigt
`plugins inspect --json --runtime` unter OpenClaw `2026.5.16-beta.1` und `2026.5.18` die Tools
`memory_recall`, `memory_store`, `memory_forget` und `knowledge_update`
namentlich an.

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
- **Obsidian Bridge** — optionaler, default-ausgeschalteter Markdown/Vault-Layer fuer ReviewBundles, Doctor, Konflikte, Project Hubs, Task-Vorschlaege und Memory-Erklaerungen; Apply ist approval-gated und revalidiert Hashes/Preconditions
- **Secret-Hardening** — die OpenClaw-native Embedding-Provider-Bridge löst `${ENV_VAR}` nur fuer explizite OpenAI/OpenAI-compatible/PLUR1BUS Provider-Variablen und Provider-Header-Praefixe auf; beliebige Env-Reads werden abgelehnt
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

## PLUR1BUS Obsidian Bridge

Die Bridge macht Obsidian zur sichtbaren Review-, Dashboard- und Control-Room-Oberflaeche.
Sie ist optional, default-off und niemals die Quelle der Memory-Wahrheit.
PLUR1BUS bleibt fuer Recall, Merge, TTL, Provenance, Auto-Capture,
Knowledge-Promotion und LanceDB verantwortlich. `memory-core` bleibt Slot-
Owner; dieses Plugin setzt weiterhin kein `kind:"memory"` und ruft keine
Memory-Capability-Registrierung auf.

Default:

```json
{
  "obsidianBridge": {
    "enabled": false,
    "mode": "augment",
    "vaultPath": null,
    "workspaceRoot": null,
    "reviewRoot": "00-system/plur1bus",
    "requireUserApproval": true,
    "applyApprovedOnly": true,
    "writeManagedBlocks": true,
    "allowWrite": true,
    "allowDotObsidianWrite": false,
    "sourceOfTruth": "plur1bus-lancedb",
    "recallAuthority": "lancedb-reranked-vector",
    "capabilityPack": "full",
    "agents": {
      "include": ["*"],
      "equalCapabilities": true,
      "defaultProfiles": {
        "main": "standard",
        "bernhardine": "conservative",
        "heisenberg": "adversarial"
      }
    },
    "morningReview": {
      "enabled": false,
      "cron": "0 9 * * *",
      "timezone": "Europe/Zurich",
      "delivery": "announce",
      "session": "isolated",
      "writeReviewBundle": true,
      "applyMode": "manual"
    },
    "maintenance": {
      "daily": "light",
      "weekly": "deep"
    },
    "adversarial": {
      "daily": "light",
      "weekly": "deep"
    },
    "dashboardLayer": {
      "enabled": true,
      "records": true,
      "markdownDashboards": true,
      "bases": false,
      "dataview": false,
      "tasks": false,
      "autoLinkSuggestions": true
    },
    "semanticGraph": {
      "enabled": true,
      "proposalOnly": true,
      "mutateMemory": false
    }
  }
}
```

Alle Agenten sind funktional gleich. Unterschiede wie `main=standard`,
`bernhardine=conservative` oder `heisenberg=adversarial` sind nur Default-
Profile, keine Rechte. Jeder konfigurierte Agent kann Doctor, ReviewBundle,
Maintenance, Adversarial Review, Project Hubs, Konflikte, Memory-Erklaerung,
Hygiene, Task Extraction und approved Apply ausfuehren.

Die Bridge schreibt nur additive Dateien unter `reviewRoot`:

```text
00-system/plur1bus/
  README.md
  dashboards/
  dashboards/bases/
  records/
  review-bundles/
  proposals/
  doctor/
  conflicts/
  memory-explanations/
  stale-knowledge/
  project-hubs/
  provenance/
  impact-analysis/
  semantic-conflicts/
  duplicate-candidates/
  weekly/
  tasks/
  managed-blocks.log.jsonl
```

Wichtige Commands:

```text
/plur1bus obsidian doctor
/plur1bus obsidian review prepare
/plur1bus obsidian review show <bundleId>
/plur1bus obsidian review approve <bundleId> --items <ids|all|low-risk>
/plur1bus obsidian review reject <bundleId> --items <ids|all>
/plur1bus obsidian review snooze <bundleId> --items <ids> --until <date|duration>
/plur1bus obsidian review apply <bundleId>
/plur1bus obsidian morning-review
/plur1bus obsidian conflicts
/plur1bus obsidian records rebuild
/plur1bus obsidian dashboards build
/plur1bus obsidian bases build
/plur1bus obsidian semantic-conflicts build
/plur1bus obsidian duplicates scan
/plur1bus obsidian provenance build
/plur1bus obsidian impact analyze <memoryId|project|all>
/plur1bus obsidian links suggest
/plur1bus obsidian project-hub <topic>
/plur1bus obsidian memory explain <id> --deep
/plur1bus obsidian weekly build
/plur1bus obsidian soul patch
/plur1bus obsidian cron print-morning-review
/plur1bus obsidian cron install-morning-review --force
```

ReviewBundle-Frontmatter:

```yaml
---
type: plur1bus-review-bundle
version: 1
bundleId: rb-YYYY-MM-DD-HHmm
createdAt: ISO timestamp
workspaceKey: main
createdByAgent: main
status: pending_user_review
applyMode: approval_required
reviewProfiles:
  - standard
  - maintenance
  - adversarial
obsidianBridgeVersion: 4.0.1
---
```

`prepare` erzeugt Vorschlaege. `apply` liest das Bundle neu, revalidiert
Hashes/Preconditions, prueft Scope- und Trust-Regeln und wendet nur explizit
genehmigte Items an. Eine Obsidian-Checkbox ist nie ausreichend. Assistant-only
Assertions werden nicht zu trusted/global Memory; `agent_private` leakt nicht
ohne Genehmigung zu `workspace_shared`, und `workspace_shared` nicht ohne
explizite globale Freigabe zu `global_user`.

Managed Blocks:

```md
<!-- plur1bus:managed:start id="morning-summary" agent="main" bundle="rb-2026-05-23-0900" hash="sha256:..." -->
...
<!-- plur1bus:managed:end -->
```

Human-Text ausserhalb der Marker bleibt unangetastet. Hash-Mismatches werden
als Konflikt/Vorschlag behandelt. Pfad-Traversal wird abgelehnt, Schreibpfade
sind auf den Review-Root begrenzt, `.obsidian` wird nur geschrieben, wenn
`allowDotObsidianWrite:true` gesetzt ist.

Morning Review laeuft proposal-only: Snapshot/Lock, `maintenance_light`,
Change Collection, Proposal Generation, `adversarial_light`, Risk
Classification, Deduplication, ReviewBundle-Write, User Summary, dann Warten
auf explizite Freigabe. Empfohlener OpenClaw-Cron:

```bash
openclaw cron add \
  --name "PLUR1BUS Morning Review" \
  --cron "0 9 * * *" \
  --tz "Europe/Zurich" \
  --session isolated \
  --message "Run /plur1bus obsidian morning-review. Prepare proposals only. Run maintenance_light before proposal generation and adversarial_light before user presentation. Do not apply changes without explicit user approval. Write the ReviewBundle to Obsidian and return a concise approval summary." \
  --announce
```

Pure Markdown funktioniert ohne Obsidian-Plugins. Dataview/Bases/Tasks sind
optional und default-aus. Semantische Konflikte, Duplikate, Provenance, Impact
Analysis und Link Suggestions sind Vorschlaege/Dashboards, keine Memory-Wahrheit.

Failure und Recovery: Wenn Obsidian fehlt, deaktiviert, geloescht oder falsch
konfiguriert ist, laufen `memory_store`, `memory_recall`, `memory_forget` und
`knowledge_update` weiter. Recovery ist `obsidianBridge.enabled=false`,
OpenClaw-Cron deaktivieren/entfernen und bei Bedarf eine vorige
ClawHub/GitHub-Version installieren. PLUR1BUS-Memory-Daten bleiben
authoritativ und werden durch das Deaktivieren der Bridge nicht zerstoert.

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
