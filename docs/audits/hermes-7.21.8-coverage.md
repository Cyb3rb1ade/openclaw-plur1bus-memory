# PLUR1BUS 7.21.8 for Hermes

The native baseline is `7.20.2-hermes.2`. The source tag `v7.21.8` is pinned to
`b154a28e7f842e9df610cff2ad81f96daefc2ded`. The JavaScript source and native
Hermes implementation have separate execution paths.

| Upstream release or feature | Hermes coverage |
| --- | --- |
| 7.20.3 Semantic Lens discovery | The native Lens index continues to be produced by the Hermes index job from its own graph and scope data. |
| 7.20.4–7.20.6 Chunk recall and graph | Recall can hydrate a ranked fragment from its whole message. The query uses the same namespace, evidence gates, scope, source role and turn identity. The OpenClaw graph fallback and cross-run entity index remain JavaScript paths. |
| 7.20.7–7.20.8 Time in recall | Captured timestamps are labeled and relative dates are explained. Only explicit relative conversation-time queries use capture time as a search hint. Claim validity remains independent. |
| 7.20.9 and 7.21.4 Neo performance | Global Neo vector-cache and append-only JavaScript journal and graph indexes require the OpenClaw Neo worker. Hermes keeps its own bounded additives and maintenance. |
| 7.20.10 Recall cleanup | Automatic recall detects echoes of the current query. Cohere input documents are bounded. Opt-in `embedding.cleanText: {enabled: true, stripSpeaker: true}` cleans supported transport envelopes and keeps raw text and a versioned mode for re-embedding. Hermes does not apply the OpenClaw filler/stage-direction rules. Active-transcript echo suppression and strict global Neo lanes require equivalent host evidence and vector storage. |
| 7.21.0 Engine interfaces | Hermes retains its Python backend, profile controls and native LanceDB generation management. Engine embedding IPC, multi-identity RRF, EmbeddingGemma 2 and the new engine import, unimport and rebind contracts are not implemented by the Hermes backend. |
| 7.21.1–7.21.3 Recall resilience | A bounded automatic query keeps its beginning and end. Automatic recall uses lexical refinement, downweights stale assistant answers, and falls back to scoped keyword and recent results when the encoder fails or stalls. Cohere defaults to `rerank-v5.0-fast`. The OpenClaw turn merge, Neo prelude and startup warm job have no native equivalent in this release. |
| 7.21.2 Confidentiality and chat origin | Native encoding records sensitivity. Sharing checks it before a write as well as before ranking. Native knowledge candidates and dream diary text have a confidentiality gate. Old Hermes rows have no durable same-chat proof, so this release does not derive chat grants, background owner-DM identity or cross-chat weighting from their session IDs. |
| 7.21.5–7.21.6 Origin backfill | The original scripts read OpenClaw session and Neo index data. They must not be run on a Hermes store. No Hermes backfill is run at install time. |
| 7.21.7 Profile temperament | Hermes Desktop edits the selected profile through the native profile-owned settings RPC. The selected preset takes effect after a gateway restart and keeps accumulated mood scores. |
| 7.21.8 Encoding refusals | A scoped, bounded retry state survives separate hourly job processes. Failed rows are deferred for six hours, known failures no longer count towards the three-new-failure breaker, and failed judgments never write estimates. |

Model migrations and embedding dimensions are independent of this upgrade.
The installer keeps the existing model settings and does not re-embed cards.
