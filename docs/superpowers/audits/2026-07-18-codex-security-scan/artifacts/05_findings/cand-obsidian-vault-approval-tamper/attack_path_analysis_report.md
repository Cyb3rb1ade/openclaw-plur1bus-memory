# Attack-path analysis — An untrusted Obsidian vault can self-assert vault confirmation and forge approved review payloads

Candidate: `cand-obsidian-vault-approval-tamper`

## Path

1. **Source / trust boundary:** A collaborator, sync peer, compromised Obsidian plugin, or other principal able to modify the explicitly untrusted vault can alter .adaptive-learning/obsidian-bridge/confirmed-vaults.json and plur1bus/review-bundles/*.items.json independently of the Markdown a human reviews.
2. **Nearest or broken control:** Vault confirmation is read from a file inside the vault and accepted by matching workspace.path. Review status, adversarial result, payload, payloadHash, approvedPayloadHash, explicit-global flags, and approvalMetadata are also loaded from vault JSON. The apply validator compares mutually attacker-controlled hashes and never authenticates approvalHash against an external user/chat/nonce-bound receipt or secret.
3. **Sink:** syncWorkspace accepts the forged vault confirmation before its apply path; applyApprovedReviewBundle accepts forged status='approved' and consistent attacker-recomputed hashes, then passes the forged semantic payload to memoryStore or knowledgeUpdate (or writes a task file).
4. **Security outcome if exploitable:** A malicious shared/synchronized vault can bypass the safety gate and inject attacker-selected durable memories/knowledge when apply runs, including global/user-scope approval metadata, while leaving the human-readable review Markdown benign. This violates the code's own untrusted-Obsidian trust model.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Addendum — Attack-path and policy recalibration (2026-07-18)

- **Context:** Vault confirmation and review approval are real trust controls; the threat model treats Obsidian as an untrusted mirror.
- **Exposure / vector:** Shared-vault collaborator/sync access is plausible but not reproduced.
- **Cross-boundary behavior:** Unverified. Static code permits mutually attacker-controlled hashes, but no collaborator-to-authorized-apply transcript exists.
- **Preconditions:** Write access to the vault bundle JSON plus a later authorized apply/sync invocation, or a separately established authorization bypass.
- **Counterevidence:** The attacker cannot normally invoke direct apply without authorization; chaining the Dry-run finding is possible but is not candidate-local proof.
- **Impact surface:** Durable memory/knowledge integrity and approval provenance.

**Severity calibration:** not finalized while the cross-principal tamper-to-apply path remains unproved.  
**Final policy decision:** **deferred**.
