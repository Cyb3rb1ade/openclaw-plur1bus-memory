# Attack-path analysis: installer workspace shell injection

## Structured facts

- **Entry / root control:** Write a quote-bearing workspace into target `agents.list[].workspace`.
- **Trust boundary:** Operator-owned `openclaw.json` to installer shell execution.
- **Propagation:** Line 944 reads the workspace; it is retained in `WORKSPACE_MAP` and embedded in commands for directory, SOUL, and AGENTS handling.
- **Sink:** `run_target` → `bash -c` locally or a remote shell through SSH.
- **Execution principal:** Installer account on the target.

## Trace

1. An actor changes the workspace config value.
2. Installer configuration lookup assigns the raw value to `WORKSPACE_MAP`.
3. Later strings such as `mkdir -p '${WORKSPACE_MAP[$agent]}/memory'` are constructed.
4. A quote terminates the intended shell argument; the benign marker proof confirms execution.
5. Any payload would execute as the installer account.

## Dependency and counterevidence analysis

Dynamic evidence proves parsing/execution, but it does not prove a cross-principal root control. The threat-model material describes command authorization and defaults to fail-safe restrictions for sensitive operations. There is no evidence that a normal plugin/chat user writes workspace paths or can cause the installer to run with a more privileged account.

## Severity calibration

| Dimension | Assessment |
|---|---|
| Attacker control | Trusted configuration modification required. |
| Privilege change | Not demonstrated. |
| Trigger | Subsequent operator installer invocation. |
| Impact | Installer-account shell command if topology differs. |
| Evidence gap | Config ownership and automation principal separation. |

## Decision

**Policy decision: ignore; disposition: suppressed.** Retain it for robustness work only. A repair can preserve local and SSH target installation by passing encoded arguments instead of building shell programs and by validating a canonical workspace inside the expected target root where appropriate.
