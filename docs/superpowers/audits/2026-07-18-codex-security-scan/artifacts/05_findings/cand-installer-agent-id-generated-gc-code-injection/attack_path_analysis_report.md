# Attack-path analysis: generated memory-gc code injection

## Structured facts

- **Entry / root control:** Write a JavaScript-breaking agent ID into target configuration before installation.
- **Trust boundary:** Operator configuration → generated maintenance script.
- **Propagation:** `AGENT_LIST` is serialized with shell `printf` into the `const AGENTS` source text at line 1410.
- **Sink:** The generated `memory-gc.mjs` is subsequently run by Node; top-level code executes as its runner.
- **Execution principal:** The GC runner, potentially later than installation.

## Trace

1. A privileged config editor saves a quote-bearing ID.
2. Installer does no ID or JavaScript-string encoding.
3. It writes an executable GC script containing attacker-controlled source.
4. The scheduled/manual GC invocation loads the injected top-level source; the bounded proof writes only an artifact marker.
5. The payload would receive the GC runner's authority.

## Dependency and counterevidence analysis

The delayed code-generation path is complete and dynamic. The unresolved prerequisite is critical: no in-scope low-trust actor can be shown to write `agents.list`, and the generated script resides under the same operator-controlled target. The threat model explicitly calls for ID validation but does not provide a contrary config trust model.

## Severity calibration

| Dimension | Assessment |
|---|---|
| Attacker control | Trusted agent-config write required. |
| Delayed trigger | Requires GC execution after installer run. |
| Privilege change | Unproven; GC service ownership is not shown to exceed config writer. |
| Impact | Code execution as GC runner if a split-principal topology exists. |
| Evidence gap | Scheduler/service ownership and low-trust config writer. |

## Decision

**Policy decision: ignore; disposition: suppressed.** Keep as a quality/security hardening record. A safe repair serializes validated IDs as JSON and preserves the memory GC feature and all agent coverage.
