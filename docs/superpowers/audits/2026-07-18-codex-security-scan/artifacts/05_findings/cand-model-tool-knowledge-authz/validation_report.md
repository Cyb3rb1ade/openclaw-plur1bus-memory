# Validation — Model-facing knowledge_update rewrites durable curated knowledge without user-bound authorization

Candidate: `cand-model-tool-knowledge-authz`  
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

- Discovery receipt: `artifacts/02_discovery/candidate_model_tool_knowledge.json`
- Attacker-controlled source: Untrusted chat/retrieved/stored content can influence model tool selection; pending memory text and optional model-supplied note are then embedded in the curator prompt.
- Closest/broken control: The operation is gated only by an opt-out flag defaulting to allow and feature configuration. It does not invoke isAuthorized, createConfirmation, or validateConfirmation before rewriting KNOWLEDGE.md.
- Sink: renameSync(temp, memory/KNOWLEDGE.md)
- Claimed impact: Prompt injection or model error can prematurely promote attacker-influenced memories into durable curated context, rewrite the knowledge body, and shape future agent behavior.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
