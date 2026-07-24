# Attack-path analysis — A dry-run token suppresses Obsidian command authorization while handlers still perform real mutations

Candidate: `cand-obsidian-dryrun-auth-bypass`

## Path

1. **Source / trust boundary:** Any chat participant can append --dry-run (or a case variant such as --DRY-RUN) to a destructive Obsidian command, including review apply/quickapply, rotate, cron install, config discovery write, or SOUL patch.
2. **Nearest or broken control:** isObsidianCommandDestructive lowercases all tokens and immediately returns false whenever --dry-run is present, before checking dangerous flags or mutating subcommands. Execution does not share that parsed decision: several branches ignore --dry-run, derive real execution from --apply, or check the original case-sensitive token.
3. **Sink:** The skipped authorization gate can reach applyApprovedReviewBundle -> memoryStore, rotateOldArchives -> rename/unlink, openclawCronAdd, writeDiscoveredObsidianWorkspaces, initWorkspace, and patchSoulMd with real-write parameters.
4. **Security outcome if exploitable:** A user excluded by allowedUserIds, including a participant in a group/supergroup, can bypass the destructive-command ACL and write durable memory, install cron jobs, modify OpenClaw/SOUL/vault files, or delete/move review artifacts. No feature needs to be disabled to fix the parser/control mismatch.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Addendum — Attack-path and policy recalibration (2026-07-18)

- **Context / in-scope status:** The Telegram/chat command surface and its configured user allowlist are explicit production controls in the repository threat model.
- **Exposure / vector / auth scope:** Remote shared-chat command; the reproduced caller was a non-whitelisted supergroup participant.
- **Cross-boundary behavior:** Verified at the authorization boundary: the unauthorized principal received the normal handler response rather than the lock response.
- **Preconditions:** Ordinary command access plus the relevant configured feature and an applicable proposal/archive/config target.
- **Controls and counterevidence:** The allowlist exists, but the `--dry-run` short circuit bypasses it. The receipt did not execute the final mutation because no open proposal existed; this limits impact confidence, not reachability of the broken control.
- **Impact surface:** Runtime data and privileged local state, including durable memory and command-selected vault/config/cron/SOUL mutations traced by the receipt.

**Severity calibration:** high potential impact + medium likelihood = **medium (P2)**.  
**Final policy decision:** **reportable**.
