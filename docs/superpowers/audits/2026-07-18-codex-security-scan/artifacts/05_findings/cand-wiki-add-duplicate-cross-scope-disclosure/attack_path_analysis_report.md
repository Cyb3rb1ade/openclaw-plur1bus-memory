# Attack-path analysis — Wiki add duplicate check returns cross-scope memory summaries without ACL or wiki-kind filtering

Candidate: `cand-wiki-add-duplicate-cross-scope-disclosure`

## Preconditions and path

The caller must be authorized to add wiki entries, share the routed agent database with a foreign memory, and produce a sufficiently similar probe. The 0.92 similarity threshold constrains breadth but does not prevent targeted topic probes. Filtering duplicate candidates by `checkAccess` and `memoryKind` before the response preserves duplicate prevention.

## Policy decision

**Reportable — P2 / Medium.** The required preconditions are explicit and the feature-preserving control point is identified; this audit does not propose disabling wiki operations.

