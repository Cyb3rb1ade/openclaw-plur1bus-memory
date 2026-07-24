# Attack-path analysis — Neo recall exposes agent-private records to other agents sharing a workspace

Candidate: `cand-neo-agent-private-cross-agent-recall`

## Path

1. **Source / trust boundary:** Auto-capture records assistant-authored turns and memory candidates for Agent A with origin/visibility scope agent_private and an explicit agentId.
2. **Nearest or broken control:** The Neo store path contains only the workspace key, and every read/recall helper ignores origin.scope, visibility.scope, and record.agentId; no requester agent is accepted by routeNeoRecall or findLatestNeoRecord.
3. **Sink:** Agent B's before_prompt_build path reads all candidates/behavior cards from the shared workspace store and injects matching records into B's prompt. The registered memory corpus search/get paths can also return the unfiltered record.
4. **Security outcome if exploitable:** Assistant output, plans, mistakes, or sensitive context explicitly classified as agent-private can be disclosed to and influence another agent. This violates the plugin's per-agent isolation model and can also provide a cross-agent persistent prompt-poisoning channel through historical evidence.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Calibration addendum — existing integration evidence

The prior calibration overlooked the discovery receipt's actual bounded integration evidence. It proves the data path through the real filesystem-backed Neo store and `routeNeoRecall`: a private Agent-A candidate is readable and selected by a simulated Agent B when both resolve to the same workspace key. The registered before-prompt hook performs the same unfiltered store read and route. There is no authorization decision to defeat at this stage; the requester agent is absent from the helper API.

The remaining condition—two bound agents sharing a workspace—is documented by the product rather than merely invented for a test. It limits exposure to multi-agent deployments but does not neutralize an explicit `agent_private` isolation promise.

**Policy decision revised: reportable, P2 / Medium.** A feature-preserving control is scope-aware filtering at Neo read boundaries: matching agent for `agent_private`, deliberate workspace handling for `workspace_shared`, and existing global behavior retained.
