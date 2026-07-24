# Validation — REM dreaming relabels and persists memories from other workspaces and owners

Candidate: `cand-rem-dream-cross-workspace-leak`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-005.json`
- Attacker-controlled source: Recent active memory rows in one per-agent LanceDB table carry workspaceKey, scope, and ownerUserId and can belong to different workspaces/users.
- Closest/broken control: loadCandidateMemories receives the requested workspaceKey/agentId but filters only time/status/dream class; it neither compares row bindings nor calls checkAccess, and it preserves or defaults those bindings only after selection.
- Sink: Foreign row text is sent to the pattern/narrative LLMs and copied into evidenceQuotes, patterns, trends, dream memories, dream echoes, and Markdown under the requested workspace identity.
- Claimed impact: A REM run for one workspace can disclose another workspace/user's memories to the configured model provider and persist exact evidence or derived content into artifacts visible and influential in the wrong workspace.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Calibration addendum — existing full-run evidence re-evaluated

No new reproduction was run. `review-005.json` already records both a mixed-workspace candidate query and a full bounded REM run: three workspace-B confidential rows were supplied while workspace A was requested; with `force=true`, the real run persisted a workspace-A pattern whose `evidenceQuotes` contained all three exact workspace-B strings. This matches the production dataflow: `loadCandidateMemories` receives `workspaceKey`/`agentId` but only filters time/status/dream class (`lib/dreaming/rem-dream.js:90-132`), then the pattern/evidence output is stamped with the requested workspace (`:536-565`) and written to the workspace store/vault (`index.js:3057-3083`).

The multi-workspace same-agent condition is a supported data-model configuration: records include workspace/user binding fields and the normal ACL model distinguishes them. It is not remedied by the documented preference for one agent per workspace. Exact evidence persistence does not depend on an attacker controlling an LLM response.

**Revised disposition: reportable — P2 / Medium. Confidence: 0.90.** Preserve REM dreaming by applying the existing access/binding predicate before candidate selection and retaining those bindings through every LLM, evidence, pattern, echo, and vault artifact path.
