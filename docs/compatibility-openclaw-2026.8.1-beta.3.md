# OpenClaw 2026.8.1-beta.3 compatibility contract

PLUR1BUS 7.4.9 targets the immutable OpenClaw package
`openclaw@2026.8.1-beta.3`, Git tag `v2026.8.1-beta.3`, commit
`5831b80721f802072b0ec1893b30a16cf42d538c`, and npm integrity
`sha512-8v+2Knr+0i1qzWXgJmtcBg78VaoMENahLxcuThOqyCmVaCGPj++mI9yv0R440wMv9Siv4fysd5e0YmBVftDvuQ==`.

## Native host integration

PLUR1BUS uses only public OpenClaw capabilities:

- `registerGatewayMethod` registers the PLUR1BUS Gateway method.
- `registerCli` registers the PLUR1BUS CLI.
- `openclaw/plugin-sdk/gateway-runtime` submits exact, allowlisted feature
  commands through the native cron/dispatcher path.
- typed lifecycle hooks register capture, recall, startup, and shutdown work.

These capabilities are detected from the runtime objects and exports before
use. Missing capabilities produce a fail-closed diagnostic. There is no
version-string branch and no OpenClaw runtime files are patched. PLUR1BUS does
not modify `node_modules`, generated OpenClaw bundles, or OpenClaw source files.

Feature cron planning is non-mutating. Only the exact shipped PLUR1BUS command
payloads are eligible. Native `commandArgv` execution is bounded, validates the
reply payload, preserves `NO_REPLY`, and lets OpenClaw own final status and
announce delivery. A command failure remains visible and cannot enable an
unsafe fallback carrier-model run.

## Immutable local model artifacts

The local provider downloads only the following pinned Hugging Face revisions.
Every required file has an expected byte size and SHA-256 in
`lib/providers/local-model-artifacts.js`; a file becomes visible at its final
path only after a unique temporary download has been fully flushed and
verified.

| Role | Repository | Revision | Required ONNX artifact |
| --- | --- | --- | --- |
| E5 embedding | `intfloat/multilingual-e5-small` | `614241f622f53c4eeff9890bdc4f31cfecc418b3` | `onnx/model.onnx` |
| Jina primary reranker | `jinaai/jina-reranker-v2-base-multilingual` | `9cfeff2df7d40d1b78e75e5e9cebec92a99813c9` | `onnx/model_quantized.onnx` |
| Free BGE fallback reranker | `woxpas-ai/bge-reranker-v2-m3-onnx` | `c44ebc43de724ae8816668bb44d2e728e17faa18` | `onnx/model_quantized.onnx` |

Jina's published null `model_type` is accepted only for this validated model
profile and normalized to its XLM-RoBERTa architecture. The original BGE model
repository is rejected because it does not publish the ONNX artifact expected
by Transformers.js; the pinned ONNX export above is used instead. If Jina
inference fails and the configured free fallback is BGE, the request is tried
exactly once with BGE. Missing, partial, incorrectly sized, or incorrectly
hashed artifacts fail with a specific diagnostic and are never loaded.

## Data and upgrade compatibility

The 7.4.8 to 7.4.9 upgrade is non-destructive. It introduces no breaking
LanceDB schema change and does not rewrite an existing database merely because
the plugin version changed. Existing per-agent paths, namespace routing,
memory IDs, embeddings, tombstones, history, and Obsidian mirrors remain in
place. Normal idempotent schema initialization continues to supply defaults
for older tables, and all filesystem paths remain subject to agent-id and
containment validation.

Operators should still take a snapshot before any unrelated destructive
maintenance or explicit migration. Rollback consists of stopping the gateway,
installing the previously retained plugin package, and starting it again; no
OpenClaw rollback copy is required because 7.4.9 performs no host patch.

## Scope of the compatibility claim

The exact target above is the release gate. Newer OpenClaw commits are reviewed
for adjacent dispatcher, delivery, restart, and hook behavior but are not
silently incorporated. Compatibility is established only by testing the
packed 7.4.9 artifact in a fresh OpenClaw 2026.8.1-beta.3 runtime, including
runtime registration, gateway readiness, explicit and automatic memory paths,
restart persistence, agent isolation, cron delivery, and real local-model
inference.
