# Validation — resolveInside misses an existing ancestor symlink when the immediate parent does not exist

Candidate: `cand-resolveinside-nonexistent-ancestor-symlink`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-035.json`
- Attacker-controlled source: A caller supplies or derives a multi-level new target beneath a base containing an attacker-created symlink in an earlier path component.
- Closest/broken control: For a non-existent target whose immediate parent is also absent, resolveInside does not walk to and realpath the nearest existing ancestor; it lexically resolves dirname(join(...parts)) and only checks the resulting string prefix.
- Sink: The helper returns a path that traverses the ancestor symlink when a downstream caller recursively creates the missing parent or writes the target.
- Claimed impact: A caller relying on the documented containment guarantee can create/write outside baseDir through an ancestor symlink even though traversal strings are rejected.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
