# Media embeddings

The engine exposes `engine.media` independently of its primary LanceDB text index. Text provider, dimension and fingerprint do not change when media is enabled or rebuilt. Each medium has a normal text memory with `kind: "media-caption"` and `mediaRef: mediaId`. The host supplies the caption; without one the engine stores a factual kind/MIME description. Caption generation is a host responsibility.

## Configuration and provider properties

```json
{
  "media": {
    "enabled": true,
    "provider": "local-transformers",
    "model": "google/embeddinggemma-2",
    "modalities": ["image", "video", "audio"],
    "dimensions": 768,
    "precision": "fp32",
    "backfill": "auto",
    "privacyPin": "local",
    "segmentMs": 10000,
    "maxFrames": 32,
    "maxAudioSeconds": 300,
    "maxAttempts": 3,
    "batchSize": 8
  }
}
```

`applyLegacyProviderDefaults` supplies this selection only when both provider selection and existing memory data are absent. Its new text selection is Gemma fp32 `local.variant: "full"`, so the two indices can share one loaded runtime. An existing text store or an explicit text provider retains its original configuration. Explicit media configuration, including `enabled: false`, is preserved. Schema defaults deliberately do not manufacture a media selection before that migration runs.

The common catalogue in `lib/providers/media-registry.js` declares capabilities, model dimensions, licenses, precision and egress. Text/media pairings have no allowlist. OpenAI `text-embedding-3-small` and `-large` remain text-only and use the existing dimensions-aware text adapter. Jina is also independently selectable for text (`embedding.provider: "jina"`, `model`, `dimensions`, `licenseAccepted: true`, optional `transport: "local"` for CLIP).

| Provider/model | Text | Image/video | Audio | Runtime | License |
|---|---|---|---|---|---|
| local-transformers / Gemma 2 | yes | yes | yes | pinned fp32 ONNX; optional HTTP sidecar | Apache-2.0 |
| local-transformers / existing E5, Jina v3, Jina v5 text models | yes | no | no | existing text path | per-model catalogue |
| OpenAI / compatible embedding endpoints | yes | no | no | existing OpenAI API | service terms |
| Jina embeddings v4 | yes | yes, frames | no | Jina API | Qwen Research, explicit model acceptance |
| Jina CLIP v2 | yes | yes, frames | no | pinned local fp32 ONNX (`transport: "local"`) or Jina API | CC-BY-NC-4.0, explicit model acceptance |

`licenseAccepted: true` acknowledges the selected Jina model. A model change requires reviewing that model's license. The wizard and installer display the license and ask before selecting either Jina model. The registry rejects unsupported modalities, unpinned local revisions, unavailable runtimes and dimensions before model loading or source processing.

A local privacy pin blocks cloud inference before a request. Local ONNX model preparation can download verified public weights: its declared egress is Hugging Face and its CDN/Xet artifact hosts. Jina cloud inference sends inputs to `api.jina.ai`; existing OpenAI text inference uses `api.openai.com`. OpenAI-compatible text endpoints declare their configured host rather than a fixed egress hostname. Offline deployment requires preparing the exact pinned artifacts in the configured cache. No token or model credential is saved in the media database.

## ONNX compatibility and footprints

The repository's Transformers.js 4.2.0 implements `EmbeddingGemma2Model`, `EmbeddingGemma2Processor`, modular vision/audio sessions and `JinaCLIPModel`/`JinaCLIPProcessor`. Gemma uses `AutoConfig`, `AutoProcessor`, `AutoModel` on CPU; removed encoder configurations prevent unused graph loading. Video uses already-decoded `RawVideo` frames with the model's video processor, rather than browser video decoding. Jina CLIP uses its tokenizer and image processor and the built-in model class; no Hugging Face remote Python code executes.

Gemma pins ONNX revision `daa72c51243991dfcaf9f9137d2c573d8f7790c0` and a SHA-256 for every selected file in `media-gemma-artifacts.json`. CLIP pins `e10d47f5691d0454a0fb5d13f46f2199b74cb436` in `media-jina-artifacts.json`. The existing artifact verifier downloads, hashes and rechecks these files before `local_files_only` loading. No fp16 graph is selected. The available verified ONNX precision is fp32; bf16 is not advertised without a corresponding verified export.

Gemma variants derive from requested modalities: no media → text; image/video → vision; audio → audio; both families → full. All share the text tower. Fingerprints conservatively distinguish variants until real-model identity has been established. Shared leases coalesce matching model/revision/precision/effective-variant/cache identities, independent of index dimension. The new default uses the same full identity in both indices; explicitly different variants use separate runtimes. Disposal waits for active inference and the last lease.

Approximate decimal disk bytes below are sums of pinned file sizes. Weight-only fp32 RAM estimates are `parameters × 4`, **not measured peak RSS**; native session buffers, activations and tokenizer memory are additional.

| Gemma variant | Model-card parameters | Verified disk | Weight-only RAM estimate |
|---|---:|---:|---:|
| text | 270M | 1.117 GB | 1.080 GB |
| vision | 440M | 1.788 GB | 1.760 GB |
| audio | 570M | 2.290 GB | 2.280 GB |
| full | 740M | 2.961 GB | 2.960 GB |

CLIP v2 has 865M parameters and approximately 3.46 GB of pinned fp32 graph/data before tokenizer/config overhead. Jina v4 has 3.8B parameters; its API path does not load those weights into this process.

Compatibility evidence here is source/export inspection and offline adapter tests. A full Gemma download was attempted locally but stopped before completion (roughly 370 MB downloaded in five minutes). **No real Gemma image/audio inference, Jina local inference or cloud/sidecar request was validated in this change.** Those results must not be inferred from the fake runtime tests.

For a compatible local embedding service, set `media.transport: "sidecar"` and `endpoint`. Endpoint admission defaults to loopback HTTP(S); remote hosts additionally require `allowRemoteSidecar: true` and a permitting privacy pin. Requests do not follow redirects. The service must accept the documented embeddings payload used by `HttpMediaEmbeddingProvider`: `model`, `input`, `dimensions`, `task`, `variant`, `precision`, `revision`, and return `data[0].embedding` or `embeddings[0]`. A native Ollama/LiteRT service with a different protocol needs a host-side adapter. There is no automatic failover that could silently send local media to a cloud.

Sources: [Gemma ONNX model card](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX), [Google multimodal guide](https://ai.google.dev/gemma/docs/embeddinggemma/multimodal-embeddinggemma-with-sentence-transformers), [Jina CLIP card and ONNX example](https://huggingface.co/jinaai/jina-clip-v2), [Jina v4 model](https://jina.ai/models/jina-embeddings-v4/).

## Store, scope and API

`<baseDbPath>/media/index.sqlite` contains separate `media_item`, `media_segment` and `media_meta` collections. The private directory/database use 0700/0600. WAL transactions replace a medium's segments atomically. Bytes are copied into the media collection so a backfill does not depend on a host path still existing. The default source limit is 32 MiB; paths must resolve inside `host.capabilities.mediaSourceRoot` (default host state directory). The store saves no credentials. Search currently computes cosine scores over visible stored segments; it is a flat scan, suitable for bounded media collections rather than a large ANN corpus.

`scope` is a **trusted host-derived principal/ownership tuple**, not user-supplied authorization. It contains `agentId` and optional `scope: "agent-private" | "workspace" | "user"`, canonical workspace binding or stable owning user principal. The engine supplies its live workspace-alias snapshot. Visibility uses the existing `checkAccess` middleware. Search filters before scoring and before caption fusion. Media IDs are global within an engine; an index overwrite cannot change ownership. Hosts must authorize `remove` and `setCaption` as owner mutations before invoking the API, as those contract methods do not carry a principal argument.

```js
await engine.media.index({
  mediaId: "photo-1", kind: "image", mime: "image/jpeg",
  source: { bytes }, // alternatively { path } under the host source root
  caption: "The greenhouse in September", captionSource: "user",
  scope: { agentId: "garden", scope: "agent-private" }
}); // { segments, state }
await engine.media.search({ text: "greenhouse", scope: { agentId: "garden" } });
await engine.media.search({ likeMediaId: "photo-1", scope: { agentId: "garden" } });
await engine.media.setCaption("photo-1", "Greenhouse after the repairs", "user");
await engine.media.remove("photo-1");
engine.media.status();
```

Search requires exactly one of `text`/`likeMediaId`, accepts `kinds`, `limit`, `minScore` and returns `{mediaId, kind, score, segment?, captionMemoryId?}`. A text query goes to the **media model's text tower**. Matryoshka truncation is followed by L2 normalization; dimension drift is refused. `likeMediaId` uses its first stored segment. Optional `fuseCaptions: true` uses reciprocal rank fusion (`k=60`) with caption hits from the primary text encoder; pending media can therefore participate via captions. No vectors from different spaces are compared.

`setCaption` writes a new text row before deleting the old caption. `remove` deletes its caption and segments and writes a destructive-operation audit. All media calls refuse after engine close, which drains foreground work, the worker and shared runtimes before closing the text stores.

## Host decoder ports

Inject `host.capabilities.mediaPorts`:

- `frameExtractor.extract({bytes,mime,intervalMs,sceneChanges})` returns timestamped encoded/RGB frames. Interval and scene boundaries produce segments. Sampling enforces the model/config frame cap. Timestamps must be finite, nonnegative and ordered.
- `audioDecoder.decode({bytes,mime,sampleRate,channels,maxSeconds,segmentMs})` returns `{pcm: Float32Array,startMs?,sampleRate?}` chunks at mono 16 kHz. The engine clips the total sample budget, splits intervals and optionally uses 20 ms energy-VAD windows to separate speech/silence.

The engine never invokes ffmpeg. Images are decoded with the model runtime and downscaled before processing. Missing video/audio ports persist `unsupported-kind`, with the caption still in the normal recall path.

## Fingerprint and durable backfill

The media namespace reuses the text re-embedding fingerprint codec, with provider/model/revision/variant/dimension/precision/endpoint plus a segmentation digest. Its transactional segment writer also uses the existing coordinator's metadata/vector readback verifier. The media-specific batch worker handles binary sources and decoder ports; it does not reuse the text coordinator's confirmation/switch RPC, and does not switch the text generation.

A media fingerprint change invalidates only media segments and resets pending items. Captions remain searchable. `backfill: "auto"` resumes persisted running work and starts pending/model-change work on construction. `media.backfill.start({reason: "enable" | "model-change" | "manual"})`, `pause()`, `resume()` and `cancel()` manage a persisted worker cursor/status. Manual start reindexes the collection; cancellation leaves captions and pending items intact. Completed/failed items persist across restarts. Each batch yields to the event loop and each item writes durable status before progress is counted.

Inject `host.capabilities.mediaBudget(): boolean | Promise<boolean>`. False pauses with `pausedReason: "budget"`; resume consults the hook again. Per-item failures are counted and retried up to `maxAttempts`, then skipped so other items finish. A stopped process may redo its last uncommitted item, never an unbounded failed-item loop. Decoding/loading an item already in flight finishes before pause/cancel/close settles.

Status returns `enabled`, provider/model/variant/dim/fingerprint, `counts: {indexed,pending,failed,unsupported}`, and `backfill: {state,done,total,startedAt?,pausedReason?}`.

## Error codes and verification

| Code | Meaning |
|---|---|
| `E_MEDIA_CAPABILITY` | provider/model lacks a requested encoder |
| `E_MEDIA_LICENSE` | model-specific license acceptance missing |
| `E_MEDIA_PRIVACY` | cloud or sidecar endpoint violates the privacy policy |
| `E_MEDIA_UNAVAILABLE` | unknown/unavailable model, precision, revision, transport or closed runtime |
| `E_MEDIA_DIMENSION` | invalid vector or query/document dimension mismatch |
| `E_MEDIA_SOURCE` | invalid ID, source, limits, MIME or decoder data |
| `E_MEDIA_SCOPE` | invalid ownership or attempted ownership replacement |

Offline tests cover the provider matrix, separate dimensions, runtime sharing for actual adapter classes, native LanceDB captions and normal Engine recall, scopes, HTTP policy, segmentation, VAD, fingerprint changes and bounded/resumable backfill. Their default fetch implementation rejects network access.

```bash
npm run lint
npm run typecheck
npm test
# Optional real download/inference, skipped in the normal suite:
PLUR1BUS_MEDIA_REAL_MODELS=1 \
PLUR1BUS_MEDIA_MODEL_CACHE=/path/to/prepared/cache \
node --test tests/media-real-model.test.js
```

The opt-in test compares full/text embeddings and reports maximum absolute error while fingerprints remain variant-specific. Set `PLUR1BUS_MEDIA_REQUIRE_IDENTICAL=1` to require agreement below 1e-4. It also checks that a generated green image ranks its description above a distractor. No license-gated Jina weights are downloaded by the default suite.
