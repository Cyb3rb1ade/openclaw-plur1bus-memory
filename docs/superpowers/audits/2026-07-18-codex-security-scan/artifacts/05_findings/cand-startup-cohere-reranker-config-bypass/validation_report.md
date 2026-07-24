# Validation — Startup patch uploads native-memory queries and snippets despite a local or disabled reranker selection

Candidate: `cand-startup-cohere-reranker-config-bypass`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-040.json`
- Attacker-controlled source: OpenClaw native memory search produces a cleaned user query and merged result snippets that can contain private conversation and memory content.
- Closest/broken control: The installer always applies the patch, and the injected code treats presence of COHERE_API_KEY in the OpenClaw state .env as the sole enablement signal. It never checks the effective configured reranker provider/enabled state, including the installer's explicit local and disabled modes.
- Sink: The patched manager POSTs query=cleaned and documents=merged snippets to the fixed https://api.cohere.com/v2/rerank endpoint with the discovered key.
- Claimed impact: An operator who selected local or disabled reranking, or retained a Cohere key for another component, can unknowingly disclose memory queries and retrieved snippets to a third-party service.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
