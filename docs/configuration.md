# Configuration — Recall & Memory Settings

Diese Datei dokumentiert alle Konfigurationsoptionen im Bereich **Recall**, **Deduplizierung** und **Embedding-Cache**.

Alle Werte werden in `openclaw.plugin.json` unter dem Key `recall` (oder den jeweiligen Plugin-Defaults) gesetzt.

---

## Recall-Pipeline

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `maxPromptMemories` | `number` | `12` | Maximale Anzahl Memories, die in den Prompt-Kontext aufgenommen werden |
| `candidateTopK` | `number` | `40` | Anzahl Kandidaten aus der initialen Vector-Search |
| `importanceBoost` | `number` | `0.3` | Faktor des Importance-Boost vor dem Re-Ranking (0.0–1.0) |
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
| `embeddingCacheEnabled` | `boolean` | `false` | LRU-Cache für Embedding-Vektoren aktivieren |
| `embeddingCacheTtlMs` | `number` | `1800000` | TTL eines Cache-Eintrags in Millisekunden (30 Minuten) |
| `embeddingCacheMaxEntries` | `number` | `500` | Maximale Anzahl gecachter Vektoren |

### Verhalten

- Der Cache speichert Embedding-Vektoren **pro Text-Hash** (SHA-256 der normalisierten Eingabe).
- Treffer vermeiden wiederholte API-/Modell-Aufrufe und beschleunigen den Recall-Hot-Path um bis zu 40 %.
- Bei Cache-Miss wird der Embedding-Provider wie gewohnt aufgerufen; das Ergebnis wird synchron in den LRU geschrieben.
- Der Cache wird bei Plugin-Restart invalidiert (reiner In-Memory-Cache).

---

## Beispiel-Konfiguration (Minimal)

```json
{
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
    },
    "embeddingCacheEnabled": false,
    "embeddingCacheTtlMs": 1800000,
    "embeddingCacheMaxEntries": 500
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
| `emotion.t3.enabled` | `boolean` | `false` | Tier-3 (LLM-basiert) aktivieren — **kostet API-Calls** |
| `emotion.t3.model` | `string` | `"gpt-4o-mini"` | Modell für Tier-3 |
| `emotion.t3.apiKey` | `string` | — | Optionaler API-Key (fallback zu `OPENAI_API_KEY`) |
| `emotion.t3.baseUrl` | `string` | — | Optionaler Base-URL für OpenAI-compatible Provider |

### Budget-Gate

Tier-3 läuft **niemals heimlich**. Es wird nur aktiviert, wenn:
1. `emotion.t3.enabled === true`
2. Ein gültiger API-Key verfügbar ist

Der Feature-Toggle `/enable emotionTier` (bzw. `/disable emotionTier`) steuert `emotion.t3.enabled`.

### Beispiel

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-namespaced": {
        "config": {
          "emotion": {
            "tier": "auto",
            "t2": { "enabled": true },
            "t3": { "enabled": false, "model": "gpt-4o-mini" }
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
