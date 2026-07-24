# Attack-path analysis — Reminder-dispatch logs full private reminder text

Candidate: `cand-reminder-sensitive-log`

## Path

1. **Source / trust boundary:** Due reminder text from the agent database.
2. **Nearest or broken control:** Returned details are not redacted or summarized.
3. **Sink:** runReminderDispatch includes text in every dispatched detail and index.js info-logs the entire result.
4. **Security outcome if exploitable:** Service-log readers can recover private reminder content.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

