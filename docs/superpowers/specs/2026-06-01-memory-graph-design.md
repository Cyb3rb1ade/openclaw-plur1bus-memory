# Phase 4: Memory-Graph (Assoziative Verknüpfung) — Design Spec

> **Status:** Approved by user. Ready for implementation.

## Goal

Echte graphenbasierte assoziative Verknüpfung zwischen Memories, Entitäten und Episoden. Jede Erinnerung hat Links zu verwandten Erinnerungen. Recall durch assoziative Kette: "Eine Erinnerung ruft andere hervor."

## Architecture

Hybrid-Ansatz: Neo-Store JSONL für Graph-Persistenz + LanceDB für semantische Candidate-Generierung. Graph wird im `agent_end` Hook inkrementell aufgebaut und beim Recall traversiert.

## Edge Schema

```javascript
{
  source: string,           // memoryId (kanonisch kleiner bei ungerichtet)
  target: string,           // memoryId (kanonisch größer bei ungerichtet)
  type: 'semantic' | 'temporal' | 'entity' | 'emotional' | 'episode',
  strength: number,         // 0.0 – 1.0
  directed: boolean,        // semantic/entity/emotional/episode = false, temporal = true
  createdAt: string,        // ISO timestamp
  updatedAt: string,        // ISO timestamp
  lastReinforcedAt: string, // ISO timestamp
  observations: number,     // wie oft diese Kante verstärkt wurde
  algorithmVersion: string  // z.B. "1.0"
}
```

### Kanonische Edge-ID

Für ungerichtete Kanten:
```javascript
const [a, b] = [sourceId, targetId].sort();
const edgeKey = `${a}:${b}:${type}`;
```

Für gerichtete Kanten:
```javascript
const edgeKey = `${sourceId}:${targetId}:${type}`;
```

## Edge-Typen

### 1. Semantic
- **Generierung:** LanceDB-Vektor-Suche mit dem neuen Memory als Query. Top-20 Ergebnisse mit Similarity ≥ 0.78.
- **Strength-Berechnung:**
  ```javascript
  function semanticStrength(similarity) {
    return clamp((similarity - 0.78) / (0.95 - 0.78), 0, 1) * 0.9;
  }
  ```
  - 0.78 → schwache Kante (~0.0)
  - 0.86 → mittlere Kante (~0.42)
  - 0.95+ → starke Kante (~0.9)
- **Richtung:** ungerichtet

### 2. Temporal
- **Generierung:** Verbinde neues Memory mit den letzten 5–10 Memories derselben Session (innerhalb 30 Minuten).
- **Strength:**
  ```javascript
  strength = Math.exp(-deltaMinutes / 15) * 0.7;
  ```
- **Richtung:** gerichtet (`source` = früheres Memory, `target` = späteres Memory)
- **Limits:** max. 10 temporale Edges pro Memory

### 3. Entity
- **Generierung:** Shared `entities` oder `topics` zwischen zwei Memories.
- **Strength:** `overlapRatio * 0.8`
- **Richtung:** ungerichtet

### 4. Emotional
- **Generierung:** Gleiche `emotionalDominant` + Intensitäts-Match.
- **Strength:** `intensityMatch * 0.6`
- **Richtung:** ungerichtet

### 5. Episode
- **Generierung:** Memories derselben Episode werden **nicht** direkt verknüpft (vermeidet Cliquen).
- **Stattdessen:** Episode-Anchor-Knoten.
  - Jede Episode erhält einen virtuellen Knoten (`episode-{episodeId}`).
  - Alle Memories der Episode erhalten eine ungerichtete Kante zum Anchor.
  - Strength: `episode.vividness * 0.85`
- **Richtung:** ungerichtet

## Graph-Aufbau (agent_end Hook)

```
Neue Memories der Session sammeln
  │
  ├──► Semantic Edges
  │     └── LanceDB.search(vector, limit=20, threshold=0.78)
  │         └── Für jeden Treffer: semanticStrength(similarity)
  │
  ├──► Temporal Edges
  │     └── Letzte 5–10 Memories derselben Session
  │
  ├──► Entity Edges
  │     └── Shared entities/topics mit anderen Session-Memories
  │
  ├──► Emotional Edges
  │     └── Gleiche emotionalDominant
  │
  └──► Episode Anchors
        └── Für jede betroffene Episode: Edge zu episode-{id}

Alle neuen Edges → memory-graph.jsonl (append-only)
Deduplizierung bei readGraph(): stärkste Kante gewinnt
```

## Graph-Lesen & Deduplizierung

```javascript
function readGraph() {
  // Lädt memory-graph.jsonl
  // Gruppiert nach edgeKey
  // Behält stärkste strength
  // Summiert observations
  // Aktualisiert updatedAt
  // Baut bidirektionale Adjazenzliste: Map<memoryId, Edge[]>
}
```

## Assoziative Traversierung (Beam Search)

```javascript
const GRAPH_TRAVERSAL = {
  seedCount: 5,               // Top-N aus Phase-3-Recall
  maxDepth: 3,
  maxNeighborsPerNode: 8,
  minCumulativeRelevance: 0.2,
  maxVisitedNodes: 150,
  maxAssociatedResults: 40
};
```

### Algorithmus

1. **Seed:** Top-5 Memories aus Phase 3 (nach Emotional Boost).
2. **Queue:** Priority Queue sortiert nach `associativeRelevance DESC`.
3. **Visited:** `Set<memoryId>` (Zyklen-Schutz). Wenn Node bereits besucht → Pfad abbrechen.
4. **Expansion:** Für aktuelle Node:
   - Hole alle Edges aus Adjazenzliste.
   - Sortiere nach `strength DESC`.
   - Nimm max. 8 stärkste.
   - Für jeden Nachbarn:
     - `cumulativeRelevance *= edge.strength`
     - `depth += 1`
     - Stop wenn `cumulativeRelevance < 0.2` oder `depth > 3`
5. **Score-Berechnung für assoziierte Memories:**
   ```javascript
   const pathStrength = productOfEdgeStrengthsAlongPath;
   const depthPenalty = 1 / (1 + depth * 0.25);
   const associatedScore = seedScore * pathStrength * depthPenalty;
   ```
6. **Merging mit Phase-3-Ergebnissen:**
   ```javascript
   if (memoryAlreadyInResults) {
     finalScore = Math.max(originalScore, 0.6 * originalScore + 0.4 * associatedScore);
   } else {
     finalScore = associatedScore * 0.85; // leichte Dämpfung für Graph-only
   }
   ```

## Recall-Pipeline Erweiterung

```
Phase 1: Vektor-Suche (LanceDB) → 20 Kandidaten
Phase 2: Importance Boost
Phase 3: Emotional Boost
Phase 4: 🕸️ ASSOZIATIVER SPREAD (NEU)
         └── traverseGraph(top5FromPhase3) → bis zu 40 assoziierte Memories
Phase 5: Reranker
```

## Graph-Pruning & Compaction

### Pruning-Regeln

```javascript
function shouldPrune(edge) {
  return (
    edge.strength < 0.2 &&
    edge.observations <= 1 &&
    edge.type !== 'episode' &&
    olderThan(edge.createdAt, 60, 'days') &&
    olderThan(edge.lastReinforcedAt ?? edge.createdAt, 60, 'days')
  );
}
```

### Compaction-Strategie

- `memory-graph.jsonl` — append-only aktuelles Log
- Monatlich: `compactGraph()`
  - Lädt alle Edges
  - Dedupliziert (stärkste Kante, summierte observations)
  - Entfernt geprunte Edges
  - Schreibt `memory-graph.compacted.jsonl`
  - Archiviert altes Log

## Neo-Store Integration

- `memory-graph.jsonl` — append-only Edge-Log
- `readGraph()` — Lade + dedupliziere + baue Adjazenzliste
- `appendGraphEdges(edges)` — append-only Write

## LanceDB-Integration

- **Semantic Candidate-Generierung:** `db.search(vector, limit=20, threshold=0.78)`
- **Batch-Update:** `relatedCount` wird **nicht** einzeln aktualisiert. Stattdessen:
  - Sammle `relatedCount` pro Memory nach Graph-Build.
  - Batch-Update betroffener Rows (oder: `relatedCount` erst gar nicht persistieren, sondern aus Graph berechnen).

## Vault-Ausgabe

- `/memory/graph/` — Monatlicher "Memory-Constellation"-Report
  - Mermaid-Diagramm der stärksten Verbindungen
  - Cluster-Analyse (Community-Detection heuristisch)
  - Top-Hub-Memories (höchster Degree)

## Debug Metrics

```javascript
const GRAPH_METRICS = {
  edgesCreatedPerSession: number,
  edgesByType: { semantic: n, temporal: n, entity: n, emotional: n, episode: n },
  avgDegree: number,
  maxDegree: number,
  prunedEdges: number,
  traversalVisitedNodes: number,
  associativeResultsAdded: number,
  recallLatencyMs: number,
  topEdgeTypesUsedInRecall: string[]
};
```

## Files

- **Create:** `lib/memory-graph.js` — Graph-Engine (Aufbau, Lesen, Traversierung, Pruning)
- **Modify:** `index.js` — Graph-Build im `agent_end` Hook, Recall-Pipeline erweitern
- **Modify:** `lib/neo-arch.js` — `memory-graph.jsonl` Store-Funktionen
- **Modify:** `lib/recall-pipeline.js` — Assoziativer Spread
- **Modify:** `lib/obsidian-bridge.js` — Vault-Ausgabe für Graph-Visualisierung

## Tech Stack

- Node.js ESM
- LanceDB (Vektor-Suche für Semantic-Candidates)
- Neo-Store JSONL (Graph-Persistenz)
- Obsidian Vault (Visualisierung)
