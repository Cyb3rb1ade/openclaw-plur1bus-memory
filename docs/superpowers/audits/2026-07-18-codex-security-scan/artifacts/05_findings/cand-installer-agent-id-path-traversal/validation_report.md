# Validation: installer agent-id path traversal

- Candidate: `cand-installer-agent-id-path-traversal`
- Snapshot: `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`
- Source: `scripts/install-memory-system.sh` SHA-256 `eba31b3bc9170c5d9ec119a71a845ebbc51a7d5490053732aceca369276e63c3`
- Verdict: **code defect confirmed; security disposition suppressed**.

## Evidence and bounded reproduction

The installer obtains IDs at lines 928–930, builds a fallback workspace using the raw value at line 947, and creates `$TARGET_DIR/memory/lancedb-namespaced/$agent` at line 1384. These uses do not enforce the documented `safeAgentId` requirement nor use `resolveInside`.

`validation_artifacts/installer-repro.mjs` runs the actual immutable installer in an isolated tree with the agent ID `../escaped-agent`. The completed installer produced `target/memory/escaped-agent`; `validation_artifacts/repro-work/result.json` confirms that this path exists and is outside the intended `target/memory/lancedb-namespaced` root. No production or user data was touched.

## Validation checklist

| Check | Result |
|---|---|
| Source reaches sink | Confirmed: `openclaw.json` agent id → raw path component to `mkdir -p`. |
| Path escape | Confirmed one directory above the intended per-agent store. |
| Exploitability | Completed real installer run, status 0, entirely in a disposable target. |
| Impact | Misplaced files and possible writes within the installer-owned target tree. |
| Counterevidence | The proof does not cross out of the target tree, and no lower-trust agent-ID writer was evidenced. |

## Disposition

**Suppressed / policy decision: ignore.** It is a correctness and hardening issue, not a reportable security escalation under the supplied topology. A future fix can preserve every agent feature by rejecting unsafe IDs and resolving the final directory inside the per-agent base before creating it.
