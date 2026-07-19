# Attack-path analysis — Shared-vault ReviewBundles are selected and applied without agent/workspace ownership checks

Candidate: `cand-obsidian-review-bundle-cross-agent`

## Path

1. **Source / trust boundary:** Two agent/workspace contexts use the same configured vaultPath, or a user in one agent context supplies/selects a ReviewBundle created for another agent in that shared review directory.
2. **Nearest or broken control:** Global vaultPath takes priority for every context. Auto bundle IDs contain only UTC date/hour/minute and can collide across agents. latestReviewBundleId scans every .items.json without filtering record.bundle.workspaceKey or createdByAgent, and load/apply never compares those fields to options.agentId/workspaceKey.
3. **Sink:** The selected foreign bundle is approved/applied through the current command context; the production memoryStore callback stores its payload under commandCtx.agentId/workspaceDir, while same-minute prepareReviewBundle calls can overwrite the same bundle files.
4. **Security outcome if exploitable:** A proposal from agent/workspace A can be silently selected, overwritten, approved, or written into agent B's authoritative LanceDB memory, breaking per-agent isolation and confusing audit provenance. Concurrent review generation can also destroy one agent's pending review state.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Addendum — Attack-path and policy recalibration (2026-07-18)

- **Context:** ReviewBundle selection/application is a real control-room workflow; per-agent memory isolation is an explicit threat-model boundary.
- **Exposure / vector:** Internal chat/control-room workflow; the shared-vault multi-agent deployment is plausible but not reproduced.
- **Cross-boundary behavior:** Proposed agent A to agent B, but not verified.
- **Preconditions:** Two agent/workspace contexts, one shared review root, and a selectable approved foreign bundle.
- **Counterevidence:** An explicit bundle ID removes timing dependence, yet the receipt contains no two-principal transcript; same-minute collision is likewise only proposed.
- **Impact surface:** Cross-agent authoritative memory integrity and audit provenance.

**Severity calibration:** not finalized until the A-to-B application path is reproduced.  
**Final policy decision:** **deferred**.
