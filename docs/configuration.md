# Configuration — Recall, Runtime & Memory Settings

Diese Datei dokumentiert die wichtigsten Konfigurationsfelder rund um **Recall**, **Embedding-Cache**, **Emotion** und **Obsidian-Graph-Links**.

Die Recall-/Dedupe-Optionen liegen in `openclaw.json` unter
`plugins.entries.memory-lancedb-namespaced.config.recall`. Runtime-Optionen
liegen entsprechend unter `plugins.entries.memory-lancedb-namespaced.config.runtime`.

---

## Recall-Pipeline

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `maxPromptMemories` | `number` | `12` | Maximale Anzahl Memories, die in den Prompt-Kontext aufgenommen werden |
| `candidateTopK` | `number` | `40` | Anzahl Kandidaten aus der initialen Vector-Search |
| `importanceBoost` | `number` | `0.3` | Faktor des Importance-Boost vor dem Re-Rankings (0.0–1.0) |
| `canonicalFirst` | `boolean` | `true` | Kanonische Repräsentanten vor nicht-kanonischen bevorzugen |
| `canonicalMinScore` | `number` | `0.30` | Mindest-Score für ein Memory, um als kanonisch gelten zu können |
| `canonicalMaxItems` | `number` | `5` | Maximal `N` kanonische Items pro Cluster im finalen Prompt |

---

## Deduplizierung

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `dedup` | `boolean` | `true` | Near-Duplicate-Erkennung aktivieren |
| `dedupJaccard` | `number` | `0.78` | Jaccard-ähnlichkeits-Threshold für Near-Duplicates (0.0–1.0) |

> **Hinweis:** Ein höherer `dedup`-Wert führt zu aggressiverer Entfernung. `0.78` bedeutet, dass Memories mit ≥78 % Token-Überlappung als Duplikate gelten.

---

## Halbwertszeit (Typbasiert)

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `halfLifeDaysMap` | `object` | siehe unten | Typ-spezifische Halbwertszeiten in Tagen |

### Defaults von `halfLifeDaysMap`

```json
{
  "transient": 60,
  "episodic": 180,
  "longContext": 600,
  "project": 600
}
```

- **`transient`** (60 d): Kurzlebige Beobachtungen, Tool-Ausgaben, flüchtige Hinweise
- **`episodic`** (180 d): Episodische Erinnerungen, Session-Zusammenfassungen
- **`longContext`** / **`project`** (600 d): Langfristiges Wissen, Projekt-Setups, Behavior Cards

> Alte, globale `halfLifeDays`-Werte bleiben erhalten, werden aber nur als Fallback verwendet, wenn kein Typ-Mapping existiert.

---

## Embedding-Cache

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `runtime.embeddingCacheEnabled` | `boolean` | `true` | LRU-Cache für Embedding-Vektoren aktivieren (seit v6.2.1 aktiv verdrahtet). |
| `runtime.embeddingCacheMaxEntries` | `number` | `128` | Maximale Anzahl im Memory-Cache; Legacy-Alias ist `embeddingCacheMaxEntries`. |
| `runtime.embeddingCacheTtlMs` | `number` | `300000` | TTL eines Cache-Eintrags in Millisekunden (5 Minuten). |
| `runtime.embeddingCachePersist` | `boolean` | `false` | SQLite-Persistenz nach `embeddingCacheScope` (`agent`/`shared`) aktivieren. |
| `runtime.embeddingCachePersistDebug` | `boolean` | `false` | Persistenz-Debugs im Logger aktivieren. |
| `runtime.embeddingCacheCoalesce` | `boolean` | `true` | Identische Anfragen deduplizieren (ein Call statt N Calls). |
| `runtime.embeddingCacheMetrics` | `boolean` | `false` | Metriken für Hits, Misses, Persist-Hits und Coalescing emitten. |
| `runtime.embeddingCacheScope` | `"agent" \| "shared"` | `"agent"` | Scope-Kennung für den Cache-Key. `shared` teilt Cache-Scope pro Plugin. |
| `runtime.embeddingCacheMaxBytes` | `number` | `1073741824` (`agent`) / `5368709120` (`shared`) | Maximale persistente Speichergröße (Soft-Limit bei 90 %). |

### Verhalten

- Der Cache-Key ist `provider + model + dimensions + scopeId + cacheVersion + sha256(normalizedText)`.
- Treffer vermeiden wiederholte Embedding-Anfragen und beschleunigen den Recall-Hot-Path typischerweise deutlich.
- Bei Cache-Miss wird der Embedding-Provider wie gewohnt aufgerufen; Ergebnis wird per Request-Coalescing in den LRU-Cache geschrieben.
- Mit aktivierter Persistenz wird der Cache zusätzlich nach `embeddingCacheScope` in SQLite (`embedding-cache-v2/*.db`) gespeichert; bei hartem Byte-Limit wird auf Soft-Limit-Backoff umgeschaltet.
- Bei Plugin-Neustart bleibt der persistente Teil erhalten; der Memory-Teil wird neu aufgebaut.

---

## LLM-Result-Cache

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `runtime.llmResultCacheEnabled` | `boolean` | `true` | Exakten Ergebnis-Cache für deterministische interne LLM-Transformationen aktivieren. |
| `runtime.llmResultCacheTtlMs` | `number` | `86400000` | Absolute TTL eines Eintrags in Millisekunden (24 h); wird auf 60 s–7 d geclampet. |
| `runtime.llmResultCacheMaxEntries` | `number` | `256` | Maximale Anzahl Einträge im Memory-Cache; Obergrenze 10.000 (Clamp mit Warnung). |
| `runtime.llmResultCachePersist` | `boolean` | `false` | SQLite-Persistenz aktivieren (benötigt Node ≥ 22.5 für `node:sqlite`; sonst Memory-only). |
| `runtime.llmResultCacheMaxBytes` | `number` | `67108864` | Maximale persistente Speichergröße (Soft-Limit bei 90 %); Obergrenze 1 GiB (Clamp mit Warnung). |
| `runtime.llmResultCacheMetrics` | `boolean` | `true` | Metriken für Hits, Misses, Persist-Hits und vermiedene Tokens emittieren (sichtbar in `/state`). |

### Verhalten

- Es werden ausschließlich exakte, agent-scoped Ergebnisse einer Allowlist deterministischer interner Transformationen gecacht (Capture-/Recall-Zusammenfassungen, Merge- und Konflikt-Entscheidungen, Emotions-, Episoden-, Skill- und REM-Analysen, KNOWLEDGE-Updates). Hauptchat, Critical-Classifier, Dream-Narrative und andere nicht-deterministische Pfade bleiben immer live.
- Der Cache-Key ist ein SHA-256 über Version, Purpose, Scope, Endpoint, Credential-Hash, Modell, Messages und Generierungsoptionen; Prompts, Credentials und Header fließen nur gehasht ein und werden nie persistiert.
- Die Persistenz speichert Antworttexte im Klartext unter `llm-result-cache-v1/{agentId}.db` (Verzeichnis `0o700`, Datei `0o600`) — daher Opt-in.
- Fehler, leere Antworten und invalide JSON-Mode-Ergebnisse werden nie gecacht; Cache-Defekte fallen immer auf Live-Calls zurück (Fail-open).
- Die integrierten Call-Sites senden `temperature: 0`; seit diesem Feature reicht `lib/llm-call.js` `temperature` auch tatsächlich an den Provider durch (vorher wurde der Wert ignoriert).

---

## Chat-LLM-Routing über OpenClaw

Ein nicht gesetztes Feature-Modell (`model` absent) verwendet das effective
OpenClaw agent model des Ziel-Agenten. PLUR1BUS hat keinen globalen
Chat-Modell-Default und erbt keine Route zwischen Features: `schicht15`,
`skillMiner`, `criticalPush` und `emotion.t3` übernehmen insbesondere weder
`merging.model` noch dessen Endpoint, Credential oder Header.

Jeder aktivierte Chat-Aufruf löst genau einen von vier Route-Modi auf:

- `openclaw-default`: native OpenClaw-Completion ohne `model`-Property; OpenClaw wählt das effektive primäre Agentenmodell.
- `openclaw-override`: ein feature-lokales `model` ohne direkte Transportfelder; OpenClaw verwaltet Provider und Credentials.
- `direct-override`: feature-lokales `model` plus `baseUrl`, aufgelöstes `apiKey` oder nicht-leere `headers`; der bestehende begrenzte OpenAI-kompatible Direktpfad wird verwendet.
- `unavailable`: die Route kann sicher keinen Request senden. Direct transport without a feature-local model fails closed as an ambiguous partial override.

`failed` ist der stabile Diagnosewert für einen gescheiterten Transport, kein
fünfter Auswahlmodus. Erfolgreiche native Ergebnisse übernehmen ausschließlich
die von OpenClaw zurückgegebenen Provider-/Modellwerte in die Diagnose; Prompts,
Credentials und Auth-Header werden nicht aufgezeichnet. Native routes bypass
the PLUR1BUS result cache; nur vollständige `direct-override`-Routen behalten
den exakten PLUR1BUS-Ergebnis-Cache.

A configured credential that is unresolved is unavailable. PLUR1BUS never
substitutes native OpenClaw host credentials, erfindet keine Host-Credential-
Fallback-Kette und bricht deshalb nicht die gesamte Plugin-Registrierung ab.
`runtime.llm.complete` missing or unavailable is fail-soft: das owning Feature
nutzt seinen bestehenden Skip-/Fallbackpfad, ohne einen zweiten Modellversuch.

### Agentenbindung und Trust

A session-bound command capability omits `agentId`, weil sie bereits an die
aktive Session gebunden ist. Global hook, tool, and background calls senden den
Ziel-Agenten und benötigen am Plugin-Entry
`llm.allowAgentIdOverride:true`. A model-only native override requires
`llm.allowModelOverride:true` und muss gegebenenfalls in `allowedModels`
zugelassen sein. Eine Policy-Ablehnung bleibt fail-soft; PLUR1BUS wiederholt
den Request nicht ohne Agent oder Modell. Installer `preserve` never grants LLM
trust; Safe und Recommended setzen ebenfalls keine dieser Entry-Level-Bits.

`runtime.llm.complete` resolves the effective primary selection and does not
execute the configured model fallback array in the installed Runtime. Die
Fallback-Policy bleibt OpenClaw-Konfiguration, aber PLUR1BUS behauptet oder
implementiert keine Host-Fallback-Kette.

Komplette explizite Direkt-Overrides bleiben möglich, müssen aber vollständig
feature-lokal sein. Beispiel:

```json
{
  "merging": {
    "enabled": true,
    "model": "vendor/merge-model",
    "baseUrl": "https://llm.example/v1",
    "apiKey": "${MERGING_LLM_API_KEY}"
  }
}
```

Das benannte Modell ist nur ein explizites Override-Beispiel, kein Default.

---

## Beispiel-Konfiguration (Minimal)

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-namespaced": {
        "enabled": true,
        "config": {
          "autoCapture": true,
          "autoRecall": true,
          "recall": {
            "maxPromptMemories": 12,
            "candidateTopK": 40,
            "importanceBoost": 0.3,
            "dedup": true,
            "dedupJaccard": 0.78,
            "canonicalFirst": true,
            "canonicalMinScore": 0.30,
            "canonicalMaxItems": 5,
            "halfLifeDaysMap": {
              "transient": 60,
              "episodic": 180,
              "longContext": 600,
              "project": 600
            }
          },
          "runtime": {
            "embeddingCacheEnabled": true,
            "embeddingCacheMaxEntries": 128,
            "embeddingCacheTtlMs": 300000,
            "embeddingCachePersist": false,
            "embeddingCachePersistDebug": false,
            "embeddingCacheCoalesce": true,
            "embeddingCacheMetrics": false,
            "embeddingCacheScope": "agent",
            "llmResultCacheEnabled": true,
            "llmResultCacheTtlMs": 86400000,
            "llmResultCacheMaxEntries": 256,
            "llmResultCachePersist": false,
            "llmResultCacheMaxBytes": 67108864,
            "llmResultCacheMetrics": true,
            "recallCacheTtlMs": 120000,
            "recallCacheMaxEntries": 128
          }
        }
      }
    }
  }
}
```

---

## Emotion Tier-Config

Steuert die 3-Tier-Emotions-Inferenz beim Memory-Capture.

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `emotion.tier` | `"t1" \| "t2" \| "t3" \| "auto"` | `"auto"` | Festes Tier oder automatisches Routing |
| `emotion.t2.enabled` | `boolean` | `true` | Tier-2 (Keyword-Fallback) aktivieren |
| `emotion.t3.enabled` | `boolean` | `false` | Tier-3 (LLM-basiert) aktivieren — **provider-gated/fail-soft**: kein API-Call ohne verfügbare native oder vollständige direkte Route |
| `emotion.t3.model` | `string` | — | Wenn `model` absent ist, gilt das effective OpenClaw agent model; kein Fallback zu `merging.model` |
| `emotion.t3.apiKey` | `string` | — | Optionales feature-lokales Credential für einen direkten Override; benötigt ein explizites `emotion.t3.model` |
| `emotion.t3.baseUrl` | `string` | — | Optionaler feature-lokaler Endpoint für einen direkten Override; benötigt ein explizites `emotion.t3.model` |

### Budget-Gate

Tier-3 läuft **niemals heimlich**. Der Manifest-Default ist `enabled:false`;
das explizite Recommended-Profil kann es einschalten. Auch dann erfolgt kein
API-Call, wenn keine vollständige native oder direkte Route verfügbar ist
(`onlyWhenProviderAvailable: true`). Providerfehler bleiben fail-soft
(`fallbackOnError: true` → Fallback auf Tier-2).

Ohne native OpenClaw-Completion und ohne vollständigen expliziten Direkt-
Override bleibt Tier-3 stumm. Embedding-Provider und -Credentials sind dafür
nicht maßgeblich.

Der Feature-Toggle `/disable emotionTier` steuert `emotion.t3.enabled` auf `false`.

### Explizites Override-Beispiel

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-namespaced": {
        "config": {
          "emotion": {
            "tier": "auto",
            "t2": { "enabled": true },
            "t3": { "enabled": true, "model": "gpt-4o-mini", "fallbackOnError": true, "onlyWhenProviderAvailable": true }
          }
        }
      }
    }
  }
}
```

---

## Obsidian Bridge — Graph Links & Semantic Discovery

Diese Optionen steuern die wikilink-basierten Graph-Blöcke in Record-Notes und den optionalen semantischen Link-Index.

### `obsidianBridge.graphLinks`

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `maxPerNote` | `number` | `5` | Maximale Anzahl Links pro Note |
| `tiers` | `string[]` | `["explicit", "type", "semantic"]` | Verwendete Link-Tiers |
| `includeSemantic` | `boolean` | `false` | Semantische Links aus `.plur1bus/link-index.json` einbinden |
| `semanticThreshold` | `number` | `0.78` | Ähnlichkeits-Threshold für semantische Links |
| `blockId` | `string` | `"graph-links"` | ID des Managed Blocks |

- **Tier `explicit`**: Verweise aus `memoryIds`, `source_memories` und `sourceRefs`.
- **Tier `type`**: Typ-basierte Regeln (z. B. Kandidat ↔ Entscheidung, Review-Items im selben Bundle).
- **Tier `semantic`**: Vorberechnete Ähnlichkeits-Links aus dem Link-Index.

### `obsidianBridge.graphLinks.semanticDiscovery`

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `enabled` | `boolean` | `false` | Automatischen Bau des semantischen Link-Index aktivieren |
| `maxPerRun` | `number` | `500` | Maximal zu verarbeitende Records pro Lauf |
| `maxLinksPerRecord` | `number` | `5` | Maximale semantische Links pro Record |
| `threshold` | `number` | `0.78` | Cosine-Similarity-Threshold für semantische Paare |
| `topK` | `number` | `20` | Kandidaten-Fenster für die ANN-Suche |

> Der semantische Link-Index wird nur geschrieben, wenn er explizit bestätigt (`confirm: true`) oder über einen internen Befehl mit Bestätigung angestoßen wird. Er wird nicht automatisch beim Recall angewendet.
