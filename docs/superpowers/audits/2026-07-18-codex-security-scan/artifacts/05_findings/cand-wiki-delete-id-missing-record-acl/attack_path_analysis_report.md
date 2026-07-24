# Attack-path analysis — Wiki deletion by UUID archives and deletes a cross-workspace record without object authorization

Candidate: `cand-wiki-delete-id-missing-record-acl`

## Preconditions and path

The caller must hold destructive-command authorization, share a routed agent DB with the victim row, and know a target UUID. Archive-first limits irreversibility but does not authorize mutation. Enforcing `checkAccess` with the existing ACL context before archive/delete retains archive-based recovery and UUID deletion.

## Policy decision

**Reportable — P2 / Medium.** The required preconditions are explicit and the feature-preserving control point is identified; this audit does not propose disabling wiki operations.

