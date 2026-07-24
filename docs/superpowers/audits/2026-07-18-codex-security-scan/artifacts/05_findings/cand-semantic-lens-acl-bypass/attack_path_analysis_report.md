# Attack-path analysis — Semantic Lens hydrates and injects memory IDs without applying recall ACL

Candidate: `cand-semantic-lens-acl-bypass`

## Path

1. **Source / trust boundary:** A workspace Semantic Lens index supplies community member UUIDs associated with an otherwise authorized base recall result; a referenced row may be workspace- or user-scoped to another principal in the same agent table.
2. **Nearest or broken control:** tryPick validates dedupe, count, lifecycle status, and token overlap, but never invokes checkAccess. The production hydration callback calls raw db.getById(memoryId), which validates UUID syntax but has no authorization context.
3. **Sink:** The hydrated row's summary/text is converted to a semanticLensItem and appended to the model's memory context, bypassing the ACL stage that filtered normal recall results.
4. **Security outcome if exploitable:** When the enabled index references a foreign row, another workspace/user can have that row's sensitive content disclosed to the answering model and potentially reflected in its response.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Calibration addendum — bypass confirmed, entry path incomplete

Existing dynamic evidence proves the post-ACL hydration/control failure once a foreign UUID appears in the workspace index: direct ACL denies the victim row, while the Lens appends it. The normal recall caller uses the same raw `getById` callback after the main ACL stage. This is not a false positive about status/relevance filtering.

The attack chain remains incomplete at the root control. The feature is opt-in and reads a precomputed workspace index. The audited repository does not show who generates that exact index or a lower-trust actor who can introduce a victim UUID into it; a manual injected index in a candidate-local test cannot stand in for that missing provenance. The external/nightly wording in documentation is insufficient to assign an attacker capability.

**Policy decision remains deferred.** Preserve Semantic Lens by applying `checkAccess` during `tryPick`/hydration; pursue the index-producer and workspace-write authorization evidence before elevating severity.
