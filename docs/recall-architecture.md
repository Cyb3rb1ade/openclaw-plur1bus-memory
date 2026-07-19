# Recall Architecture — Actual Runtime Order

This document describes the implemented primary recall pipeline and the two
bounded additive boosters applied by its caller.

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

### 3. Optional query refinement

When the first result set is weak and refinement is enabled, the pipeline may
derive a refined query and perform the bounded refinement path. It does not
replace or bypass the normal vector search.

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
safe prompt rendering. There is no separate semantic prompt-compressor stage
in this path.

## Additive caller stages

After primary recall finalizes, the caller may append:

- **Semantic Lens** results from the precomputed workspace lens index.
- **Conversation Reactivation Recall (CRR)** results for bounded reactivation
  triggers.

Both stages are disabled by default, deduplicate against primary result IDs,
have strict caps/timeouts, and fall back to the unchanged primary recall on an
error. Neither stage replaces primary recall, performs a second authoritative
write path, or mutates memory records.
