# Validation — Wiki deletion by UUID archives and deletes a cross-workspace record without object authorization

Candidate: `cand-wiki-delete-id-missing-record-acl`  
Scope: repository snapshot `6dff096e`  
Method: benign public-handler mock; no production data or deployment was touched.

## Validation rubric

- [x] Caller and victim scope were separated in a benign public-handler mock.
- [x] The direct object ACL was checked as counterevidence.
- [x] The public handler's observed side effect or disclosure was recorded.
- [x] Preconditions and feature-preserving control point are documented.

## Observed result

A benign public-handler mock returned a workspace-B wiki card while the caller context was workspace-A. Direct `checkAccess` denied the row, while `runWikiCommand` archived it, issued one table delete, and returned the normal deletion response. UUID validation and the wiki-only guard still operated; the missing control is object ACL.

## Decision

**Reportable — P2 / Medium.** The mocked public path reaches the effect despite the direct object ACL denying the same row. Confidence: **0.9**.
