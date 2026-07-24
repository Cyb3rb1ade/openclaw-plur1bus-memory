# Attack-path analysis — Obsidian rotate chat command can permanently delete review-vault files without authorization, confirmation, or destructive audit

Candidate: `cand-obsidian-rotate-auth-bypass`

## Path

1. **Source / trust boundary:** Any chat user who can invoke /plur1bus can supply obsidian rotate --apply --delete --allow-delete plus age/size options.
2. **Nearest or broken control:** runPlur1busCommand dispatches every obsidian action to handleObsidianBridgeCommand at index.js:2948-2983 before calling checkAuth; the rotate branch treats the two flags as sufficient approval and has no user/chat-bound confirmation nonce.
3. **Sink:** rotateOldArchives reaches unlinkSync(f.path) at lib/obsidian/archive-rotation.js:156-160 for matching top-level .json, .md, or .txt files beneath the configured review root.
4. **Security outcome if exploitable:** A non-whitelisted user in a shared chat can permanently remove review/control-room artifacts and evidence despite a configured PLUR1BUS whitelist; the operation is not recoverable from an in-command archive and leaves no appendDestructiveOpLog receipt.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Addendum — Attack-path and policy recalibration (2026-07-18)

- **Context:** Archive rotation and deletion are real chat-selected maintenance operations.
- **Exposure / vector:** Shared-chat access is plausible.
- **Cross-boundary behavior:** Not verified for standalone rotate; normal lowercase destructive flags are authorization-gated.
- **Preconditions:** A matching old/oversize review artifact and explicit delete flags.
- **Counterevidence:** `review-018.json` is dispositive against the original “no rotate gate” premise. The only evidenced bypass uses `--dry-run` and is accounted for under the separate Dry-run candidate.
- **Impact surface:** Contained review/control-room files.

**Severity calibration:** not finalized because an independent cross-principal path is absent.  
**Final policy decision:** **deferred**.
