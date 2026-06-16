# P2 RecallDecisionTrace / Memory Explainability

## 1. Goal

Make every memory decision explainable, testable, and auditable without changing memory semantics, vector DB dimensions, embedding models, LanceDB schema, or recall ranking.

For every memory that reaches the prompt we must be able to answer:
- Why was it included? (vector, graph, canonical, contradiction, reactivation, overlay, correction, store-time safety)
- Which scores contributed?
- Which guards allowed or denied it?
- Which candidates were rejected and why?
- Why was something treated as duplicate, merged, superseded, contradicted, graph-only, canonical, faded, or reactivation?

## 2. Non-goals

- Do not change the embedding model.
- Do not change embedding dimensions.
- Do not change LanceDB vector schema or require DB migration.
- Do not re-embed existing memories.
- Do not change recall ranking semantics (scores, thresholds, ordering) except where strictly necessary to propagate metadata.
- Do not make trace output visible by default.
- Do not leak raw prompts, chain-of-thought, or secrets into traces.
- Do not unify the two `memory_store` code paths if unification would change existing behavior.

## 3. Existing recall/store decision paths

### Recall path

1. `index.js` `before_agent_start` hook calls `runRecallPipeline` (L4110).
2. `lib/recall-pipeline.js` `runRecallPipeline` performs:
   - query summarization/truncation
   - vector search and score filter (`recallMinScore`)
   - optional query refinement
   - temporal filter
   - canonical KNOWLEDGE.md search (`canonicalMinScore`, `canonicalMaxItems`)
   - importance/emotion/strength boost re-scoring
   - associative/graph spread via `lib/memory-graph.js` `traverseGraph` + `mergeAssociativeResults`
   - graph hydration relevance threshold
   - recall budget tier caps
   - optional rerank with fallback
   - inter-result Jaccard dedup
   - ACL filter
3. `index.js` builds render items from pipeline output (L4159-4185).
4. `applySemanticLensToRecall` adds lens items.
5. `filterAssociativeCandidates` / `filterPatternCandidates` in `lib/continuity-gate.js` gate associative/pattern items.
6. Overlay load, contradiction flagging, auto-generation.
7. Memory-text contradiction detection (`ContradictionDetector.findMemoryTextContradictions`) + winner/loser resolution (`resolveContradictionWinner`).
8. `runConversationReactivationRecall` adds reactivation memories.
9. `formatRelevantMemoriesContext` renders the final XML.

### Store path

Two parallel implementations exist:

- `storeMemoryFromToolParams` in `index.js` (L1815) used by Obsidian bridge and `/plur1bus` command.
- `memory_store` tool `execute` inline in `index.js` (L3649).

Both perform:
- input validation
- duplicate check via `MemoryDB.findSimilar` + `duplicateThreshold`
- safe/unsafe duplicate decision via `isSafeDuplicate`
- merge candidate fetch via `MemoryDB.findMergeCandidate`
- meaningful-difference guard via `hasMeaningfulDifference`
- LLM merge check via `callMergeCheck`
- fact-preservation guard via `validateMergedTextPreservesFacts`
- cross-agent conflict logging for `decision` category
- merge persistence (archive-first, delete old, store merged) or normal store
- retroactive interference, curation logging, Schicht-1.5 pending tracking

### Correction/supersede path

- `lib/db-adapter.js` `updateCard` marks old row `status: "superseded"`, `supersededBy: newId`, then stores new version.
- Recall-time contradiction sets `status: "superseded-in-context"` and `supersededBy` on the loser.

## 4. Proposed trace data model

A pure, optional trace object carried alongside existing data structures.

```js
{
  id: string,                    // uuid v4
  createdAt: string,             // ISO timestamp
  query: string,                 // sanitized query/prompt preview
  mode: "recall" | "auto-recall" | "store" | "diagnostic",
  candidates: [
    {
      memoryId: string,
      textPreview: string,       // truncated, no secrets
      source: "vector" | "canonical" | "graph" | "contradiction" | "reactivation" | "overlay" | "semantic-lens" | "store" | "unknown",
      stage: "candidate" | "included" | "rejected" | "downranked" | "superseded" | "deduped" | "merged" | "stored_separately",
      score: number | null,
      vectorScore: number | null,
      graphScore: number | null,
      canonicalScore: number | null,
      contradictionScore: number | null,
      reactivationScore: number | null,
      finalScore: number | null,
      rank: number | null,
      depth: number | null,
      evidence: "direct" | "weak-association" | "derived" | "contradiction" | "superseded" | "unknown",
      reason: string,
      guards: string[],
      relatedMemoryIds: string[]
    }
  ],
  guards: [
    {
      name: string,
      stage: string,
      result: "allow" | "deny" | "downrank" | "mark" | "skip",
      memoryId: string | null,
      reason: string
    }
  ],
  storeDecisions: [
    {
      type: "duplicate" | "safe_duplicate" | "unsafe_duplicate_rejected" | "merge_candidate" | "merge_allowed" | "merge_aborted" | "stored_separately" | "superseded" | "contradiction_detected",
      memoryId: string | null,
      relatedMemoryId: string | null,
      reason: string,
      score: number | null
    }
  ],
  summary: {
    included: number,
    rejected: number,
    graphIncluded: number,
    vectorIncluded: number,
    canonicalIncluded: number,
    reactivationIncluded: number,
    contradictionsMarked: number,
    supersededMarked: number
  }
}
```

### Pure helper module

`lib/recall-decision-trace.js` exports:
- `createRecallDecisionTrace(opts)`
- `addTraceCandidate(trace, candidate)`
- `addTraceDecision(trace, decision)`
- `addTraceGuard(trace, guard)`
- `addTraceStoreDecision(trace, decision)`
- `summarizeTrace(trace)`
- `serializeTraceForDebug(trace, opts)`
- `attachTraceToMemory(memory, traceMeta)`
- `getMemoryTrace(memory)`
- `textPreview(text, maxChars)`

Trace objects are plain JS objects. No mutation of `memory` entries except via `attachTraceToMemory`, which stores a non-enumerable symbol key to avoid JSON leakage.

## 5. Integration points

### Recall pipeline (`lib/recall-pipeline.js`)

- Accept optional `decisionTrace` option.
- At each stage push candidates/guards into the trace object:
  - vector candidates after score filter
  - query refinement triggered/merged
  - temporal filter drops
  - canonical hits
  - boosted/re-scored results
  - graph-only and overlap results from `mergeAssociativeResults`
  - graph hydration dropped
  - recall budget drops
  - rerank fallback
  - Jaccard dedup
  - ACL denied ids
- Return `trace` alongside existing `{ canonical, memories }`.
- `retrievalLogger` payload receives `trace` summary.

### Continuity gate (`lib/continuity-gate.js`)

- `filterAssociativeCandidates` accepts optional `trace` and records each graph candidate that passes or fails `ContinuityGate.shouldSurface`.
- `filterPatternCandidates` records pattern allow/deny.
- `ContinuityGate.shouldSurface` returns `{ allow, reason, traceDetail }` when a trace collector is provided.

### Reactivation recall (`lib/conversation-reactivation-recall.js`)

- `selectReactivationMemories` accepts optional `trace` and records each candidate add/reject reason.
- `runConversationReactivationRecall` returns `{ context, additions, trace }`.

### Prompt context (`lib/relevant-memory-context.js`)

- `formatRelevantMemoriesContext` accepts optional `decisionTrace` and `traceOptions`.
- When `includeInPrompt` is true, render a compact `<memory-decision-trace>` block inside `<relevant-memories>`.
- Each `<memory-record>` gets optional trace attributes (`source-stage`, `score`, `evidence`, `trace-reason`) only when enabled.
- Default behavior is unchanged: no trace attributes, no trace block.

### Store-time (`index.js`)

- In `storeMemoryFromToolParams` create a trace at entry, record:
  - duplicate check result (`safe_duplicate`, `unsafe_duplicate_rejected`)
  - merge candidate found
  - meaningful-difference abort
  - LLM merge allow/abort
  - fact-preservation abort
  - merge persistence (archive/delete/store)
  - normal store
- Return `details.decisionTrace` alongside `details.action/id`.
- Mirror the same trace collection in the `memory_store` tool inline path.
- Enrich existing `appendCurationLog` / `appendConflictLog` / `appendDestructiveOpLog` calls with `traceId` when a workspaceDir is available.

### Contradiction / superseded

- Recall-time contradiction in `index.js` records winner/loser as a `storeDecision`/`decision` entry.
- Overlay contradiction flagging records `contradiction_detected` entries.

## 6. Config/default behavior

Add under `openclaw.plugin.json`:

```json
{
  "recall": {
    "decisionTrace": {
      "enabled": false,
      "includeInPrompt": false,
      "maxCandidates": 50,
      "maxTextPreviewChars": 160,
      "persist": false,
      "visibleHints": false
    }
  }
}
```

Extraction in `index.js` near existing recall config:

```js
const traceCfg = cfg.recall?.decisionTrace || {};
const traceEnabled = traceCfg.enabled === true;
const traceInPrompt = traceEnabled && traceCfg.includeInPrompt === true;
```

Defaults:
- `enabled: false` — trace collection is off.
- `includeInPrompt: false` — no noisy prompt output.
- `persist: false` — trace is returned in-memory only.
- `visibleHints: false` — no user-visible hint text.

## 7. Test plan

### Unit tests (`tests/recall-decision-trace.test.js`)

- `createRecallDecisionTrace` creates stable empty trace.
- `addTraceCandidate` records vector candidate.
- `addTraceDecision` records included/rejected candidate.
- `addTraceGuard` records allow/deny/downrank.
- `summarizeTrace` counts included/rejected/source types.
- `serializeTraceForDebug` truncates previews.
- `textPreview` truncates and strips secrets-ish content.
- invalid inputs do not crash.

### Recall integration (`tests/recall-pipeline-decision-trace.test.js`)

- vector memory included with `source=vector` and score.
- graph-only memory included with `source=graph`, `evidence=weak-association`.
- graph candidate rejected by continuity gate gets rejection reason.
- canonical memory gets `source=canonical`.
- contradiction-marked memory gets contradiction/superseded trace reason.
- final prompt memory carries trace metadata when enabled.
- default config does not render trace block.
- `includeInPrompt=true` renders compact decision trace block.

### Context integration (`tests/relevant-memory-context-trace.test.js`)

- `formatRelevantMemoriesContext` output unchanged when trace disabled.
- compact trace attributes emitted when enabled.
- diagnostic block rendered when `includeInPrompt=true`.
- sanitization of attributes and text.

### Auto-recall integration (`tests/auto-recall-decision-trace.test.js`)

- auto-recall path produces a trace.
- reactivation memories traced with `source=reactivation`.
- rejected reactivation candidates have reasons.

### Store integration (`tests/memory-store-decision-trace.test.js`)

- exact duplicate produces `safe_duplicate` trace.
- unsafe duplicate stores separately and traces `unsafe_duplicate_rejected`.
- unsafe LLM merge blocked before LLM traces `merge_aborted`.
- unsafe mergedText after LLM traces `merge_aborted`.
- safe merge traces `merge_allowed` and archive-first path remains intact.
- superseded/contradiction decision traces winner/loser.

### Regression

- `tests/config-audit.test.js` extended for new schema defaults and code fallback parity.
- All existing tests from #49/#50/#51/#52 remain green.
- No vector dimension change.
- No embedding model change.
- No LanceDB schema change.

## 8. Migration/vector-dimension invariance statement

This change does not:
- add, remove, or alter any LanceDB table columns;
- change embedding model, dimension, or vector schema;
- require re-embedding of existing memories;
- require DB migration.

Trace metadata is carried in-memory and emitted through existing callbacks/logs. The only persistent writes are optional JSONL log entries and existing retrieval ledger entries.

## 9. Rollout/operational usage

1. Default: tracing disabled, prompt output unchanged.
2. Diagnostic mode: set `recall.decisionTrace.enabled: true` to collect per-recall traces in retrieval ledger and return values.
3. Prompt inspection mode: set `recall.decisionTrace.includeInPrompt: true` to render a compact `<memory-decision-trace>` block for debugging.
4. Store audit mode: `details.decisionTrace` is returned from `memory_store` and logged to curation/conflict/destructive-op JSONL.
5. Operators can query `curation-log.jsonl` / retrieval ledger by `traceId` to reconstruct decisions.

## 10. Risks

| Risk | Mitigation |
|------|------------|
| Prompt noise if trace accidentally rendered by default | `includeInPrompt` default false; formatter gated explicitly. |
| Performance overhead when tracing enabled | Trace collection is additive O(n) over already-collected candidates; disabled path is no-op. |
| Sensitive prompt text leaked into traces | `textPreview` truncates; no raw user prompts; only memory previews already shown in prompt. |
| Divergence between two `memory_store` paths | Mirror trace collection in both paths; consider unification as future work. |
| Tests assert exact XML and break on new attributes | Add attributes only when trace enabled; existing tests run with trace disabled. |
| Schema drift (existing unschema’d keys) | New keys added to `openclaw.plugin.json` with defaults; config-audit tests extended. |
| Reviewer thinks ranking changed | Keep trace read-only relative to scoring; document invariance. |
