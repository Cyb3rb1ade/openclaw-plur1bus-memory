# Validation — Sensitive chat read commands bypass configured user and chat allowlists

Candidate: `cand-chat-read-auth-bypass`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-001.json, artifacts/02_discovery/file_reviews/review-036.json`
- Attacker-controlled source: Any participant able to invoke registered Telegram, Discord, Slack, or Mattermost commands supplies recall queries and read subcommands.
- Closest/broken control: The command handlers validate input length and, for memory rows, scope metadata, but never call checkAuth/isAuthorized for non-destructive reads; configured allowedUserIds/allowedChatIds are therefore not consulted.
- Sink: Reminder list renders reminder text/IDs, curation and Neo origin/explain/behavior commands serialize records, and /memory renders matching long-term memory summaries/IDs to the invoking chat.
- Claimed impact: A non-allowlisted user in a shared channel can enumerate private reminders, memory-derived records, behavior cards, provenance, and agent-private memory content associated with the routed agent/workspace.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Cross-Scope-/Cross-Principal-Addendum — 2026-07-18

This addendum re-evaluates only existing scan evidence; it adds no new reproduction. `review-039.json` records that the registered multi-channel `/wiki` handler reaches a default-search branch without `checkWikiAuth` and that a benign public-handler mock let an unauthorized allowlist user read an agent-private wiki row. The same receipt records that `checkAccess` denied a foreign workspace row, so the proof distinguishes the configured human/chat allowlist boundary from record ACL behavior rather than treating the latter as a substitute control. `review-036.json` independently records the same missing allowlist check for `/memory`, speaker mapping reads, skill proposal reads, and `/state`; `openclaw.plugin.json` defines `allowedUserIds`/`allowedChatIds`.

**Preconditions:** an operator has configured an allowlist and routes a shared chat to the agent; the excluded participant invokes a read command. These are documented product conditions: the threat model calls Telegram/chat commands user-facing inspection surfaces. **Counterevidence:** the issue does not apply where no allowlist is configured or no excluded participant can reach the routed chat, and record-level ACL still filters some rows. Neither fact defeats the independently demonstrated principal boundary: the invoking non-allowlisted user receives a protected agent-private result despite the configured allowlist.

**Disposition (supersedes the initial conservative result): reportable, recommended Medium/P2.** The existing handler-level mock proves a realistic cross-principal read path and direct chat-output sink; no extra deployment or exploit simulation is required to establish that boundary failure.
