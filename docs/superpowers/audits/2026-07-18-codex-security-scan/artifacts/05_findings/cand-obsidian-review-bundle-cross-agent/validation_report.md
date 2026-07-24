# Validation — Shared-vault ReviewBundles are selected and applied without agent/workspace ownership checks

Candidate: `cand-obsidian-review-bundle-cross-agent`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-018.json`
- Attacker-controlled source: Two agent/workspace contexts use the same configured vaultPath, or a user in one agent context supplies/selects a ReviewBundle created for another agent in that shared review directory.
- Closest/broken control: Global vaultPath takes priority for every context. Auto bundle IDs contain only UTC date/hour/minute and can collide across agents. latestReviewBundleId scans every .items.json without filtering record.bundle.workspaceKey or createdByAgent, and load/apply never compares those fields to options.agentId/workspaceKey.
- Sink: The selected foreign bundle is approved/applied through the current command context; the production memoryStore callback stores its payload under commandCtx.agentId/workspaceDir, while same-minute prepareReviewBundle calls can overwrite the same bundle files.
- Claimed impact: A proposal from agent/workspace A can be silently selected, overwritten, approved, or written into agent B's authoritative LanceDB memory, breaking per-agent isolation and confusing audit provenance. Concurrent review generation can also destroy one agent's pending review state.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Addendum — Existing-reproduction cross-principal recalibration (2026-07-18)

This addendum supersedes the earlier rationale while retaining a deferred disposition. No new PoC was run; only `artifacts/02_discovery/file_reviews/review-018.json` was used.

### Receipt-based rubric

- [x] Missing `workspaceKey` / `createdByAgent` checks are statically identified.
- [x] The current-context `memoryStore` sink and shared `vaultPath` precondition are traced.
- [ ] No two-agent shared-vault reproduction was performed.
- [ ] No foreign bundle was shown selected or stored under the second agent.

### Recalibrated result

The claimed boundary is genuinely cross-agent, but the receipt presents the decisive A-to-B exercise as a future validation step. The supported shared-vault topology and concrete foreign-bundle application remain proof gaps.

**Disposition:** deferred.  
**Survives:** uncertain.  
**Confidence:** 0.45.  
**Minimal next proof:** use two isolated agent identities sharing one configured vault and show B's apply selects or stores A's approved bundle.
