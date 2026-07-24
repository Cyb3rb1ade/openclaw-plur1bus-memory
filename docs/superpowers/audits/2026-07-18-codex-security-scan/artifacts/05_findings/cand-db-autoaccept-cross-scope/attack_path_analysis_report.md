# Attack-path analysis — Stale critical auto-accept confirms foreign user/workspace records

Candidate: `cand-db-autoaccept-cross-scope`

## Path

1. **Source / trust boundary:** Old unconfirmed critical rows include owner and workspace scope metadata in a shared per-agent table.
2. **Nearest or broken control:** findUnconfirmedCritical filters only cutoff/type/confirmed and autoAcceptStale passes only agent; markConfirmed updates by UUID with no ctx, owner, or workspace comparison.
3. **Sink:** The selected row's confirmed field is set to 1 by the daily background job.
4. **Security outcome if exploitable:** A sensitive memory can be silently accepted under a different user's/workspace's job context, bypassing the owner review state and affecting later retention or confirmation workflows.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Cross-Scope-/Cross-Principal-Addendum — 2026-07-18

### Attack-path facts from existing receipts

- **In scope:** the threat model describes per-agent LanceDB as the authoritative memory store and background jobs as a production workflow.
- **Verified behavior:** `review-005.json` records a valid victim-owned workspace-B row selected by an agent-only stale-auto-accept run and mutated to `confirmed:1`; no owner/workspace predicate ran at the listed DB/job controls.
- **Preconditions:** a same-agent multi-scope table, a victim critical row older than the cutoff, and scheduled execution.
- **Cross-boundary gap:** no receipt shows an attacker selecting the victim row, invoking the scheduler as a different principal, or consuming `confirmed` in a way that changes authorization, retention, or disclosure. The job's lack of caller identity is a missing control but is not itself evidence of a lower-privileged attacker path.
- **Counterevidence:** UUID knowledge and direct command control are unnecessary, but the automatic system action is not attributable to a different untrusted principal on the evidence available.

### Calibration and final policy decision

The exact state transition is proven, while attacker reachability and security consequence are unknown. Per the policy, do not promote it on a speculative chain. **Final decision: deferred.**
