# Attack-path analysis — Safe setup profile is merged with write-enabled Full Experience defaults

Candidate: `cand-safe-profile-unexpected-privileged-activation`

## Path

1. **Source / trust boundary:** An authorized owner invokes /plur1bus setup safe expecting the documented write-/LLM-intensive features to remain inactive.
2. **Nearest or broken control:** safeProfile defines only a small disabled subset; applyFeatureProfile then calls applyFullExperiencePolicy, whose mergeMissing fills every omitted core feature and operational flag with enabled Full Experience values. The Safe Profile's mode='dry-run' is schema-invalid and does not set the runtime dryRun boolean.
3. **Sink:** The resulting runtime config enables skill mining, daily consolidation, critical push, Obsidian writes/semantic graph/SoulPatch creation and other intensive features, with obsidianBridge.dryRun=false and allowWrite=true.
4. **Security outcome if exploitable:** The safety choice can authorize persistent writes, LLM processing, notifications, and maintenance behavior that the operator explicitly selected Safe Profile to avoid.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

