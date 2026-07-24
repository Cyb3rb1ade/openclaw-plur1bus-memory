# Attack-path analysis: provider wizard literal key terminal exposure

## Structured facts

- **Entry / root control:** Operator selects literal-key mode and types a credential into a local terminal.
- **Trust boundary:** Operator terminal input → terminal display/transcript and intended JSON configuration output.
- **Propagation:** `readline` is configured with `stdout`; literal response becomes `embedding.apiKey` or `reranker.apiKey`.
- **Sink:** Terminal echo plus `process.stdout.write(JSON.stringify(...))`.
- **Execution principal:** Local setup operator; no code-execution sink exists.

## Trace

1. A user intentionally selects option 2 (literal) for a provider.
2. `askLine` receives the visible text.
3. The result is retained as `apiKey`.
4. Wizard emits the configuration JSON, including the literal, to stdout.
5. A different principal could learn it only by observing/recording that terminal or stdout stream.

## Dependency and counterevidence analysis

The pseudo-terminal transcript verifies exposure mechanics using a dummy marker only. It does not demonstrate a separate attacker, a log collector, or a transport from the local terminal to an untrusted party. JSON stdout is a deliberate program interface, so treating it as an automatically reportable leak would overstate the evidence.

## Severity calibration

| Dimension | Assessment |
|---|---|
| Attacker control | Operator voluntarily chooses literal entry. |
| Trigger | Normal local wizard use. |
| Cross-principal exposure | Unproven. |
| Impact | Credential disclosure only if terminal/stdout access is shared or logged. |
| Evidence gap | Concrete observer/logging topology. |

## Decision

**Policy decision: ignore; disposition: suppressed.** This warrants ergonomic secret-handling improvement, not a security finding in the supplied scope. Preserve literal and env-ref options; use a non-echoing prompt and a protected handoff channel where feasible.
