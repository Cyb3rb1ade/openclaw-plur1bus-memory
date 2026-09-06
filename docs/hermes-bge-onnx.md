# Native BGE ONNX reranker for Hermes

`local-onnx` reranking is an explicit opt-in for the quantized
`onnx-community/bge-reranker-v2-m3-ONNX` artifact. It implements CPU ONNX
scoring for the upstream `BAAI/bge-reranker-v2-m3` architecture; it is not a
claim of quality equivalence to the original Torch distribution.

The configuration must pin all of the following:

```json
{
  "provider": "local-onnx",
  "model": "BAAI/bge-reranker-v2-m3",
  "revision": "6f5ff65298512715a1e669753bc754d2bc8f367b",
  "modelDir": "C:/Hermes/models/bge-reranker-v2-m3-onnx",
  "localFilesOnly": true,
  "maxTokens": 512,
  "batchSize": 8
}
```

No recall path downloads a model or enables remote code. Preparation is a
separate, reviewed operation: it downloads only the revision above into a
private staging directory, checks the byte count and SHA-256 of every required
artifact, and atomically publishes a new directory. Existing directories and
symlinks are never replaced or followed. The activation smoke test then opens
only that verified directory.

Runtime requirements are `onnxruntime`, `tokenizers`, and `numpy`; explicit HTTPS
preparation additionally uses `certifi` roots while retaining system TLS trust.
The `local-onnx` extra supplies these prerequisites. Reranking is bounded to
eight query/document pairs of 512 tokens per inference. A load, tokenization,
or inference failure is logged and leaves original recall rows in place.

In Hermes Desktop, open **Provider & Dimensionen**, select **Reranking** and
`local-onnx`, then choose the intended model directory under an existing parent.
Review and confirm **BGE-Modell vorbereiten** first (approximately 590 MB download).
Stop affected memory runtimes as instructed; the preparation checks the real
exclusive runtime lease, not just a checkbox. It probes inference but leaves
the profile's active configuration unchanged. Afterwards review and confirm
**Reranking speichern**, then restart the memory runtime. No embedding migration
is required for a reranker change. Named profiles retain their own bound routes.

The pinned Q8 model passed real CPU inference in the Parallels Windows ARM64
test guest with Python 3.13.15 and ONNX Runtime 1.29.0, without torch installed.
All four ONNX Runtime/tokenizers native binaries checked as ARM64. A relevant
Hermes memory text ranked above an unrelated recipe; this smoke test is not a
general relevance-quality benchmark or a complete application release gate.
