# Validation — Wiki add duplicate check returns cross-scope memory summaries without ACL or wiki-kind filtering

Candidate: `cand-wiki-add-duplicate-cross-scope-disclosure`  
Scope: repository snapshot `6dff096e`  
Method: benign public-handler mock; no production data or deployment was touched.

## Validation rubric

- [x] Caller and victim scope were separated in a benign public-handler mock.
- [x] The direct object ACL was checked as counterevidence.
- [x] The public handler's observed side effect or disclosure was recorded.
- [x] Preconditions and feature-preserving control point are documented.

## Observed result

A benign public-handler mock returned a user-scoped memory owned by a victim to a globally authorized but non-owner caller. `runWikiCommand` returned the victim summary in the duplicate response and made no store call; direct `checkAccess` denied the same row. The public handler therefore bypasses the available object ACL before rendering.

## Decision

**Reportable — P2 / Medium.** The mocked public path reaches the effect despite the direct object ACL denying the same row. Confidence: **0.85**.
