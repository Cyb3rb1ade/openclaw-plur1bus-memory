# Validation — Feature-cron fallback ignores bound conversation identity and uses Telegram DM allowFrom as the delivery target

Candidate: `cand-feature-cron-channel-target-confusion`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-034.json`
- Attacker-controlled source: OpenClaw bindings identify the agent's routed Telegram account and may include an exact direct/group/channel peer; Telegram allowFrom contains inbound DM sender identities.
- Closest/broken control: deriveDeliveryFromChannelConfig filters only agentId/channel/accountId, ignores match.peer, and chooses the sole account.allowFrom entry without applying OpenClaw's effective inherited/default-account semantics or validating target kind.
- Sink: planSpecForAgents marks the afterthought cron enabled and passes the derived user ID as delivery.to for recurring proactive messages.
- Claimed impact: Afterthought content can be delivered to a DM identity instead of the group/topic/conversation actually bound to the agent, causing wrong-recipient disclosure or silently breaking the intended feature route.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
