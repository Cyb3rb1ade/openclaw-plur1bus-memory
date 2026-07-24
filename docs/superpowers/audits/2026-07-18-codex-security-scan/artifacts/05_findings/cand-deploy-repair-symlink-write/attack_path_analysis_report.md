# Attack-path analysis: deployment repair symlink write

## Structured facts

- **Entry / root control:** Attacker creates a symlink at an expected file path in the deployed extension tree.
- **Trust boundary:** Deployed plugin storage → repair process filesystem writes.
- **Propagation:** Repair caller invokes `validateDeployment({ repair: true })`; mismatched deployment path reaches `repairFile`.
- **Sink:** `copyFileSync(repoPath, deployPath)` follows the destination symlink.
- **Execution principal:** The account running repair/doctor.

## Trace

1. An actor gains write access to the installed extension and replaces an expected file with a symlink.
2. A repair run detects drift and invokes `repairFile`.
3. No symlink check occurs before `copyFileSync`.
4. The copy follows the link and overwrites the linked target; the isolated proof confirms this with a sentinel.
5. The eventual write occurs with the repair runner's filesystem permissions.

## Dependency and counterevidence analysis

This is a concrete filesystem primitive, not merely a theoretical TOCTOU. However, the repository provides no evidence that users who can alter the extension directory are less privileged than the repair runner, or that a separately privileged automation runs repair on an attacker-controlled deployment. The documented use is local maintenance after an extension update.

## Severity calibration

| Dimension | Assessment |
|---|---|
| Attacker control | Protected deployment-tree write/symlink creation required. |
| Trigger | A repair invocation with `repair: true`. |
| Privilege change | Not demonstrated in scope. |
| Impact | Arbitrary reachable file overwrite only under a split-principal topology. |
| Evidence gap | Ownership/mode/CI or service-account topology. |

## Decision

**Policy decision: ignore; disposition: suppressed.** Preserve repair functionality if hardening: reject symlinks with `lstat`, resolve/canonicalize the expected file under `deployDir`, and copy atomically to a controlled destination.
