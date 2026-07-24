# Attack-path analysis: installer agent-id shell injection

## Structured facts

- **Entry / root control:** An actor writes a quote-bearing `agents.list[].id` into the target `openclaw.json`.
- **Trust boundary:** The installer is an operator CLI; the target configuration is an operator-controlled control plane in the available evidence.
- **Propagation:** `jq` emits the ID at lines 928–930; line 944 interpolates it into a string passed to `run_target`.
- **Sink:** `run_target` at lines 216–220 invokes local `bash -c` or remote `ssh` command parsing.
- **Execution principal:** The local/remote account running the installer.

## Trace

1. A principal with target-config write access saves a malicious agent ID.
2. The installer reads it into `AGENT_LIST` without documented ID validation.
3. It builds `jq --arg agent '$agent' ...` as a shell program.
4. The second shell parse executes injected syntax. The bounded proof writes only an artifact marker.
5. The resulting command would hold the installer account's capability set.

## Dependency and counterevidence analysis

The path is technically complete through the execution sink. It is **not** complete across a meaningful trust boundary: the supplied threat model requires authorization for destructive/config-like actions and mandates `safeAgentId` for filesystem IDs, but no chat/API route that lets an untrusted user alter `agents.list` was found. The source itself is a local setup script, not a network listener.

## Severity calibration

| Dimension | Assessment |
|---|---|
| Attacker control | Privileged configuration write required. |
| Privilege change | Unproven; installer and config owner are presumed the same operator. |
| Reachability | Operator must invoke installer after the write. |
| Blast radius | Installer account, if a separate lower-trust config writer exists. |
| Evidence gap | Deployment/config ownership topology outside this repository. |

## Decision

**Policy decision: ignore; disposition: suppressed.** Record as a hardening defect, not a reportable vulnerability unless evidence later establishes that a lower-trust principal can write agent IDs before a higher-privileged installer run. Preserve all installer features by using structured process arguments and valid-ID validation rather than removing remote/local installation support.
