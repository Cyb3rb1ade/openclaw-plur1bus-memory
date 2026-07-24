# Attack-path analysis: verifier executes unverified deployed module

## Structured facts

- **Entry / root control:** Attacker replaces one of the expected deployed module files.
- **Trust boundary:** Deployed extension tree → verifier dynamic import.
- **Propagation:** The verifier receives `report.ok === false` but still constructs `resolve(deployDir, file)` smoke expectations.
- **Sink:** `await import(`${filePath}?smokeTest=...`)` in `smokeTestExports` runs deployed top-level module code.
- **Execution principal:** Account that invokes the integrity verifier/repair workflow.

## Trace

1. A deployment-tree writer changes an expected module.
2. Verification computes the checksum mismatch and prints `FAIL`.
3. Instead of returning/gating, verifier calls the real-import smoke helper.
4. Dynamic import executes the changed module before final failure calculation.
5. The isolated proof confirms a checksum mismatch and benign marker execution in the same run.

## Dependency and counterevidence analysis

This is a complete technical path to code execution, but no privilege escalation is demonstrated. The verifier description says it is run after repo-to-extension sync or before gateway restart; the repository does not show a lesser-privileged actor capable of modifying the extension nor a stronger verifier/CI identity. The same account could ordinarily load the plugin on gateway restart, which limits incremental impact under a same-owner model.

## Severity calibration

| Dimension | Assessment |
|---|---|
| Attacker control | Deployment module write required. |
| Trigger | Check-only verifier invocation. |
| Privilege change | Unproven; topology may be same-owner. |
| Impact | Pre-failure code execution by verifier if roles differ. |
| Evidence gap | File ownership and verifier/CI/service-account relationship. |

## Decision

**Policy decision: ignore; disposition: suppressed.** Preserve the real-import smoke check: gate it after successful checksum validation or a successful repair/revalidation. Do not remove deployment verification or smoke coverage.
