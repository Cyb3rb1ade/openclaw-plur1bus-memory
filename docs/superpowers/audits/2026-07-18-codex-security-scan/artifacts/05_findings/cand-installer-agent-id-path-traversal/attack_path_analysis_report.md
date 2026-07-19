# Attack-path analysis: installer agent-id path traversal

## Structured facts

- **Entry / root control:** Write `../escaped-agent` or similar into target agent configuration.
- **Trust boundary:** Trusted operator config to an installer-owned filesystem tree.
- **Propagation:** Raw ID from lines 928–930 enters both workspace fallback and line 1384's per-agent directory suffix.
- **Sink:** `mkdir -p '$TARGET_DIR/memory/lancedb-namespaced/$agent'`.
- **Execution principal:** Installer account.

## Trace

1. An actor controls a target-config agent ID.
2. The installer does not apply the documented `safeAgentId`/`resolveInside` controls.
3. Shell path normalization evaluates `../` during `mkdir -p`.
4. The actual bounded run creates `target/memory/escaped-agent` outside the intended per-agent base.
5. Subsequent installer-owned writes may use the misplaced area.

## Dependency and counterevidence analysis

The physical escape is confirmed, yet the proof stays under the installer target (`target/memory`) rather than reaching arbitrary host paths. More importantly, configuration control is already an operator capability. No user-facing path to choose arbitrary agent IDs was established.

## Severity calibration

| Dimension | Assessment |
|---|---|
| Attacker control | Target config write required. |
| Containment escape | One level outside per-agent base, still inside target in the verified input. |
| Privilege change | Not established. |
| Trigger | Installer run. |
| Evidence gap | Any lower-trust agent-ID provisioning mechanism. |

## Decision

**Policy decision: ignore; disposition: suppressed.** Treat this as an implementation hardening item. A compatible fix validates IDs and checks canonical output containment; it does not remove per-agent memory directories.
