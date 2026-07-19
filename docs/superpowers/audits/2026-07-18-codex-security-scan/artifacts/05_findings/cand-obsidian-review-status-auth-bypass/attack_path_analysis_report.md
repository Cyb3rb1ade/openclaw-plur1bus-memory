# Attack-path analysis — Review approval, rejection, and snooze decisions bypass the configured user/chat ACL

Candidate: `cand-obsidian-review-status-auth-bypass`

## Path

1. **Source / trust boundary:** Any user who can invoke the review command, including a non-whitelisted participant in a shared chat, can request approve, reject, or snooze for a selected/latest bundle.
2. **Nearest or broken control:** The command classifier protects review apply and quickapply but not approve/reject/snooze. The handler therefore skips isAuthorized and calls updateReviewBundleItems without passing the resolved user/chat identity; approval metadata defaults to the generic approvedBy='human'.
3. **Sink:** updateReviewBundleItems persists approved/rejected/snoozed states and synthetic approval metadata to the bundle JSON. applyApprovedReviewBundle later treats approved as sufficient to reach memoryStore/knowledgeUpdate/task writes after content checks that do not authenticate the reviewer.
4. **Security outcome if exploitable:** An unauthorized participant can manufacture the approval prerequisite for durable memory/knowledge changes (and combine it with the dry-run auth bypass for immediate apply), or reject/snooze legitimate proposals to suppress the review workflow. The configured allowlist and private-chat fail-safe are not enforced at the decision boundary.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Addendum — Attack-path and policy recalibration (2026-07-18)

- **Context:** Human review decisions are a real approval boundary for later durable writes.
- **Exposure / vector:** Shared-chat command is plausible; only the identity-free classifier was exercised.
- **Cross-boundary behavior:** Not verified for this exact state transition.
- **Preconditions:** An existing pending ReviewBundle and ordinary review-command access.
- **Counterevidence:** Approval alone does not execute `memoryStore`; a later apply is required. Chaining the reportable Dry-run bypass is plausible but does not replace proof of this candidate's own unauthorized status mutation.
- **Impact surface:** Review integrity and prerequisite approval state.

**Severity calibration:** not finalized while the cross-principal status mutation is unproved.  
**Final policy decision:** **deferred**.
