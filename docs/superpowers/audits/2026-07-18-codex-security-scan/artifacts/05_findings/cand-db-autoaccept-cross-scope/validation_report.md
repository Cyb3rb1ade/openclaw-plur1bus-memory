# Validation — Stale critical auto-accept confirms foreign user/workspace records

Candidate: `cand-db-autoaccept-cross-scope`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-005.json`
- Attacker-controlled source: Old unconfirmed critical rows include owner and workspace scope metadata in a shared per-agent table.
- Closest/broken control: findUnconfirmedCritical filters only cutoff/type/confirmed and autoAcceptStale passes only agent; markConfirmed updates by UUID with no ctx, owner, or workspace comparison.
- Sink: The selected row's confirmed field is set to 1 by the daily background job.
- Claimed impact: A sensitive memory can be silently accepted under a different user's/workspace's job context, bypassing the owner review state and affecting later retention or confirmation workflows.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Cross-Scope-/Cross-Principal-Addendum — 2026-07-18

This addendum uses the existing `review-005.json` validation facts only. Its recorded agent-only run selected a valid `scope:'user'`, `owner:'victim'`, workspace-B credential row and wrote `confirmed:1`; this confirms the missing workspace/owner predicate and the cross-scope state mutation. The same receipt says `findUnconfirmedCritical` selects only time/type/confirmation and that `markConfirmed` receives no context, workspace, scope, or owner comparison.

**Preconditions:** a shared agent table holds a victim's unconfirmed critical row for more than 24 hours and the scheduled job runs. **Counterevidence and proof gap:** the receipt establishes neither a lower-privileged attacker who can choose or accelerate a victim's selection nor that `confirmed` grants approval, retention, disclosure, or another security-relevant consequence. The scheduled job can cause the state change automatically, but that alone does not establish a realistic attacker-to-victim security outcome.

**Disposition: deferred.** The cross-scope write is real, but its cross-principal exploit path and material impact remain unproven; the next bounded validation should trace consumers of `confirmed` and the scheduler/caller's principal and destination binding.
