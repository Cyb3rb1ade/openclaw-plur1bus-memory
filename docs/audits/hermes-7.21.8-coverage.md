# PLUR1BUS 7.21.8-hermes.1 coverage

The native baseline is `7.20.2-hermes.2`. The source tag `v7.21.8` is pinned to
`b154a28e7f842e9df610cff2ad81f96daefc2ded`. The JavaScript source and native
Hermes implementation have separate execution paths.

| Upstream release or feature | Hermes coverage |
| --- | --- |
| 7.20.3 Semantic Lens discovery | The native Lens index continues to be produced by the Hermes index job from its own graph and scope data. |
| 7.20.4–7.20.6 Chunk recall and graph | Recall can hydrate a ranked fragment from its whole message. The query uses the same namespace, evidence gates, scope, source role and turn identity. The native graph builds cross-run entity edges from bounded scoped text projections. The OpenClaw graph-specific fallback scoring retains its JavaScript path. |
| 7.20.7–7.20.8 Time in recall | Captured timestamps are labeled and relative dates are explained. Only explicit relative conversation-time queries use capture time as a search hint. Claim validity remains independent. |
| 7.20.9 and 7.21.4 Neo performance | The native graph index deduplicates scoped edges, tracks journal appends and detects retention rewrites. Global Neo vector-cache and the other JavaScript worker accelerations require the OpenClaw Neo worker. |
| 7.20.10 Recall cleanup | Automatic recall detects echoes of the current query and dates old operational state in the prompt. Cohere input documents are bounded. Opt-in `embedding.cleanText: {enabled: true, mode: "clean-v1", stripSpeaker: true}` uses the portable filler, stage-direction and transport cleanup. Existing Hermes envelope modes retain their behavior. Re-embedding uses each record's stored mode. Active-transcript echo suppression and strict global Neo lanes require equivalent host evidence and vector storage. |
| 7.21.0 EmbeddingGemma 2 | The native ONNX provider verifies pinned Apache-2.0 artifacts and exposes q8, q4 and fp32, with 128, 256, 512 or 768 dimensions. The profile can prepare the model and review a staged dimension/provider conversion. |
| 7.21.0 Multi-identity recall | Each certified namespace uses its own approved embedding identity. Reciprocal Rank Fusion combines rank positions without comparing distances across models. Recall scope, primary writer and shared-pool authorization remain in force. |
| 7.21.0 Engine embedding IPC | The native provider and optional foreground owner use the Engine v1 embedding wire protocol. They authenticate the local peer and bind the request to its model, dimensions and fingerprint. The Engine import, unimport and rebind contracts remain separate from the Hermes storage lifecycle. |
| 7.21.1–7.21.3 Recall resilience | A bounded automatic query keeps its beginning and end. Automatic recall combines proven parts of one turn and speaker, uses lexical refinement, downweights stale assistant answers, and falls back to scoped keyword and recent results when the encoder fails or stalls. Reactivation has its own 250 ms deadline. Cohere defaults to `rerank-v5.0-fast`. The OpenClaw Neo prelude and startup warm job have no native equivalent in this release. |
| 7.21.2 Confidentiality and chat origin | Native encoding records sensitivity. Sharing checks it before a write as well as before ranking. Native knowledge candidates and dream diary text have a confidentiality gate. Old Hermes rows have no durable same-chat proof, so this release does not derive chat grants, background owner-DM identity or cross-chat weighting from their session IDs. |
| 7.21.5–7.21.6 Origin backfill | The original scripts read OpenClaw session and Neo index data. They must not be run on a Hermes store. No Hermes backfill is run at install time. |
| 7.21.7 Profile temperament | Hermes Desktop edits the selected profile through the native profile-owned settings RPC. The selected preset takes effect after a gateway restart and keeps accumulated mood scores. |
| 7.21.8 Encoding refusals | A scoped, bounded retry state survives separate hourly job processes. Failed rows are deferred for six hours, known failures no longer count towards the three-new-failure breaker, and failed judgments never write estimates. |

Model migrations and embedding dimensions are independent of this upgrade.
The installer keeps the existing model settings and does not re-embed cards.
