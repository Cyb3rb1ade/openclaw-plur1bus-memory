# Attack-path analysis — Model-facing memory_forget mutates durable memory without user-bound authorization

Candidate: `cand-model-tool-forget-authz`

## Path

1. **Source / trust boundary:** Untrusted chat, retrieved content, or stored memory can influence the model's tool-selection and tool arguments; model tool calls carry no userId/chatId authorization context (as acknowledged by index.js:4872).
2. **Nearest or broken control:** The only control is an opt-out config flag that defaults to allow. The command-path isAuthorized plus user/chat/nonce confirmation flow is not called before db.delete.
3. **Sink:** db.delete(memoryId)
4. **Security outcome if exploitable:** A prompt-injection or mistaken model action can remove durable long-term memories for the active agent. The archive makes recovery possible but does not prevent integrity/availability loss or user-visible forgetting.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

