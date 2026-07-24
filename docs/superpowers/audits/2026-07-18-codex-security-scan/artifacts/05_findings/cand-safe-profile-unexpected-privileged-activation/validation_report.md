# Validation — Safe setup profile is merged with write-enabled Full Experience defaults

Candidate: `cand-safe-profile-unexpected-privileged-activation`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-034.json`
- Attacker-controlled source: An authorized owner invokes /plur1bus setup safe expecting the documented write-/LLM-intensive features to remain inactive.
- Closest/broken control: safeProfile defines only a small disabled subset; applyFeatureProfile then calls applyFullExperiencePolicy, whose mergeMissing fills every omitted core feature and operational flag with enabled Full Experience values. The Safe Profile's mode='dry-run' is schema-invalid and does not set the runtime dryRun boolean.
- Sink: The resulting runtime config enables skill mining, daily consolidation, critical push, Obsidian writes/semantic graph/SoulPatch creation and other intensive features, with obsidianBridge.dryRun=false and allowWrite=true.
- Claimed impact: The safety choice can authorize persistent writes, LLM processing, notifications, and maintenance behavior that the operator explicitly selected Safe Profile to avoid.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
