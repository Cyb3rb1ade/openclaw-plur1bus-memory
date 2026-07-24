# Attack-path analysis — REM-generated pattern descriptions are injected into prompts outside the recall-safety boundary

Candidate: `cand-pattern-continuity-prompt-injection`

## Path

1. **Source / trust boundary:** REM dreaming asks an LLM to summarize attacker-influenceable memory text and accepts patternName/description as arbitrary strings bounded only by length.
2. **Nearest or broken control:** validatePatternSchema does not enforce a declarative grammar or remove instruction-like content. formatPatternBlock strips XML punctuation and quotes only, then relevant-memory-context appends the block after the explicitly untrusted <relevant-memories> envelope and its no-actions safety preamble.
3. **Sink:** The resulting memory-continuity prose is prepended to the next agent prompt and can issue instruction-like text to a tool-capable model.
4. **Security outcome if exploitable:** A stored-memory prompt injection can survive the REM summarizer and be elevated into a trusted-looking continuity narrative, influencing model responses or tool choices on later turns. A deterministic reproduction confirmed instruction text is preserved unchanged in the final block.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

