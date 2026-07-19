# Validation — Primary per-agent database pool joins unvalidated runtime agent IDs into filesystem paths

Candidate: `cand-agent-db-path-traversal`  
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
- Attacker-controlled source: Host hook, command, and model-tool contexts supply ctx.agentId/commandCtx.agentId to the primary MultiNamespacePool and AgentDbPool.
- Closest/broken control: AgentDbPool only falls back to default; it caches and joins the raw identifier without safeAgentId or resolveInside, even though the repository provides safeAgentId and uses it in db-adapter.
- Sink: MemoryDB is constructed at the escaped path, and subsequent init/search/store/maintenance connects to or creates LanceDB state there.
- Claimed impact: A traversal-shaped agent ID can escape the configured namespace directory, collide with another agent or plugin path, and read/create/modify LanceDB files under the service account, violating per-agent isolation.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
