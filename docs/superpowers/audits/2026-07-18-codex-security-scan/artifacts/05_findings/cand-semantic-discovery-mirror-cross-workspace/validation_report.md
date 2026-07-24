# Validation — Semantic discovery mirrors all active agent memories into the invoking workspace vault

Candidate: `cand-semantic-discovery-mirror-cross-workspace`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-024.json`
- Attacker-controlled source: A semanticDiscovery-enabled REM dream or internal discovery job runs for workspace A and an agent whose table contains active workspace-B/user-scoped memories.
- Closest/broken control: Semantic discovery is opt-in and link-index persistence has a confirmation gate, but runSemanticDiscoveryBatches scans the entire per-agent table, does not supply a workspace filter or authorization context, and invokes writeMemoryNotes before the confirmation-gated index logic. Normalized scan rows omit workspaceKey/agentId, preventing downstream scope comparison.
- Sink: writeMemoryNotes writes each returned memory's raw text to `<workspace-A vault>/plur1bus/memories/<id>.md`; semantic link discovery then operates on the same unfiltered record set and may retain foreign IDs in discovery state.
- Claimed impact: Private memory content from workspace B can be copied into workspace A's human-readable Obsidian vault and later surfaced through vault/index workflows, violating the plugin's per-workspace isolation despite no direct recall response being requested.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
