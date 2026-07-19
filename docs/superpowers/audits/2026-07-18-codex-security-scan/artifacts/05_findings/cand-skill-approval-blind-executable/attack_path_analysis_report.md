# Attack-path analysis — Skill approval can activate LLM-generated instructions that the default review omits

Candidate: `cand-skill-approval-blind-executable`

## Path

1. **Source / trust boundary:** Stored memory excerpts are supplied to an LLM that returns arbitrary instructions.
2. **Nearest or broken control:** Evidence trust/confidence gates and explicit authorized approval exist, but the default pending-proposal review shows only title, score, confidence, and an 80-character description; approval is bound only to an ID, not an exact displayed content hash.
3. **Sink:** approveProposal renders the unshown instructions verbatim into workspace skills/<safeSlug>/SKILL.md, which is executable agent configuration on later skill loading.
4. **Security outcome if exploitable:** Prompt-injected or compromised-model instructions can be approved under an innocuous summary and later steer tool use/data access with the user's skill authority.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

