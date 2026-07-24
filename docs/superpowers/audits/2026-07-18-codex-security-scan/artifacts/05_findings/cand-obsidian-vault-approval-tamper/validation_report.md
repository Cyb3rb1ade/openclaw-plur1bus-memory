# Validation — An untrusted Obsidian vault can self-assert vault confirmation and forge approved review payloads

Candidate: `cand-obsidian-vault-approval-tamper`  
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
- Attacker-controlled source: A collaborator, sync peer, compromised Obsidian plugin, or other principal able to modify the explicitly untrusted vault can alter .adaptive-learning/obsidian-bridge/confirmed-vaults.json and plur1bus/review-bundles/*.items.json independently of the Markdown a human reviews.
- Closest/broken control: Vault confirmation is read from a file inside the vault and accepted by matching workspace.path. Review status, adversarial result, payload, payloadHash, approvedPayloadHash, explicit-global flags, and approvalMetadata are also loaded from vault JSON. The apply validator compares mutually attacker-controlled hashes and never authenticates approvalHash against an external user/chat/nonce-bound receipt or secret.
- Sink: syncWorkspace accepts the forged vault confirmation before its apply path; applyApprovedReviewBundle accepts forged status='approved' and consistent attacker-recomputed hashes, then passes the forged semantic payload to memoryStore or knowledgeUpdate (or writes a task file).
- Claimed impact: A malicious shared/synchronized vault can bypass the safety gate and inject attacker-selected durable memories/knowledge when apply runs, including global/user-scope approval metadata, while leaving the human-readable review Markdown benign. This violates the code's own untrusted-Obsidian trust model.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Addendum — Existing-reproduction cross-principal recalibration (2026-07-18)

This addendum supersedes the earlier rationale while retaining a deferred disposition. No new PoC was run; only `artifacts/02_discovery/file_reviews/review-018.json` was used.

### Receipt-based rubric

- [x] The receipt statically shows that approval-related hashes and status are loaded from the mutable vault.
- [x] It identifies the absence of an externally authenticated approval receipt.
- [ ] No `.items.json`-only tamper was applied while leaving the reviewed Markdown unchanged.
- [ ] No forged payload was shown reaching `memoryStore` across a vault-collaborator/authorized-user boundary.

### Recalibrated result

The trust-design weakness is plausible, but the receipt presents the decisive tamper-and-apply exercise as future work. It also requires a subsequent authorized apply or a separate bypass chain, so the exact cross-principal path is not yet proved.

**Disposition:** deferred.  
**Survives:** uncertain.  
**Confidence:** 0.45.  
**Minimal next proof:** tamper only the authoritative bundle JSON as a distinct vault principal, then show an authorized apply accepts the forged item and reaches a memory-store spy.
