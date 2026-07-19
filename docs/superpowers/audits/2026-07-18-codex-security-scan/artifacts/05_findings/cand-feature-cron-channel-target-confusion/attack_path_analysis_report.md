# Attack-path analysis — Feature-cron fallback ignores bound conversation identity and uses Telegram DM allowFrom as the delivery target

Candidate: `cand-feature-cron-channel-target-confusion`

## Path

1. **Source / trust boundary:** OpenClaw bindings identify the agent's routed Telegram account and may include an exact direct/group/channel peer; Telegram allowFrom contains inbound DM sender identities.
2. **Nearest or broken control:** deriveDeliveryFromChannelConfig filters only agentId/channel/accountId, ignores match.peer, and chooses the sole account.allowFrom entry without applying OpenClaw's effective inherited/default-account semantics or validating target kind.
3. **Sink:** planSpecForAgents marks the afterthought cron enabled and passes the derived user ID as delivery.to for recurring proactive messages.
4. **Security outcome if exploitable:** Afterthought content can be delivered to a DM identity instead of the group/topic/conversation actually bound to the agent, causing wrong-recipient disclosure or silently breaking the intended feature route.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

