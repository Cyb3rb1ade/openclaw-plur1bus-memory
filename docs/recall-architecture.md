# Recall Architecture — Actual Runtime Order

This document describes the implemented primary recall pipeline and the two
bounded additive boosters applied by its caller.

## Namespace fan-out and global merge

With no explicit `namespaces` object, recall keeps the legacy-flat
`{baseDbPath}/{agentId}` route and invokes the pipeline once. With explicit
named routing, every configured read table belongs to that same validated
agent: active tables are read/write-capable, while opted-in legacy tables are
opened read-only without creation or migration. A single live table retains the
existing direct pipeline path. The fan-out and global merge apply when multiple
live tables participate; strict error behavior is still derived from the
configured layout, so an absent legacy table cannot weaken a later active read.

```text
validated agentId (multi-table named route)
  -> configured same-agent namespace tables
  -> one existing recall pipeline per table
  -> wait for every pipeline to settle
  -> one global canonical / memory / trace merge
  -> one final retrieval-ledger entry
```

Canonical `KNOWLEDGE.md` search runs only in the first configured namespace
pipeline because all pipelines use the same current workspace. The merge then
stable-sorts memory candidates globally by score, keeps the higher-scoring copy
of duplicate IDs, optionally applies the configured Jaccard deduplication,
deduplicates canonical results by normalized heading plus text, and enforces
`canonical.length + memories.length <= topN` (the public tool limit or
`maxPromptMemories`). Namespace labels
are attached to cloned result wrappers; ownership fields remain unchanged.
Child decision traces are replayed through the existing capped helpers into one
master trace, including namespace provenance and global dedup decisions.

All namespace pipelines settle before success or failure is exposed. A missing
legacy table is skipped, but another initialization or query failure rejects
the public recall without another namespace's partial result or ledger entry.
Every table must use the configured embedding dimensions. Named namespaces are
storage routing for one agent, not cross-agent/workspace/user sharing; the
latter remains part of B13 ACL remediation.

## Primary pipeline

```text
query/context
  -> embedding
  -> LanceDB vector search
  -> optional query refinement
  -> temporal filter
  -> canonical KNOWLEDGE.md search
  -> score and status processing
  -> graph spread and hydration
  -> budget allocation
  -> optional rerank
  -> deduplication
  -> ACL filtering
  -> finalization
```

### 1. Embedding

The normalized query is embedded by the configured local or remote provider.
The optional embedding cache can satisfy an exact cache hit; otherwise the
computed vector is cached after a successful provider result.

### 2. Vector search

LanceDB performs the initial ANN search using the configured candidate budget.
This is the authoritative memory-card search path.

### 3. Query refinement seam

The pipeline contains a fail-soft refinement seam, but the supported runtime
does not currently expose or enable it. Runtime wiring and its public option
contract remain B12-P work; B12-Core does not alter initial vector recall.

### 4. Temporal filter

Recognized time expressions constrain candidates to the relevant interval.
Queries without a usable temporal expression continue unchanged.

### 5. Canonical knowledge search

The pipeline searches canonical chunks from `KNOWLEDGE.md` and combines those
results with the memory candidates under the configured canonical limits.

### 6. Score and status processing

Candidate scores are normalized and adjusted by the implemented quality,
importance, age, status, and related eligibility rules. Inactive or otherwise
ineligible rows do not become final prompt memories.

### 7. Graph spread and hydration

Eligible candidates may receive bounded associative graph neighbors. Returned
identifiers are hydrated into memory rows before later selection stages. This
is the runtime graph-spread path; PLUR1BUS does not claim a separate live
`GraphIndex` traversal here.

### 8. Budget allocation

The combined candidate set is constrained by the recall time/item budgets and
the configured prompt-memory limit. Budget fallback remains fail-soft.

### 9. Optional rerank

If a reranker is explicitly enabled and available, it reorders the bounded
candidate set with timeout/fallback behavior. Otherwise the pipeline retains
the existing scores.

### 10. Deduplication

Near-duplicate results are collapsed after optional reranking so the final set
does not spend multiple slots on equivalent evidence.

### 11. ACL filtering

Agent, workspace, user-owner, and scope visibility checks run before results
can be returned to the caller. A high score never bypasses authorization.

### 12. Finalization

The pipeline applies final limits and prepares the selected result records for
safe prompt rendering. In named multi-namespace mode this is the per-table
result consumed by the global merge above. There is no separate semantic
prompt-compressor stage in this path; that runtime feature remains B12-P.

## Additive caller stages

After primary recall finalizes, the caller may append:

- **Semantic Lens** results from the precomputed workspace lens index.
- **Conversation Reactivation Recall (CRR)** results for bounded reactivation
  triggers.

Both stages are disabled by default, deduplicate against primary result IDs,
have strict caps/timeouts, and fall back to the unchanged primary recall on an
error. Neither stage replaces primary recall, performs a second authoritative
write path, or mutates memory records.
