# Compare recall candidate selection

The operator-only benchmark reads existing agent tables and uses the configured OpenAI embedding model, Cohere reranker and Jev API. It does not enable Jev in live recall. It makes billable provider calls; memory inputs cross the same authorized provider boundary as reranking, plus the explicitly requested Jev comparison.

Prepare a private JSON array with exactly 30 entries, ten for each of three configured agents. Each entry has `id`, `agentId`, `query`, `type` (`direct`, `indirect`, `continuation`, `no-match`) and `expectedIds` (known relevant stored sources, or an empty list for unmatched probes). For example:

```json
{"id":"main-1","agentId":"main","query":"How was the local browser service configured?","type":"direct","expectedIds":["a stored memory ID"]}
```

Provide the existing provider credentials through the environment (`OPENAI_API_KEY`, `COHERE_API_KEY`, `TYPESAFE_API_KEY`, or the configured key environment names). Explicit Jev configuration takes precedence over its environment fallback. Keep the query file and result directory private; the result contains memory IDs, but no query text or memory plaintext.

```bash
node scripts/compare-recall.mjs \
  --queries /private/recall-queries.json \
  --output /private/recall-results.json
```

Optional `--state-dir` and `--config` select an existing OpenClaw installation. The output parent must already exist. The program writes a checkpoint after each question. Missing credentials or invalid datasets fail instead of pretending an unfiltered call was a Jev experiment. A replay uses real providers and is billed again.

Compare anchor hits/losses, query-level timings and `providerUsage.searchUnits`. Jev usage appears under `filter.usage`. Monetary cost remains null unless separately computed using verified account-specific prices. Canonical-file and graph boosters are intentionally excluded; keep their behavior unchanged when applying any recommendation. Activate a larger pool only with additional useful hits inside the production budget, and a prefilter only without relevant losses and with a measured latency or cost benefit. Ties retain the simpler existing route.
