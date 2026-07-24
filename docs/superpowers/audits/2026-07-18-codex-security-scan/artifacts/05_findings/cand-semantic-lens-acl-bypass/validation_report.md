# Validation — Semantic Lens hydrates and injects memory IDs without applying recall ACL

Candidate: `cand-semantic-lens-acl-bypass`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-033.json`
- Attacker-controlled source: A workspace Semantic Lens index supplies community member UUIDs associated with an otherwise authorized base recall result; a referenced row may be workspace- or user-scoped to another principal in the same agent table.
- Closest/broken control: tryPick validates dedupe, count, lifecycle status, and token overlap, but never invokes checkAccess. The production hydration callback calls raw db.getById(memoryId), which validates UUID syntax but has no authorization context.
- Sink: The hydrated row's summary/text is converted to a semanticLensItem and appended to the model's memory context, bypassing the ACL stage that filtered normal recall results.
- Claimed impact: When the enabled index references a foreign row, another workspace/user can have that row's sensitive content disclosed to the answering model and potentially reflected in its response.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Calibration addendum — existing candidate-local proof and remaining provenance gap

No new reproduction was run. The existing dynamic candidate-local test is strong for the mechanical bypass: an ACL-denied victim user row with overlapping tokens was appended by `applySemanticLensToRecall` when a supplied index associated it with an allowed base result. Production code confirms that the post-ACL lens calls raw `db.getById` and applies status/relevance caps, but not `checkAccess` (`lib/semantic-lens-index.js:163-196`; `index.js:5816-5836`).

It does **not** yet establish a reportable realistic entry path for the foreign UUID. Semantic Lens is default-disabled, consumes a precomputed workspace file, and this repository contains no verified production writer or authorization model for `semantic-lens-index.json`. The candidate-local test supplies that index directly; neither untrusted index modification nor a normal cross-scope index builder is proven here. Thus the bypass survives, but the root-control/provenance leg remains unresolved.

**Disposition remains deferred. Confidence: 0.65.** Targeted follow-up should trace the deployed index producer and workspace-file writers, then show that an unauthorized principal can cause or retain a victim UUID in a reachable enabled index. A remediation can preserve the additive lens by applying the existing recall ACL to every hydrated entry.
