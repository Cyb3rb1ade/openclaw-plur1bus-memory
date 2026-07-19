# Validation: verifier imports known-untrusted deployed module

- Candidate: `cand-deploy-verifier-executes-unverified-module`
- Snapshot: `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`
- Sources: `scripts/verify-plugin-deploy.mjs` SHA-256 `7e279c50907d9ad4f918791c0be73e120cd1a98f9409cccaf1559aebaa4ccf92`; `scripts/lib/deploy-integrity.mjs` SHA-256 `038e3f7e5ba777c0f9bd0794f0418b90c5b5d2d65009d9091f2ce03d00b4774f`
- Verdict: **code defect confirmed; security disposition suppressed**.

## Evidence and bounded reproduction

The verifier validates deployed files at lines 56–62, prints any failures at 64–72, then unconditionally builds deployed import paths and invokes `smokeTestExports` at lines 74–78. Only afterward does it combine `report.ok && smoke.ok` at line 92. `smokeTestExports` performs real dynamic import at `deploy-integrity.mjs:279–285`, so a known checksum mismatch does not gate top-level module execution.

`validation_artifacts/repro.mjs` creates a trusted repo module and a different deployed module whose top-level code writes a benign marker. It first calls the real `validateDeployment`, which reports a checksum mismatch, then calls the real smoke helper. `validation_artifacts/repro-work/result.json` records `knownChecksumFailure: true`, `topLevelExecuted: true`, and `smokeOk: true`.

## Validation checklist

| Check | Result |
|---|---|
| Validation before import | Confirmed: checksum mismatch is known before the smoke call. |
| Import execution sink | Confirmed: real helper imported the deployed module and ran its benign top-level code. |
| Prerequisite | Attacker must modify an expected deployed module before a verifier run. |
| Impact | Code runs with the verifier's privileges, potentially before it reports failure. |
| Counterevidence | No weaker deployment writer or stronger verifier/CI principal is evidenced in the supplied repository topology. |

## Disposition

**Suppressed / policy decision: ignore.** Preserve the valuable real-import smoke feature if changed: run it only when validation succeeds (or after a successful repair/revalidation), rather than disabling it. The current record is suppressed because cross-principal privilege gain is unproven.
