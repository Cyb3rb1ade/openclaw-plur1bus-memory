# Validation — Critical classifier processes and exports foreign-scope cards without object authorization

Candidate: `cand-db-classifier-cross-scope`  
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
- Attacker-controlled source: Fresh unclassified memory rows can be workspace-scoped or scope:'user' with an ownerUserId while sharing an agent table.
- Closest/broken control: findRecentUnclassified receives only agent/time, filters no workspace/scope/owner, and runClassifier has no caller identity; updateCardType mutates the selected UUID without a record ACL check.
- Sink: The full card enters the classifier model, its type is mutated, and critical content is returned as a pushMessages payload for the current cron carrier and serialized by the caller.
- Claimed impact: A private card can be disclosed to the wrong cron destination/provider and changed outside its owner/workspace authorization context.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Cross-Scope-/Cross-Principal-Addendum — 2026-07-18

This addendum uses the already recorded `review-005.json` facts. A valid `scope:'user'`, `owner:'victim'`, workspace-B row was selected by an agent-only classifier run, classified as `gesundheit`, had its type changed, and produced a push payload containing the full diagnosis string. This establishes cross-scope selection, processing, mutation, and payload construction; the selected DB APIs have no workspace/scope/owner filter or caller context.

**Preconditions:** multiple protected scopes share an agent table and the classifier runs. **Counterevidence and proof gap:** the receipt explicitly states that confidentiality additionally requires the cron carrier, provider, or log viewer to be outside the victim's scope. It does not show which principal receives the constructed payload, an attacker-controlled classifier invocation, or a deployed cross-workspace destination. Type mutation alone is not shown to create a material security effect for a victim.

**Disposition: deferred.** The underlying cross-scope behavior is validated, but the required cross-principal disclosure or consequential mutation path remains unproven. A next bounded pass should trace the concrete classifier caller through its delivery destination and recipient identity without treating generic service-log access as an attacker path.
