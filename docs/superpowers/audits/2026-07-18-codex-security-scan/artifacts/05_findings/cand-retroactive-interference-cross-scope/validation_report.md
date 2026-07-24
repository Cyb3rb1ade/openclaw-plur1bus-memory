# Validation — Retroactive interference weakens semantically similar memories across workspace boundaries

Candidate: `cand-retroactive-interference-cross-scope`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-031.json`
- Attacker-controlled source: A user or model stores a normal non-core memory in workspace A for an agent whose per-agent DB also holds workspace-B memories, while retroactiveInterference is enabled.
- Closest/broken control: The helper excludes the new row and core rows and caps mutations, but it does not retain or compare workspaceKey, scope, ownerUserId, or storedBy. MemoryDB.search is an unscoped per-agent nearest-neighbor read.
- Sink: For each match, db.update writes a reduced memoryStrength and lastDynamicsAt to the foreign row.
- Claimed impact: A tenant can indirectly reduce retention/retrieval priority of up to five semantically similar memories owned by another workspace sharing the agent DB, undermining isolation and integrity.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
