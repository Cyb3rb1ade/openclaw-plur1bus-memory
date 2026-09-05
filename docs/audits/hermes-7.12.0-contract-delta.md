# Hermes 7.12.0 candidate — upstream delta

Upstream `v7.12.0` is merged, including `v7.11.0` and the `v7.11.1`
512-token memory fix. The existing 7.10 contract matrix and its partial/native
host boundaries remain applicable. This document is not a publication claim.

| Contract | Native Hermes implementation | Boundary |
| --- | --- | --- |
| Jina v5 Text Nano Q8 | Explicit `local-onnx` backend, immutable revision and five artifact size/SHA pins | No automatic model download during capture/recall |
| Model license | `licenseAccepted: true` required before preparation, import/load and cache use | Operator acknowledges CC-BY-NC-4.0; never implicit |
| Input/output | `Query: ` / `Document: `; tokenizer truncation at 512; sequential bounded inference; sentence output or masked last token; normalized 32/64/128/256/512/768 projection | Native CPU ONNX, not the OpenClaw JS runtime |
| New-install selection | Read-only operator plan selects Nano only with explicit acceptance, otherwise E5 | Hermes chat/retrieval provider settings are not overwritten; upstream browser wizard is not replicated |
| Existing databases | Existing embedding configuration unchanged; explicit source-bound staging, validation, approved activation | No reuse of v3/Small vectors as Nano; first private generation only; old generation retained |
| UI recommendation | Operator CLI exposes model preparation and migration prerequisites | Upstream dashboard recommendation/banner not reproduced in Hermes |
| Runtime acceptance | Mocked regressions exercise contracts without downloading weights | Real local capture/recall and quality/performance checks required before release readiness |

## Integration hardening

- Local BGE uses the actual Sentence Transformers 3.x `cache_dir` constructor,
  a 512-token limit, `trust_remote_code=False`, and optional explicit `revision`
  and `localFilesOnly`. Model cache identity includes those settings.
- Primary authorized recall is retained when additive boosters cannot find a
  uniform scope in mixed legacy/current rows; the request binding is explicit.
- Repeated forget verifies the immutable pre-delete archive, with full
  non-deletion-field and scope comparison. Missing/tampered archives fail closed.
- Retry and dead-letter queues are partitioned by agent and ACL scope. Replay
  requires persisted `agentId`, `scopeKey` and `aclBinding` to match exactly.
  Cooperating queue mutations use a process lock. Foreign entries and malformed
  lines are retained, never replayed as this runtime's work.
- The old `state/capture-retry.jsonl` has no trustworthy owner binding. It is
  left byte-for-byte intact and warned about, not automatically imported into
  whichever profile happens to capture first. Operators must attribute old
  entries explicitly; upgrading does not promise automatic legacy replay.
- Status and physical optimize accept only the exact generation route certified
  by the namespace resolver, including activated staged generations. Merely
  pointing at an old or foreign table is rejected.

The original 7.10 audit files are historical snapshots, not current installation
or test results. Release acceptance evidence is reported separately for the
exact release artifact; partial host/workshop parity remains explicit.

## Native preparation

Install the optional `plur1bus-hermes[local-onnx]` dependencies in the selected
Hermes environment. Do not change model configuration just to repair a schema.
Use an explicit absolute model destination whose parent already exists.

```sh
plur1bus-hermes-operator --hermes-home /absolute/hermes-home --agent default \
  embedding-model plan --model-dir /absolute/models/jina-v5-nano
```

This is read-only. After reviewing the model license, an operator may explicitly
prepare the exact pinned artifacts:

```sh
plur1bus-hermes-operator --hermes-home /absolute/hermes-home --agent default \
  embedding-model prepare --model-dir /absolute/models/jina-v5-nano \
  --accept-noncommercial-license --apply
```

`embedding-model verify` with the same license flag verifies existing files
without a network request. A nonempty/mismatched existing destination is never
overwritten. Preparation does not modify plugin configuration or memory data.
The returned `targetEmbedding` object can be saved as JSON for the existing
`reembed --target-embedding` workflow: plan, staged apply, validate, and explicitly
approved activation with all cooperating writers stopped. Take a backup first.
Do not skip the existing generation/namespace guards.

For new installs without license acceptance, the native fallback remains E5.
That is selection before database creation, **not** runtime fallback: Nano
rejects fallback embeddings even when their dimensions happen to match.

Upstream's lab speed, memory, and retrieval scores are not Hermes measurements.
No upstream PR is warranted solely by different host APIs; report only reproduced
upstream defects.
