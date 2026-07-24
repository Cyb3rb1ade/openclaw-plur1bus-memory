# Attack-path analysis — Wiki deletion by semantic query searches and mutates foreign workspace records without object authorization

Candidate: `cand-wiki-delete-query-missing-record-acl`

## Preconditions and path

The caller must hold destructive-command authorization and share an agent DB with the victim workspace. Filtering semantic results through the existing ACL helper before uniqueness checks, rendering, archive, and deletion preserves semantic deletion.

## Policy decision

**Reportable — P2 / Medium.** The required preconditions are explicit and the feature-preserving control point is identified; this audit does not propose disabling wiki operations.

