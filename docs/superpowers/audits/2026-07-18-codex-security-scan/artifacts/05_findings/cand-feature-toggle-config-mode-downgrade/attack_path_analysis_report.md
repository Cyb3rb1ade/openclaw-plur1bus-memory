# Attack-path analysis — Feature toggles replace a private OpenClaw config with a default-permission file

Candidate: `cand-feature-toggle-config-mode-downgrade`

## Path

1. **Source / trust boundary:** An authorized /enable or /disable command reads the full operator OpenClaw JSON, which may contain literal provider API keys and other secrets.
2. **Nearest or broken control:** The update is authorized, key-whitelisted, and atomically renamed, but atomicWriteJson neither stats/preserves the original mode nor explicitly creates the temporary file as 0600 and cleans it on failure.
3. **Sink:** writeFileSync creates path.tmp-PID-time with Node's default 0666 masked by umask, then renameSync makes that file the new openclaw.json.
4. **Security outcome if exploitable:** A successful toggle can change a 0600 secrets-bearing config to 0644; a crash or failed rename can leave a similarly permissive full-config temp copy, exposing credentials to other local principals when directory permissions permit traversal.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

