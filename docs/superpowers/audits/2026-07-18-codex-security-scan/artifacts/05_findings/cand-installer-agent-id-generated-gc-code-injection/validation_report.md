# Validation: generated memory-gc agent-array code injection

- Candidate: `cand-installer-agent-id-generated-gc-code-injection`
- Snapshot: `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`
- Source: `scripts/install-memory-system.sh` SHA-256 `eba31b3bc9170c5d9ec119a71a845ebbc51a7d5490053732aceca369276e63c3`
- Verdict: **code defect confirmed; security disposition suppressed**.

## Evidence and bounded reproduction

At lines 1402–1411 the installer creates JavaScript via an unquoted heredoc. It serializes `AGENT_LIST` with `printf '"%s",'` into `const AGENTS = [...]`; a double quote or JavaScript syntax in an agent ID is not encoded as a JS string literal.

The reproduction config contains an agent ID that closes the generated string and writes only a marker under its artifact root. The real installer completed (`installerStatus: 0`), the generated `memory-gc.mjs` was executed against a tiny in-artifact LanceDB stub, and `validation_artifacts/repro-work/result.json` records `gcStatus: 0` and `markerAfterGc: "gc"`. The generated source is retained in the same result for review.

## Validation checklist

| Check | Result |
|---|---|
| Source reaches generated code | Confirmed: target config agent ID → `AGENT_LIST` → unescaped JS array literal. |
| Sink executes | Confirmed: generated `memory-gc.mjs` ran the benign top-level payload. |
| Persistence | Generated GC is the delayed execution artifact; reproduction uses only disposable files. |
| Impact | Code execution with the later GC runner's privileges. |
| Counterevidence | Agent-ID control is an operator configuration prerequisite; no lower-trust writer was shown. |

## Disposition

**Suppressed / policy decision: ignore.** The code generation defect is real, but no cross-principal path is established. A feature-preserving repair should serialize the agent list with `JSON.stringify`/a Node helper after ID validation, retaining the GC for all valid agents.
