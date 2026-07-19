# Validation — Model-facing memory_forget is enabled by default and deletes without user identity or record ACL

Candidate: `cand-model-forget-auth-bypass`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-001.json`
- Attacker-controlled source: Untrusted conversational content can influence the model to invoke memory_forget with a query or memory UUID in a tool context that carries agentId but no user-bound authorization identity.
- Closest/broken control: security.allowModelDestructiveMemoryOps is treated as enabled unless exactly false; the code itself states model tool calls lack user-bound auth, and memory_forget performs no checkAccess against scope/ownerUserId.
- Sink: The tool reads cards or search results, archives them, calls MemoryDB.delete, and returns candidate/full memory text or deletion status.
- Claimed impact: Prompt injection or a malicious participant can cause unauthorized deletion/archiving of another user's or scope's memory within the same agent database and may enumerate matching memory text during query selection.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
