# Validation: deployment repair follows destination symlink

- Candidate: `cand-deploy-repair-symlink-write`
- Snapshot: `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`
- Source: `scripts/lib/deploy-integrity.mjs` SHA-256 `038e3f7e5ba777c0f9bd0794f0418b90c5b5d2d65009d9091f2ce03d00b4774f`
- Verdict: **code defect confirmed; security disposition suppressed**.

## Evidence and bounded reproduction

`validateDeployment()` builds a deployed path with `join` (lines 250–268). On mismatch and `repair: true`, it reaches `repairFile()` (lines 233–242), which invokes `copyFileSync(repoPath, deployPath)` without an `lstat`/symlink rejection. The destination is therefore followed by the filesystem copy operation.

`validation_artifacts/repro.mjs` creates a disposable repository file and a deployed path that is a symlink to a separate disposable sentinel. It calls the real immutable `validateDeployment` with repair enabled. `validation_artifacts/repro-work/result.json` records `repaired: true` and `overwriteProven: true`: the outside sentinel changed to the trusted repo contents.

## Validation checklist

| Check | Result |
|---|---|
| Source reaches sink | Confirmed: repair CLI/library → `validateDeployment` → `repairFile` → `copyFileSync`. |
| Symlink following | Confirmed by actual overwrite of a disposable outside sentinel. |
| Prerequisite | Attacker must create/replace an expected path in the deployed extension tree before repair. |
| Impact | Write redirected to the repair runner's reachable filesystem target. |
| Counterevidence | No distinct low-privilege deployment writer or higher-privilege repair invocation is demonstrated in scope. |

## Disposition

**Suppressed / policy decision: ignore.** The filesystem behavior is proven, but only an actor already able to modify the protected deployed extension tree can prepare it in the evidenced topology. A safe hardening change can retain repair by `lstat`-rejecting symlinks (and resolving containment) before copy.
