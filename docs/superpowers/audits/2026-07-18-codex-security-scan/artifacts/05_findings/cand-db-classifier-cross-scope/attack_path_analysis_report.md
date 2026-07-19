# Attack-path analysis — Critical classifier processes and exports foreign-scope cards without object authorization

Candidate: `cand-db-classifier-cross-scope`

## Path

1. **Source / trust boundary:** Fresh unclassified memory rows can be workspace-scoped or scope:'user' with an ownerUserId while sharing an agent table.
2. **Nearest or broken control:** findRecentUnclassified receives only agent/time, filters no workspace/scope/owner, and runClassifier has no caller identity; updateCardType mutates the selected UUID without a record ACL check.
3. **Sink:** The full card enters the classifier model, its type is mutated, and critical content is returned as a pushMessages payload for the current cron carrier and serialized by the caller.
4. **Security outcome if exploitable:** A private card can be disclosed to the wrong cron destination/provider and changed outside its owner/workspace authorization context.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Cross-Scope-/Cross-Principal-Addendum — 2026-07-18

### Attack-path facts from existing receipts

- **In scope:** background critical-push classification is a production memory workflow in the threat model.
- **Verified behavior:** `review-005.json` records agent-only classification of a victim-owned workspace-B row, a type update, and a push payload containing the full diagnosis text. This proves the missing object-scope gate before the payload is built.
- **Preconditions:** same-agent multi-scope storage plus a classifier run; a victim's unclassified card supplies the immediate trigger.
- **Cross-boundary gap:** the existing evidence does not bind the current cron carrier, external provider, or log reader to a distinct recipient principal. It therefore does not show that the full payload crosses from victim B to requester A (or any lower-privileged attacker).
- **Counterevidence:** the result is serialized by a caller and generic logging exists, but neither fact establishes an untrusted recipient or user-controlled destination. The issue cannot be promoted merely by assuming such access.

### Calibration and final policy decision

The DB/control failure is confirmed; the reportability-driving disclosure/destination fact is not. **Final decision: deferred.**
