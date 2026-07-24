# Validation — Wiki deletion by semantic query searches and mutates foreign workspace records without object authorization

Candidate: `cand-wiki-delete-query-missing-record-acl`  
Scope: repository snapshot `6dff096e`  
Method: benign public-handler mock; no production data or deployment was touched.

## Validation rubric

- [x] Caller and victim scope were separated in a benign public-handler mock.
- [x] The direct object ACL was checked as counterevidence.
- [x] The public handler's observed side effect or disclosure was recorded.
- [x] Preconditions and feature-preserving control point are documented.

## Observed result

A benign public-handler mock returned one active workspace-B wiki row for a workspace-A caller. Direct ACL evaluation denied it, but `runWikiCommand` called table delete and returned success. The semantic-query path can locate a foreign item itself; multiple matches instead reveal their identifiers/previews.

## Decision

**Reportable — P2 / Medium.** The mocked public path reaches the effect despite the direct object ACL denying the same row. Confidence: **0.9**.
