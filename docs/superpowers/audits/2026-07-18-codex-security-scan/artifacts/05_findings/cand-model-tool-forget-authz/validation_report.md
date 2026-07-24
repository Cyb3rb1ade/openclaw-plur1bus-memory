# Validation — Model-facing memory_forget mutates durable memory without user-bound authorization

Candidate: `cand-model-tool-forget-authz`  
Scope: repository snapshot `6dff096e`  
Date: 2026-07-18

## Validation rubric

- [x] Discovery source, closest control, and sink are preserved below.
- [x] The repository code path was traced against the completed receipt.
- [ ] A bounded dynamic reproduction was not completed for this candidate.
- [x] The remaining proof gap and conservative disposition are stated.

## Method

Static source-to-sink trace using the independently reviewed discovery receipt. This bounded audit did not run a target-host exploit simulation for this candidate.

## Evidence

- Discovery receipt: `artifacts/02_discovery/candidate_model_tool_forget.json`
- Attacker-controlled source: Untrusted chat, retrieved content, or stored memory can influence the model's tool-selection and tool arguments; model tool calls carry no userId/chatId authorization context (as acknowledged by index.js:4872).
- Closest/broken control: The only control is an opt-out config flag that defaults to allow. The command-path isAuthorized plus user/chat/nonce confirmation flow is not called before db.delete.
- Sink: db.delete(memoryId)
- Claimed impact: A prompt-injection or mistaken model action can remove durable long-term memories for the active agent. The archive makes recovery possible but does not prevent integrity/availability loss or user-visible forgetting.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
