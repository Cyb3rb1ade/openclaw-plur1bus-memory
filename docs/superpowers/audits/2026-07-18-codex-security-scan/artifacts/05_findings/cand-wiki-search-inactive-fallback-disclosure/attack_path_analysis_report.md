# Attack-path analysis — Wiki vector-search fallback omits lifecycle filtering and resurfaces superseded or archived records

Candidate: `cand-wiki-search-inactive-fallback-disclosure`

## Preconditions and path

A caller can issue search but may not control whether the primary builder/schema condition triggers fallback; that environmental condition bounds severity. Once fallback occurs, disclosure is deterministic. Applying the active/null lifecycle predicate to the JavaScript fallback preserves compatibility and recall.

## Policy decision

**Reportable — P3 / Low.** The required preconditions are explicit and the feature-preserving control point is identified; this audit does not propose disabling wiki operations.

