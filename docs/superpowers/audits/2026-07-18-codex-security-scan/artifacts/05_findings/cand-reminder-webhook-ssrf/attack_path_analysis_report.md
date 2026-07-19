# Attack-path analysis — Reminder webhook accepts an unrestricted destination

Candidate: `cand-reminder-webhook-ssrf`

## Path

1. **Source / trust boundary:** reminders.webhookUrl from plugin configuration.
2. **Nearest or broken control:** No URL scheme, host, address-range, redirect, or credential policy is applied in reminder-dispatch/fetch-with-timeout.
3. **Sink:** An HTTP POST containing agentId, workspaceKey, reminder ID/text/time is sent to the URL.
4. **Security outcome if exploitable:** If a lower-trust configuration path exists, it can probe internal services and exfiltrate reminder data.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

