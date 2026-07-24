# Attack-path analysis — Skill-miner dry-run still persists LLM-generated proposals

Candidate: `cand-skill-miner-dryrun-write`

## Path

1. **Source / trust boundary:** An operator/caller invokes runSkillMiner with opts.dryRun=true and qualifying evidence exists.
2. **Nearest or broken control:** dryRun gates only report append and recordJobRun; it is not checked before writeProposal.
3. **Sink:** writeProposal appends the LLM candidate to .adaptive-learning/skill-proposals.jsonl.
4. **Security outcome if exploitable:** A purported non-mutating run changes the executable-skill review queue and permanently blocks same-name proposals through deduplication.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

