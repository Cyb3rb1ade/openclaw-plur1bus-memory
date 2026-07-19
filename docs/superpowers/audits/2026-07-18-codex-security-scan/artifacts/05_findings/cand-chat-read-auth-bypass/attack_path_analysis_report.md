# Attack-path analysis — Sensitive chat read commands bypass configured user and chat allowlists

Candidate: `cand-chat-read-auth-bypass`

## Path

1. **Source / trust boundary:** Any participant able to invoke registered Telegram, Discord, Slack, or Mattermost commands supplies recall queries and read subcommands.
2. **Nearest or broken control:** The command handlers validate input length and, for memory rows, scope metadata, but never call checkAuth/isAuthorized for non-destructive reads; configured allowedUserIds/allowedChatIds are therefore not consulted.
3. **Sink:** Reminder list renders reminder text/IDs, curation and Neo origin/explain/behavior commands serialize records, and /memory renders matching long-term memory summaries/IDs to the invoking chat.
4. **Security outcome if exploitable:** A non-allowlisted user in a shared channel can enumerate private reminders, memory-derived records, behavior cards, provenance, and agent-private memory content associated with the routed agent/workspace.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Cross-Scope-/Cross-Principal-Addendum — 2026-07-18

### Attack-path facts from existing receipts

- **In scope / exposure:** the threat model names Telegram/chat commands as user-facing inspection and editing surfaces. `review-039.json` identifies a registered multi-channel `/wiki` handler; public Internet ingress is deployment-dependent, but a routed shared chat is a real product interface rather than a local-only maintenance path.
- **Identity and boundary:** a configured `allowedUserIds`/`allowedChatIds` policy separates the operator-approved principal from an excluded chat participant. `review-039.json` records an existing handler mock in which the excluded user read an agent-private wiki row because default search omitted `checkWikiAuth`.
- **Control and sink:** `review-036.json` documents analogous omitted `checkAuth`/`isAuthorized` calls for `/memory`, speaker mappings, skill proposal reads, and `/state`. The sensitive result is rendered to the invoking chat; no privileged local access is required.
- **Counterevidence:** a private chat or absent allowlist removes the cross-principal condition, and record ACL can reduce the particular row set. Those are preconditions/mitigations, not a defense for the verified agent-private read under an active allowlist.

### Calibration and final policy decision

Impact is medium because protected memory-derived data is returned to an excluded human principal; likelihood is medium/unknown because shared routed-chat topology is required. The severity matrix therefore supports **Medium (P2)**. **Final decision: reportable.**
