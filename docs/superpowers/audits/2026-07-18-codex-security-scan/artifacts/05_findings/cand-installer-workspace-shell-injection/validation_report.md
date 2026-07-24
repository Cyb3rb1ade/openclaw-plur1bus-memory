# Validation: installer workspace shell injection

- Candidate: `cand-installer-workspace-shell-injection`
- Snapshot: `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`
- Source: `scripts/install-memory-system.sh` SHA-256 `eba31b3bc9170c5d9ec119a71a845ebbc51a7d5490053732aceca369276e63c3`
- Verdict: **code defect confirmed; security disposition suppressed**.

## Evidence and bounded reproduction

The workspace is read from target configuration in the command built at line 944 and is later placed in single-quoted command strings at lines 1385, 1533, 1543, 1559, and 1566–1571. `run_target()` reparses these strings using `bash -c` locally or an SSH remote command. No structural argument boundary exists for a quote in a workspace string.

The isolated reproduction uses a normal `main` agent and a workspace whose value closes the single quote, writes only `workspace-shell` to a marker inside the artifact root, and comments the remaining command. The real immutable installer completed in dry-run mode; `validation_artifacts/repro-work/result.json` records `installerStatus: 0` and `markerAfterInstaller: "workspace-shell"`.

## Validation checklist

| Check | Result |
|---|---|
| Source reaches sink | Confirmed: target `agents.list[].workspace` → `WORKSPACE_MAP` → quoted `run_target` string → shell. |
| Attacker control | Requires write access to trusted target configuration. |
| Exploitability | Confirmed by a harmless local marker; no host state outside the artifact tree changed. |
| Impact | Installer-principal command execution. |
| Counterevidence | No remote/chat user-facing workspace setter was demonstrated in this scope. |

## Disposition

**Suppressed / policy decision: ignore.** The required configuration write is an operator-level capability in the provided threat model. A feature-preserving hardening change would avoid string-built shell commands and validate/resolved workspace paths before any use.
