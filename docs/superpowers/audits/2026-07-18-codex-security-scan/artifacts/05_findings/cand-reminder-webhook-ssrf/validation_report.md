# Validation — Reminder webhook accepts an unrestricted destination

Candidate: `cand-reminder-webhook-ssrf`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-012.json`
- Attacker-controlled source: reminders.webhookUrl from plugin configuration.
- Closest/broken control: No URL scheme, host, address-range, redirect, or credential policy is applied in reminder-dispatch/fetch-with-timeout.
- Sink: An HTTP POST containing agentId, workspaceKey, reminder ID/text/time is sent to the URL.
- Claimed impact: If a lower-trust configuration path exists, it can probe internal services and exfiltrate reminder data.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
