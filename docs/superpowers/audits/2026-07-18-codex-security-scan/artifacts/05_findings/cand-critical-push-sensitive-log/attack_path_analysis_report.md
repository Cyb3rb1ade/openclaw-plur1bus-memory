# Attack-path analysis — Critical-push classification serializes secrets and health data into info logs

Candidate: `cand-critical-push-sensitive-log`

## Path

1. **Source / trust boundary:** Stored memory-card content, including credentials, banking, or health information, enters classifyMemory/buildPushMessage.
2. **Nearest or broken control:** Type classification and daily rate limiting control delivery volume but do not redact the body.
3. **Sink:** buildPushMessage copies card.text/summary verbatim; runClassifier includes message.text in pushMessages; index.js logs JSON.stringify(result) at info level.
4. **Security outcome if exploitable:** Anyone with plugin/service log access can recover highly sensitive memory content; the same body is prepared for outbound chat delivery.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

