# Attack-path analysis — Deep-maintenance chat command deletes generated task notes without authorization, confirmation, or audit

Candidate: `cand-obsidian-maintenance-auth-bypass`

## Path

1. **Source / trust boundary:** Any chat user able to invoke /plur1bus can request obsidian maintenance deep; the common Obsidian command dispatch does not enforce configured PLUR1BUS allowlists.
2. **Nearest or broken control:** runLivingMaintenanceDeep is called directly at lib/obsidian-control-room.js:3444, with no dry-run flag, user/chat-bound confirmation nonce, or checkAuth; index.js:2948-2983 reaches it before destructive authorization branches.
3. **Sink:** cleanupResolvedFindings unconditionally enumerates records/tasks and calls unlinkSync for every missing-<field>-<id>.md whose source ID is no longer classified as missing at lib/obsidian/maintenance-deep.js:31-39.
4. **Security outcome if exploitable:** An unauthorized shared-chat participant can remove generated review findings/evidence and alter the human control-room state despite an allowlist; deletions have no archive or appendDestructiveOpLog receipt.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Addendum — Attack-path and policy recalibration (2026-07-18)

- **Context:** Real chat-command maintenance workflow with a contained generated-task deletion sink.
- **Exposure / vector:** Remote chat access is plausible, but an unauthorized caller-to-delete transcript is absent.
- **Cross-boundary behavior:** Unverified; only static dispatch and sink reachability are recorded.
- **Preconditions:** A stale `missing-<field>-<id>.md` task and a writable review vault.
- **Counterevidence:** Filename matching and a fixed tasks directory constrain impact; neither restores authorization, but the receipt did not prove a distinct principal triggered deletion.
- **Impact surface:** Control-room review artifacts, not authoritative memory.

**Severity calibration:** not finalized while cross-principal reach remains unproved.  
**Final policy decision:** **deferred**.
