# Validation — Daily-consolidation dry-run still hard-deletes expired memories

Candidate: `cand-consolidation-dryrun-purge`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-011.json`
- Attacker-controlled source: An operator or caller invokes exported runConsolidation with opts.dryRun=true.
- Closest/broken control: The dry-run flag is propagated to dynamics, Neo pruning, compaction, conflict resolution, reporting, and rate-state writes, but not to TTL purge.
- Sink: db.purgeExpired calls MemoryDB.purgeExpired, which executes LanceDB table.delete for expired non-core rows.
- Claimed impact: A purported non-mutating audit run irreversibly deletes expired memory rows without archive or destructive-operation audit evidence.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
