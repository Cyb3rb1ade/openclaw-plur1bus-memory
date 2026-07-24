# Attack-path analysis — REM command info-logs the full generated dream narrative

Candidate: `cand-rem-dream-sensitive-log`

## Path

1. **Source / trust boundary:** Up to 15 bounded snippets of stored memory text feed the default-enabled REM narrative generator, whose output can retain names, medical details, credentials, or other private content.
2. **Nearest or broken control:** Output is length-capped but not redacted; runRemDream assigns the whole narrative to report.narrative and the internal command serializes the complete report at info level.
3. **Sink:** api.logger.info receives JSON.stringify(result.report), including up to 3,000 narrative characters.
4. **Security outcome if exploitable:** Service/plugin log readers can recover sensitive dream-derived memory content outside normal memory ACL and chat visibility controls.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

