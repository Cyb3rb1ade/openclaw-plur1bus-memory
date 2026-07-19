# Validation — Wiki vector-search fallback omits lifecycle filtering and resurfaces superseded or archived records

Candidate: `cand-wiki-search-inactive-fallback-disclosure`  
Scope: repository snapshot `6dff096e`  
Method: benign public-handler mock; no production data or deployment was touched.

## Validation rubric

- [x] Caller and victim scope were separated in a benign public-handler mock.
- [x] The direct object ACL was checked as counterevidence.
- [x] The public handler's observed side effect or disclosure was recorded.
- [x] Preconditions and feature-preserving control point are documented.

## Observed result

A benign public-handler mock omitted `where()` from the vector builder and returned one superseded same-agent wiki row. `runWikiCommand` returned the row text. The normal primary query filters active/null status; the compatibility/error fallback does not.

## Decision

**Reportable — P3 / Low.** The mocked public path reaches the effect despite the direct object ACL denying the same row. Confidence: **0.75**.
