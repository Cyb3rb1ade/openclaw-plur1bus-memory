# Attack-path analysis — Timeout fallback can replay another workspace's cached recall context

Candidate: `cand-recall-timeout-cache-cross-workspace`

## Path

1. **Source / trust boundary:** A caller in workspace B reaches before_prompt_build for the same agent, session identifier, and first 500 prompt characters as an earlier workspace-A recall, while its own recall operation reaches the scheduler timeout.
2. **Nearest or broken control:** The normal recall function applies ACL for its own context, but recallCache stores the completed result without scope metadata and cachedRecall returns it based only on the caller-supplied key. The production key omits workspaceKey, workspaceDir, user identity, and access context.
3. **Sink:** runRecall returns `{ok:true, value, timedOut:true, fromCache:true}` and index.js returns that unfiltered `value` as the new prompt hook's prependContext.
4. **Security outcome if exploitable:** A timeout in one workspace can inject stale memory/Neo/reminder context constructed for another workspace into the new model invocation, enabling confidential-context disclosure and incorrect cross-workspace behavior.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

