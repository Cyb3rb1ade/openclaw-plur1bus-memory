# Configuration — Recall & Memory Settings

Diese Datei dokumentiert alle Konfigurationsoptionen im Bereich **Recall**, **Deduplizierung** und **Embedding-Cache**.

Alle Werte werden in `openclaw.plugin.json` unter dem Key `recall` (oder den jeweiligen Plugin-Defaults) gesetzt.

---

## Recall-Pipeline

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `maxPromptMemories` | `number` | `12` | Maximale Anzahl Memories, die in den Prompt-Kontext aufgenommen werden |
| `candidateTopK` | `number` | `50` | Anzahl Kandidaten aus der initialen Vector-Search |
| `importanceBoost` | `boolean` | `true` | Aktiviert den Importance-Boost vor dem Re-Ranking |
| `canonicalFirst` | `boolean` | `true` | Kanonische Repräsentanten vor nicht-kanonischen bevorzugen |
| `canonicalMinScore` | `number` | `0.65` | Mindest-Score für ein Memory, um als kanonisch gelten zu können |
| `canonicalMaxItems` | `number` | `5` | Maximal `N` kanonische Items pro Cluster im finalen Prompt |

---

## Deduplizierung

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `dedup` | `number` | `0.78` | Jaccard-ähnlichkeits-Threshold für Near-Duplicate-Erkennung (0.0–1.0) |
| `dedupJaccard` | `boolean` | `true` | Nutzt Jaccard-Ähnlichkeit statt reiner Cosine-Similarity für Dedup |

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
  "longContext": 365,
  "project": 365
}
```

- **`transient`** (60 d): Kurzlebige Beobachtungen, Tool-Ausgaben, flüchtige Hinweise
- **`episodic`** (180 d): Episodische Erinnerungen, Session-Zusammenfassungen
- **`longContext`** / **`project`** (365 d): Langfristiges Wissen, Projekt-Setups, Behavior Cards

> Alte, globale `halfLifeDays`-Werte bleiben erhalten, werden aber nur als Fallback verwendet, wenn kein Typ-Mapping existiert.

---

## Embedding-Cache

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `embeddingCacheEnabled` | `boolean` | `true` | LRU-Cache für Embedding-Vektoren aktivieren |
| `embeddingCacheTtlMs` | `number` | `300000` | TTL eines Cache-Eintrags in Millisekunden (5 Minuten) |
| `embeddingCacheMaxEntries` | `number` | `1000` | Maximale Anzahl gecachter Vektoren |

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
    "candidateTopK": 50,
    "dedup": 0.78,
    "dedupJaccard": true,
    "canonicalFirst": true,
    "canonicalMinScore": 0.65,
    "canonicalMaxItems": 5,
    "halfLifeDaysMap": {
      "transient": 60,
      "episodic": 180,
      "longContext": 365,
      "project": 365
    },
    "embeddingCacheEnabled": true,
    "embeddingCacheTtlMs": 300000,
    "embeddingCacheMaxEntries": 1000
  }
}
```
