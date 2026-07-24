# Validation: LanceDB maintainer prunes through `_versions` symlink

- Candidate: `cand-lancedb-maintenance-versions-symlink-prune`
- Snapshot: `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`
- Source: `scripts/maintain-lancedb.mjs` SHA-256 `8159b0e27ee1a6d626d65dbde17037ae9786cd8d57a229d1d4c3fd78be759e13`
- Verdict: **code defect confirmed; security disposition suppressed**.

## Evidence and bounded reproduction

The CLI uses `existsSync` on `agent/table/_versions` at lines 124–125, then passes the path to `readdirSync`/`statSync` (43–47), backs files up with `copyFileSync` (50–60), and deletes them with `unlinkSync` (79–83). It checks agent/table directory entries, but never verifies that `_versions` itself is a real directory rather than a symlink.

The isolated CLI reproduction creates a real agent/table layout whose `_versions` entry points at an in-artifact directory containing 51 harmless JSON manifests. It invokes the immutable script with `--apply --keep 50`, with `HOME` redirected to the same artifact directory. `validation_artifacts/repro-work/result.json` records status 0, `oldestWasRemoved: true`, 50 remaining manifests, and an in-artifact backup.

## Validation checklist

| Check | Result |
|---|---|
| Source reaches sink | Confirmed: `_versions` path → manifest scan/backup → `unlinkSync`. |
| Symlink following | Confirmed by deleting the oldest file in the symlink target. |
| Confirmation guard | `--apply` is required and was explicitly used in the isolated reproduction. |
| Impact | Manifest deletion from a location reachable through a service storage symlink. |
| Counterevidence | No lower-trust actor capable of changing the internal LanceDB directory topology is established. |

## Disposition

**Suppressed / policy decision: ignore.** This is a real defensive-programming gap, but the needed storage-tree write is already privileged in the available architecture. Preserve pruning by rejecting symlink `_versions` nodes and canonicalizing under each table root before backup/removal.
