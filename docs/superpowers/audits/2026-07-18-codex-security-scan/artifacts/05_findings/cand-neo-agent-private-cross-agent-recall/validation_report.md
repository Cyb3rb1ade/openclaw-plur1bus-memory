# Validation — Neo recall exposes agent-private records to other agents sharing a workspace

Candidate: `cand-neo-agent-private-cross-agent-recall`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-017.json`
- Attacker-controlled source: Auto-capture records assistant-authored turns and memory candidates for Agent A with origin/visibility scope agent_private and an explicit agentId.
- Closest/broken control: The Neo store path contains only the workspace key, and every read/recall helper ignores origin.scope, visibility.scope, and record.agentId; no requester agent is accepted by routeNeoRecall or findLatestNeoRecord.
- Sink: Agent B's before_prompt_build path reads all candidates/behavior cards from the shared workspace store and injects matching records into B's prompt. The registered memory corpus search/get paths can also return the unfiltered record.
- Claimed impact: Assistant output, plans, mistakes, or sensitive context explicitly classified as agent-private can be disclosed to and influence another agent. This violates the plugin's per-agent isolation model and can also provide a cross-agent persistent prompt-poisoning channel through historical evidence.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Calibration addendum — existing validation facts re-evaluated

No new reproduction was run. The discovery receipt already contains a bounded temporary-store integration proof: an assistant candidate labelled `agent_private` with `agentId=agent-a` was appended through `createNeoStore(root, "shared-workspace")`; a simulated Agent B opening the same supported workspace key read the row and `routeNeoRecall` selected it for a matching query. The public routing API takes no requester-agent parameter. The runtime hook likewise reads all candidates/behavior cards and calls `routeNeoRecall` without an agent/scope filter (`index.js:5563-5573`).

The shared-workspace precondition is realistic rather than hypothetical: repository documentation explicitly discusses two bound agents sharing a workspace (`README.md:221-224`). That layout is discouraged for feature-cron duplication, but is not rejected, and `agent_private` is an explicit Neo scope (`lib/neo-arch.js:61`). This is a direct cross-agent confidentiality and prompt-context breach in a supported multi-agent shape.

**Revised disposition: reportable — P2 / Medium. Confidence: 0.85.** Preserve workspace-shared/global behavior by filtering every Neo read/recall/corpus-get operation for requester identity and requiring an `agentId` match for `agent_private` records.
