# Attack-path analysis — Emotion value objects accept unbounded labels that can reach persistent mood prompt formatting

Candidate: `cand-mood-state-prompt-injection`

## Path

1. **Source / trust boundary:** EmotionScore can be constructed from classifier/custom-extension output, and emotional state can also be hydrated from persisted workspace JSON.
2. **Nearest or broken control:** Only core numeric ranges are validated; label enums, string lengths, newlines/control characters, nested object shapes, and nuance/complex-emotion label provenance are not enforced.
3. **Sink:** Downstream emotional-state formatting preserves unknown nuance labels and the packaged before_prompt_build injector interpolates the resulting mood label/nuance line into model instructions.
4. **Security outcome if exploitable:** If a reachable producer introduces control text as a mood/nuance label, it can persist and inject instruction-like content into later model turns.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

