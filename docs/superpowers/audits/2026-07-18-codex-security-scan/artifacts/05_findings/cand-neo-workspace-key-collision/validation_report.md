# Validation — Non-injective Neo workspace-key sanitization merges distinct workspace stores

Candidate: `cand-neo-workspace-key-collision`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-017.json`
- Attacker-controlled source: Host context, explicit workspace identifiers, configured aliases, paths, and corpus defaults supply a raw Neo workspace key.
- Closest/broken control: sanitizePathPart replaces every run of characters outside [A-Za-z0-9._-] with '_', strips edge underscores, maps empty results to default, and truncates at 120 characters without retaining a hash of the original identifier.
- Sink: workspaceKeyFromContext returns the lossy value and createNeoStore uses it directly as the sole workspaces/<key> directory name for all turn, candidate, behavior, graph, run-state, and hook files.
- Claimed impact: Two distinct workspaces can read, recall, modify, deduplicate, migrate, or prune each other's Neo records, causing cross-workspace confidentiality and integrity loss. The collision can be accidental or chosen when workspace names/IDs are user- or tenant-influenced.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
