# Attack-path analysis — Workspace-wide dream echoes can surface one session's topic in another session

Candidate: `cand-dream-echo-cross-session-leak`

## Path

1. **Source / trust boundary:** Light dreams derive insights/narratives from one completed session, and REM dreams derive them from stored memories.
2. **Nearest or broken control:** The echo schema and workspace-wide file omit agent/session/chat/user/destination identity; loadFreshDreamEcho selects only by freshness, while the before-prompt hook knows the current context but supplies only workspaceDir.
3. **Sink:** The newest echo sentence is inserted into the next eligible prompt's fullMemoriesContext and can be reflected in the response to whichever session contacts that workspace first.
4. **Security outcome if exploitable:** A confidential health, relationship, credential, or project topic from one chat can be alluded to or repeated to another user/session sharing the agent workspace.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

