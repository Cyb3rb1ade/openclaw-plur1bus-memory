# Validation — Skill-miner dry-run still persists LLM-generated proposals

Candidate: `cand-skill-miner-dryrun-write`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-013.json`
- Attacker-controlled source: An operator/caller invokes runSkillMiner with opts.dryRun=true and qualifying evidence exists.
- Closest/broken control: dryRun gates only report append and recordJobRun; it is not checked before writeProposal.
- Sink: writeProposal appends the LLM candidate to .adaptive-learning/skill-proposals.jsonl.
- Claimed impact: A purported non-mutating run changes the executable-skill review queue and permanently blocks same-name proposals through deduplication.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
