# Validation — Safe reconsolidation drops workspace ownership from corrected memories

Candidate: `cand-safe-update-workspace-binding-loss`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-033.json`
- Attacker-controlled source: An authorized /correct operation targets an active scope:'workspace' memory that carries workspaceKey/workspaceId ownership metadata.
- Closest/broken control: buildUpdateEntry manually reconstructs the new row and copies scope but omits workspaceKey/workspaceId; MemoryDB.store fills the absent schema field with an empty string, and the ACL's legacy compatibility branch allows workspace rows with no binding.
- Sink: safeUpdate stores the unbound replacement as active, then supersedes the correctly bound original; subsequent recall or mutation paths treat the replacement as visible from another workspace sharing the agent database.
- Claimed impact: Correcting a workspace-scoped memory can broaden its visibility from one workspace to every workspace served by that agent, exposing the corrected content and enabling later wrong-workspace operations.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Calibration addendum — existing construction and ACL evidence re-evaluated

No new reproduction was run. The existing validation facts establish the entire value transition: a workspace-A row passed to `buildUpdateEntry` loses `workspaceKey`; normal table normalization supplies `workspaceKey: ""`; `checkAccess` for workspace B then returns `allowed: true`. The code confirms that `safeUpdate` stores that exact new entry before superseding the original (`lib/safe-update.js:329-341`) and the normal authorized `/correct` flow calls `safeUpdate` directly (`index.js:4085-4123`). The old-card ACL/confirmation is therefore not a countercontrol: it authorizes correction of the old row but does not preserve its replacement binding.

The required same-agent multi-workspace database is an explicit ACL/data-model condition, not an unsupported attack assumption. The resulting cross-workspace read is a normal consequence of the legacy empty-binding branch at `lib/acl-middleware.js:71-79`.

**Revised disposition: reportable — P2 / Medium. Confidence: 0.80.** Preserve archive-first correction and reconsolidation by copying `workspaceKey`/`workspaceId` into the replacement and enforcing a post-build binding-invariant before store.
