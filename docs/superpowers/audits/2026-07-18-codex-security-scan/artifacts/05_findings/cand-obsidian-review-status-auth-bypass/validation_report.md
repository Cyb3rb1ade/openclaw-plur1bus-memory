# Validation — Review approval, rejection, and snooze decisions bypass the configured user/chat ACL

Candidate: `cand-obsidian-review-status-auth-bypass`  
Scope: repository snapshot `6dff096e`  
Date: 2026-07-18

## Validation rubric

- [x] Discovery source, closest control, and sink are preserved below.
- [x] The repository code path was traced against the completed receipt.
- [ ] A bounded dynamic reproduction was not completed for this candidate.
- [x] The remaining proof gap and conservative disposition are stated.

## Method

Static source-to-sink trace using the independently reviewed discovery receipt. This bounded audit did not run a target-host exploit simulation for this candidate.

## Evidence

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-018.json`
- Attacker-controlled source: Any user who can invoke the review command, including a non-whitelisted participant in a shared chat, can request approve, reject, or snooze for a selected/latest bundle.
- Closest/broken control: The command classifier protects review apply and quickapply but not approve/reject/snooze. The handler therefore skips isAuthorized and calls updateReviewBundleItems without passing the resolved user/chat identity; approval metadata defaults to the generic approvedBy='human'.
- Sink: updateReviewBundleItems persists approved/rejected/snoozed states and synthetic approval metadata to the bundle JSON. applyApprovedReviewBundle later treats approved as sufficient to reach memoryStore/knowledgeUpdate/task writes after content checks that do not authenticate the reviewer.
- Claimed impact: An unauthorized participant can manufacture the approval prerequisite for durable memory/knowledge changes (and combine it with the dry-run auth bypass for immediate apply), or reject/snooze legitimate proposals to suppress the review workflow. The configured allowlist and private-chat fail-safe are not enforced at the decision boundary.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Addendum — Existing-reproduction cross-principal recalibration (2026-07-18)

This addendum supersedes the earlier rationale while retaining a deferred disposition. No new PoC was run; only `artifacts/02_discovery/file_reviews/review-018.json` was used.

### Receipt-based rubric

- [x] Direct classifier evaluation returns non-destructive for `review approve all`.
- [x] Static dispatch reaches the bundle-status writer.
- [ ] The handler was not invoked with an excluded supergroup identity and a real pending bundle.
- [ ] No persisted approve/reject/snooze transition was observed across principals.

### Recalibrated result

The classifier/control defect is strongly supported, but the receipt explicitly lists the identity-bound persisted-status test as work still to perform. The Dry-run candidate cannot substitute for this exact status-transition instance.

**Disposition:** deferred.  
**Survives:** uncertain.  
**Confidence:** 0.50.  
**Minimal next proof:** invoke approve/reject/snooze as a non-whitelisted participant and record the bundle JSON transition and missing lock response.
