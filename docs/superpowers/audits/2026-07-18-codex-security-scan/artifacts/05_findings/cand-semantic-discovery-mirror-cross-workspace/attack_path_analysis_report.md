# Attack-path analysis — Semantic discovery mirrors all active agent memories into the invoking workspace vault

Candidate: `cand-semantic-discovery-mirror-cross-workspace`

## Path

1. **Source / trust boundary:** A semanticDiscovery-enabled REM dream or internal discovery job runs for workspace A and an agent whose table contains active workspace-B/user-scoped memories.
2. **Nearest or broken control:** Semantic discovery is opt-in and link-index persistence has a confirmation gate, but runSemanticDiscoveryBatches scans the entire per-agent table, does not supply a workspace filter or authorization context, and invokes writeMemoryNotes before the confirmation-gated index logic. Normalized scan rows omit workspaceKey/agentId, preventing downstream scope comparison.
3. **Sink:** writeMemoryNotes writes each returned memory's raw text to `<workspace-A vault>/plur1bus/memories/<id>.md`; semantic link discovery then operates on the same unfiltered record set and may retain foreign IDs in discovery state.
4. **Security outcome if exploitable:** Private memory content from workspace B can be copied into workspace A's human-readable Obsidian vault and later surfaced through vault/index workflows, violating the plugin's per-workspace isolation despite no direct recall response being requested.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

