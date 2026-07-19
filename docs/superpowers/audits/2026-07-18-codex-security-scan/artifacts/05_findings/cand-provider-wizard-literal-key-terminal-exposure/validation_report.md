# Validation: provider wizard literal key terminal exposure

- Candidate: `cand-provider-wizard-literal-key-terminal-exposure`
- Snapshot: `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`
- Source: `scripts/provider-wizard.mjs` SHA-256 `7131f9ddbee9748a7ee8b2a9b06de08386b93cbe0575825ec9fb0c86e09775a3`
- Verdict: **behavior confirmed; security disposition suppressed**.

## Evidence and bounded reproduction

The CLI constructs `readline/promises` with `output: stdout` at line 55. In literal mode it uses `askLine("Enter key: ")` at lines 80 and 108, then returns the literal as `apiKey`. At line 144 it serializes the entire chosen configuration to stdout. Thus a literal selected by an operator is visibly entered and emitted in the CLI output.

The pseudo-terminal reproduction uses the dummy value `DEMO_KEY_ONLY_NOT_A_SECRET`, selects OpenAI/literal mode, and selects a disabled reranker. `validation_artifacts/terminal.typescript` contains the dummy at line 12 as echoed terminal input and at line 28 in JSON stdout. It contains no real credential.

## Validation checklist

| Check | Result |
|---|---|
| Behavior | Confirmed in an actual pseudo-terminal. |
| Source reaches sink | Literal prompt → returned provider config → JSON stdout. |
| Attacker control | Operator deliberately chooses literal mode and provides the secret. |
| Impact | Exposure only if another principal observes/records the operator terminal or stdout. |
| Counterevidence | No untrusted observer, log sink, or remote transport is in scope; stdout JSON is the wizard's intended configuration handoff. |

## Disposition

**Suppressed / policy decision: ignore.** This is a useful UX hardening opportunity rather than a demonstrated security boundary break. A compatible improvement could read literal values without echo and direct non-secret JSON only to a protected file/FD while retaining both literal and environment-reference modes.
