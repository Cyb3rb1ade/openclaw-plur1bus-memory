# Optional OpenClaw inference dependency patches (#150)

Base: `70f183af` (7.12.60). This changes only the existing scoped overrides,
their lock graph, regression tests and documentation. Transformers remains
4.2.0 and ONNX Runtime remains on its existing version; no major upgrade,
provider/model change or productive install is involved.

## Resolved versions

- `@huggingface/transformers -> sharp`: 0.35.3 to **0.35.4**, with matching
  platform binaries and libvips 1.3.3 packages. The WASM package now requires
  `@emnapi/runtime ^1.11.3`; its lock entry updates to 1.11.3 accordingly.
- `@huggingface/transformers -> onnxruntime-node -> adm-zip`: 0.6.0 to **0.6.1**.
- All changed lock versions belong to those optional dependency paths.

Advisories: [adm-zip](https://github.com/advisories/GHSA-vwc7-r8mq-g2x9),
[sharp/libheif](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c).
The adm-zip advisory page still listed no patched version when checked, so the
candidate was tested against the actual filesystem behavior, not accepted just
because it falls outside the audit range.

## Verification (2026-09-17)

- Baseline 0.6.0 overwrote a disposable victim through a destination-directory
  symlink; candidate 0.6.1 rejected the extraction and preserved that file.
- Four regression cases cover file/directory symlinks through both
  `extractEntryTo` and `extractAllTo`. The normal ONNX Runtime extraction API
  compatibility test still succeeds. Windows skips only a symlink case when
  its runner explicitly denies creation (EPERM/EACCES).
- Native sharp PNG creation, decoding, metadata and resizing succeeded.
  Transformers imports successfully. These are native-library/API checks,
  not a downloaded-model embedding/reranking quality evaluation.
- 33 focused inference/dependency/lifecycle/batching tests passed locally on
  macOS ARM/Node 22. Full-suite and CI results are reported in the PR.
- Clean `npm ci --ignore-scripts` and **full npm audit: zero vulnerabilities**,
  including optional dependencies. Lint, package dry-run and whitespace checks
  pass. No postinstall cron setup or real user profile is touched.
- The existing informational audit CI policy is unchanged; only its obsolete
  comment is corrected. No claim of universal absence of security defects is made.
