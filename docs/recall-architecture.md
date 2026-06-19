# Recall Architecture — Engram Pipeline

Dieses Dokument beschreibt den vollständigen Recall-Fluss von der Query bis zur finalen Memory-Auswahl.

---

## Überblick

```
User Query / Kontext
        │
        ▼
┌───────────────────┐
│  Embedding Cache  │◄──────── LRU (TTL 5 min, max 128)
│   (optional Hit)  │
└─────────┬─────────┘
          │ Miss
          ▼
┌───────────────────┐
│  Embedding Model  │
│ (local / remote)  │
└─────────┬─────────┘
          ▼
┌───────────────────┐
│  Vector Search    │◄──────── candidateTopK (default 50)
│   (LanceDB ANN)   │
└─────────┬─────────┘
          ▼
┌───────────────────┐
│ Importance Boost  │◄──────── importanceBoost (default true)
│  + Time Decay     │
└─────────┬─────────┘
          ▼
┌───────────────────┐
│    Re-Ranker      │◄──────── Cohere → Local Fallback
│  (Score + Mood)   │
└─────────┬─────────┘
          ▼
┌───────────────────┐
│  Graph Spread     │◄──────── Memory Graph (semantic / temporal / episodic)
│ (associative +2)  │
└─────────┬─────────┘
          ▼
┌───────────────────┐
│    Deduplicate    │◄──────── dedup 0.78 + Jaccard + Akronym-Erkennung
└─────────┬─────────┘
          ▼
┌───────────────────┐
│   Canonical Pick  │◄──────── canonicalFirst, canonicalMinScore 0.65
│   (max 5 items)   │
└─────────┬─────────┘
          ▼
┌───────────────────┐
│   Adaptive Tiers  │◄──────── Budget-Allokation nach Typ
│  (transient →     │           transient : episodic : longContext
│   episodic →      │
│   longContext)    │
└─────────┬─────────┘
          ▼
┌───────────────────┐
│   Top-N Trim      │◄──────── maxPromptMemories (default 12)
└─────────┬─────────┘
          ▼
┌───────────────────┐
│ Recall Compression│◄──────── semantische Kürzung langer Inhalte
│   (Prompt-Build)  │
└─────────┬─────────┘
          ▼
   Prompt Context
```

---

## Schritt-für-Schritt

### 1. Embedding

- Der Benutzer-Query (oder der aktuelle Turn-Kontext) wird in einen Vektor umgewandelt.
- **Embedding-Cache**: Vor dem Modell-Aufruf wird ein LRU-Cache abgefragt (Key = SHA-256 des normalisierten Textes). Hit → sofortiger Return; Miss → Modell-Aufruf + Cache-Write.

### 2. Vector Search

- ANN-Suche in LanceDB mit `candidateTopK` (default 50).
- Rückgabe: Ungefilterte Kandidaten mit Cosine-Similarity-Score.

### 3. Importance Boost + Time Decay

- Jeder Kandidat erhält einen kombinierten Score:
  - Basis: Vector-Search-Score
  - `+` Importance-Boost (höhere `importance` → höherer Score)
  - `*` Time-Decay nach typbasierter Half-Life (`halfLifeDaysMap`)

### 4. Re-Ranking

- Chained Reranker (Cohere primary → Local Transformers fallback) ordnet die Kandidaten neu.
- Emotionaler State wirkt als stimmungsabhängiger Multiplikator auf den finalen Re-Rank-Score.

### 5. Graph-basierter Assoziativer Spread

- Aus den Top-Kandidaten werden über den **Memory Graph** (Edge-Typen: `semantic`, `temporal`, `episodic`) bis zu 2 assoziierte Memories pro Kandidat geholt.
- Der neue **Graph-Index** (invertierter Index auf Edge-Typ + Ziel-Memory) beschleunigt diese Abfrage.

### 6. Deduplizierung

- Near-Duplicate-Erkennung via Jaccard-Ähnlichkeit (`dedupJaccard: true`).
- Threshold: `0.78`.
- **Akronym-Erkennung**: semantisch ähnliche Akronyme werden als identisch behandelt.
- Von jedem Duplikat-Cluster bleibt das beste Item (höchster Score) übrig.

### 7. Kanonische Auswahl

- `canonicalFirst: true` hebt kanonische Repräsentanten auf die erste Ebene.
- Ein Memory ist kanonisch, wenn sein Score ≥ `canonicalMinScore` (0.65) ist.
- Pro Cluster werden maximal `canonicalMaxItems` (5) kanonische Items weitergegeben.

### 8. Adaptive Budget-Allokation (Tiers)

- Das verfügbare Budget (`maxPromptMemories`) wird dynamisch nach Typ aufgeteilt:
  - **transient** – schnell vergessende Beobachtungen
  - **episodic** – narrative Episoden
  - **longContext / project** – dauerhaftes Wissen
- Die Allokation passt sich an die Verteilung der Kandidaten an; dominiert ein Typ, kann er bis zu einem harten Limit mehr Budget absorbieren.

### 9. Top-N Trim

- Hartes Limit `maxPromptMemories` (default 12).
- Alles über dem Limit wird verworfen.

### 10. Recall-Kompression

- Lange Memory-Inhalte werden semantisch komprimiert, bevor sie in den Prompt eingebaut werden.
- Reduziert Token-Verbrauch ohne signifikanten Informationsverlust.

---

## Neue Komponenten im Engram-Release

| Komponente | Zweck |
|------------|-------|
| **Embedding-Cache** | Vermeidet redundante Embedding-Calls; 40 % schnellerer Hot-Path |
| **Adaptive Budget** | Typ-gerechte Verteilung des knappen Prompt-Platzes |
| **Tier-Allocation** | transient / episodic / longContext Budget-Slots |
| **Graph-Index** | Invertierter Index für O(1) Edge-Lookups statt Full-Scan |
| **Reinforcement** | Erfolgreiche Recalls (niedrige Re-Rank-Distanz) stärken `memoryStrength` leicht |
