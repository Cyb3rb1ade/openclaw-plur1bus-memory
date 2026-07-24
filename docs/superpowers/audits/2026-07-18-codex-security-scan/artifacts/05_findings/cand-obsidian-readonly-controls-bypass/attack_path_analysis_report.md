# Attack-path analysis — Obsidian background rebuilds mutate vault state despite read-only, dry-run, or unconfirmed configuration

Candidate: `cand-obsidian-readonly-controls-bypass`

## Path

1. **Source / trust boundary:** An operator enables the bridge/watch service while relying on mode='augment' or mode='dry-run', dryRun=true, requireVaultPathConfirmation=true, or allowWrite=false as a no-mutation safety posture.
2. **Nearest or broken control:** The bridge normalizes mode/dryRun/confirmation settings, but mode is never used as an execution gate. syncWorkspace checks dryRun and vault confirmation, whereas rebuildDashboards has no equivalent gate and is started/scheduled regardless. Several control-room state writers such as expireStaleBundles and generateConflictReport also bypass the otherwise-used allowWrite check.
3. **Sink:** rebuildDashboards expires pending bundle JSON and invokes writeMemoryNotes, writeCommandsMarkdown, generateDashboards, and writeGraphLinks; startup invokes it immediately and periodically. Additional dry-run paths write config backups and sync metrics before/without their mutation guard.
4. **Security outcome if exploitable:** A documented/readable safety mode can still create or replace vault files, rewrite graph-link managed blocks, and reject/expire review state. This can cause unexpected data loss or external writes when combined with the symlink escape, and defeats operator expectations during migration or audit runs.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Addendum — Attack-path and policy recalibration (2026-07-18)

- **Context:** Background rebuild and control-room mirror generation are real workflows.
- **Exposure / vector / auth scope:** Operator-configured local/background execution; no attacker-facing entrypoint is proved.
- **Cross-boundary behavior:** Not established. The receipt shows writes despite configuration, not a different principal crossing an authorization boundary.
- **Preconditions:** Service startup/manual rebuild and a writable configured vault.
- **Counterevidence:** The documented sinks affect vault mirrors and review state; authoritative memory mutation is not claimed. External impact currently depends on chaining the separately deferred symlink candidate.
- **Impact surface:** Local runtime/vault integrity.

**Severity calibration:** not finalized because the evidenced path is operator/self-controlled.  
**Final policy decision:** **deferred**.
