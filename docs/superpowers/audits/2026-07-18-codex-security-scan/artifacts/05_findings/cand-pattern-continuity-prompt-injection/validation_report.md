# Validation — REM-generated pattern descriptions are injected into prompts outside the recall-safety boundary

Candidate: `cand-pattern-continuity-prompt-injection`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-042.json`
- Attacker-controlled source: REM dreaming asks an LLM to summarize attacker-influenceable memory text and accepts patternName/description as arbitrary strings bounded only by length.
- Closest/broken control: validatePatternSchema does not enforce a declarative grammar or remove instruction-like content. formatPatternBlock strips XML punctuation and quotes only, then relevant-memory-context appends the block after the explicitly untrusted <relevant-memories> envelope and its no-actions safety preamble.
- Sink: The resulting memory-continuity prose is prepended to the next agent prompt and can issue instruction-like text to a tool-capable model.
- Claimed impact: A stored-memory prompt injection can survive the REM summarizer and be elevated into a trusted-looking continuity narrative, influencing model responses or tool choices on later turns. A deterministic reproduction confirmed instruction text is preserved unchanged in the final block.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
