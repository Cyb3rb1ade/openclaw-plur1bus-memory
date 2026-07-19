# Validation: installer agent-id shell injection

- Candidate: `cand-installer-agent-id-shell-injection`
- Snapshot: `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`
- Source: `scripts/install-memory-system.sh` SHA-256 `eba31b3bc9170c5d9ec119a71a845ebbc51a7d5490053732aceca369276e63c3`
- Verdict: **code defect confirmed; security disposition suppressed**.

## Evidence and bounded reproduction

`run_target()` executes its supplied string with local `bash -c` at lines 216–220. At lines 928–944 the installer reads an agent ID from `openclaw.json` and embeds it inside a subsequent `jq --arg agent '$agent' ...` command string. There is no shell-safe argument transport or `safeAgentId` validation on this path.

`validation_artifacts/installer-repro.mjs` copies only the immutable installer/helper to a disposable source and target, supplies a stub `openclaw`, and invokes the real installer in non-interactive dry-run mode. The input agent ID terminates the shell quote, runs only `printf agent-shell > <isolated marker>`, then comments out the rest of the generated command. `validation_artifacts/repro-work/result.json` records `installerStatus: 0` and `markerAfterInstaller: "agent-shell"`.

## Validation checklist

| Check | Result |
|---|---|
| Source reaches sink | Confirmed: target config → `AGENT_LIST` → interpolated `run_target` command → `bash -c`/SSH shell. |
| Attacker control | Requires modification of the target's trusted `openclaw.json` agent list. |
| Exploitability | Confirmed with a harmless marker in a fully disposable target. |
| Impact | Command execution with the installer principal's privileges. |
| Counterevidence | No supported lower-trust route to write agent IDs was found; the supplied threat model classifies config/destructive controls as authorized operator actions. |

## Disposition

**Suppressed / policy decision: ignore.** This is a robust input-handling bug, but the demonstrated root control is already privileged operator configuration. No cross-principal escalation is evidenced in the audited scope. Preserve installer behavior if remediated: validate IDs once with the documented `safeAgentId` equivalent and pass structured arguments rather than a generated shell command.
