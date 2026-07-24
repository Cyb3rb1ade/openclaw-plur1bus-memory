# Attack-path analysis — Daily-consolidation dry-run still hard-deletes expired memories

Candidate: `cand-consolidation-dryrun-purge`

## Path

1. **Source / trust boundary:** An operator or caller invokes exported runConsolidation with opts.dryRun=true.
2. **Nearest or broken control:** The dry-run flag is propagated to dynamics, Neo pruning, compaction, conflict resolution, reporting, and rate-state writes, but not to TTL purge.
3. **Sink:** db.purgeExpired calls MemoryDB.purgeExpired, which executes LanceDB table.delete for expired non-core rows.
4. **Security outcome if exploitable:** A purported non-mutating audit run irreversibly deletes expired memory rows without archive or destructive-operation audit evidence.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

