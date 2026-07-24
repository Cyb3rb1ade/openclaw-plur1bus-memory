# Attack-path analysis — REM dreaming relabels and persists memories from other workspaces and owners

Candidate: `cand-rem-dream-cross-workspace-leak`

## Path

1. **Source / trust boundary:** Recent active memory rows in one per-agent LanceDB table carry workspaceKey, scope, and ownerUserId and can belong to different workspaces/users.
2. **Nearest or broken control:** loadCandidateMemories receives the requested workspaceKey/agentId but filters only time/status/dream class; it neither compares row bindings nor calls checkAccess, and it preserves or defaults those bindings only after selection.
3. **Sink:** Foreign row text is sent to the pattern/narrative LLMs and copied into evidenceQuotes, patterns, trends, dream memories, dream echoes, and Markdown under the requested workspace identity.
4. **Security outcome if exploitable:** A REM run for one workspace can disclose another workspace/user's memories to the configured model provider and persist exact evidence or derived content into artifacts visible and influential in the wrong workspace.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Calibration addendum — existing full-run proof

The discovery receipt contains a real bounded REM run, not only static inference. In that run, a workspace-A request consumed workspace-B input rows and persisted their exact confidential text as workspace-A `evidenceQuotes`. Source confirms no workspace/owner filter is applied before the LLM/persistence stages, whereas the caller supplies the requested workspace identity.

This creates direct cross-workspace disclosure and durable contamination in the normal dreaming feature once a shared-agent table contains protected rows. The model configuration is a normal REM prerequisite; exact evidence persistence is deterministic after selection and does not depend on model cooperation.

**Policy decision revised: reportable, P2 / Medium.** Retain dreaming, but filter candidates with the existing ACL/binding context before clustering and preserve the selected rows' bindings in all derived records.
