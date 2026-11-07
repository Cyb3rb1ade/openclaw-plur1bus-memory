# Media model licenses

H1 introduces no npm dependency. Runtime dependencies remain exactly as resolved
by the existing package lock. This catalogue records the optional downloaded
model artifacts; they are not bundled with the package.

| Model | Artifact repository and immutable revision | License | Admission |
| --- | --- | --- | --- |
| EmbeddingGemma 2 | [onnx-community/embeddinggemma-2-ONNX](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/tree/daa72c51243991dfcaf9f9137d2c573d8f7790c0), `daa72c51243991dfcaf9f9137d2c573d8f7790c0` | Apache-2.0 ([Google model card](https://huggingface.co/google/embeddinggemma-2)) | Public local fp32 ONNX; no model-specific noncommercial gate |
| Jina CLIP v2 | [jinaai/jina-clip-v2](https://huggingface.co/jinaai/jina-clip-v2/tree/e10d47f5691d0454a0fb5d13f46f2199b74cb436), `e10d47f5691d0454a0fb5d13f46f2199b74cb436` | CC-BY-NC-4.0 ([model card](https://huggingface.co/jinaai/jina-clip-v2)) | Explicit model-specific acceptance; commercial use is not granted by that acknowledgement |
| Jina embeddings v4 | [Jina model card](https://huggingface.co/jinaai/jina-embeddings-v4) | Qwen Research | API only in this catalogue, explicit model-specific acceptance; no local ONNX artifact is advertised |

`lib/providers/media-gemma-artifacts.json` and `media-jina-artifacts.json` pin each
file size and SHA-256. Public upstream verification on 2026-10-20 matched all 18
files. The [receipt](docs/handoffs/2026-10-20-h1-media-artifacts.json) records the
sources and verification method. `lib/providers/media-registry.js` is the
machine-readable capability/license catalogue. [Media documentation](docs/media-embeddings.md)
records runtime limits and host responsibilities.
