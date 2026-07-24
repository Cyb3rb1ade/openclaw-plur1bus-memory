# Validation — Timeout fallback can replay another workspace's cached recall context

Candidate: `cand-recall-timeout-cache-cross-workspace`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-032.json`
- Attacker-controlled source: A caller in workspace B reaches before_prompt_build for the same agent, session identifier, and first 500 prompt characters as an earlier workspace-A recall, while its own recall operation reaches the scheduler timeout.
- Closest/broken control: The normal recall function applies ACL for its own context, but recallCache stores the completed result without scope metadata and cachedRecall returns it based only on the caller-supplied key. The production key omits workspaceKey, workspaceDir, user identity, and access context.
- Sink: runRecall returns `{ok:true, value, timedOut:true, fromCache:true}` and index.js returns that unfiltered `value` as the new prompt hook's prependContext.
- Claimed impact: A timeout in one workspace can inject stale memory/Neo/reminder context constructed for another workspace into the new model invocation, enabling confidential-context disclosure and incorrect cross-workspace behavior.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
