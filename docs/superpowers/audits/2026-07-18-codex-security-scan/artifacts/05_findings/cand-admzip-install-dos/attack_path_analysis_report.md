# Attack-path analysis — Optional local-inference install resolves vulnerable adm-zip parser

Candidate: `cand-admzip-install-dos`

## Path

1. **Source / trust boundary:** A crafted NuGet ZIP supplied from a compromised/malicious package feed, configured HTTPS proxy, or equivalent installation supply-chain position.
2. **Nearest or broken control:** onnxruntime-node@1.24.3 postinstall loads the downloaded .nupkg with adm-zip@0.5.17; vulnerable adm-zip eagerly allocates the attacker-declared uncompressed size before validating actual data/CRC.
3. **Sink:** adm-zip@0.5.17 eager Buffer allocation from declared uncompressed size
4. **Security outcome if exploitable:** Multi-gigabyte allocation can terminate the npm/OpenClaw installation process or exhaust host memory when the optional local inference dependency is installed.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.
+
## Dependency-advisory reassessment

A package/feed/proxy attacker supplies a crafted NuGet ZIP to onnxruntime-node during optional local-transformers installation. adm-zip 0.5.17 allocates from the declared uncompressed size before validation, creating an installation-time availability path. The current lockfile is inside the advisory range; optional installation and supply-chain control bound likelihood but do not negate the affected dependency.

**Policy decision: reportable — high dependency advisory.** Upgrade through a compatibility-tested @huggingface/transformers / onnxruntime-node path and rerun dependency verification. Keep local inference available.

