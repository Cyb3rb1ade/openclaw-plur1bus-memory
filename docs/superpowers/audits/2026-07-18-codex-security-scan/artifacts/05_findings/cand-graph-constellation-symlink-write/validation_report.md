# Validation — Graph report follows a vault symlink

Candidate: `cand-graph-constellation-symlink-write`  
Instance: `vault-symlink-write:lib/memory-graph.js:594`

## Rubric

- [x] A workspace graph directory can be a symlink.
- [x] The original writer creates year/month parents and a report through it.
- [x] The canonical created report is outside the workspace.
- [x] The capture hook calls this writer.
- [ ] Production workspace ownership and service privileges are deployment-dependent.

## Evidence and method

`validation_artifacts/proof.mjs` creates `workspace/memory/graph -> outside`, invokes the original exported writer, and resolves the generated report to `outside/2026/07/constellation-YYYY-MM-DD.md`. The target source tree is not edited.

Disposition: **reportable**, confidence 0.90. Retain reports by rejecting symlinked parents and verifying canonical containment before write.
