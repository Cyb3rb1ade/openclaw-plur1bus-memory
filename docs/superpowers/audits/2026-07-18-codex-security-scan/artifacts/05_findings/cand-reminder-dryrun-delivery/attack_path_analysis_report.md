# Attack-path analysis — Reminder dry-run performs real webhook or host-callback delivery

Candidate: `cand-reminder-dryrun-delivery`

## Path

1. **Source / trust boundary:** An operator/caller invokes runReminderDispatch with dryRun=true and a due reminder.
2. **Nearest or broken control:** The flag wraps local state changes only and is absent from delivery branches.
3. **Sink:** fetchWithTimeout sends the reminder to webhookUrl or callApi receives it.
4. **Security outcome if exploitable:** A supposedly non-mutating test can send private reminder content and trigger external actions.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

