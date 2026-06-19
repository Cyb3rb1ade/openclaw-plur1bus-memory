## v6.7.1 — Reranker Bugfix

### Problem

When a Cohere reranker was configured, PLUR1BUS unconditionally instantiated a `LocalTransformersRerankerProvider` (ONNX/HuggingFace) as a fallback — even when `fallbackProvider` was not set in the config. This caused:

- **3–8 second Node.js event loop delays** per session start (ONNX runtime loading on CPU)
- **Gateway RSS 1.5–1.7 GiB** (local transformer model held in memory permanently)
- **Recall timeouts** (`recall worker timed out after 45000ms`) as a downstream effect of the blocked event loop
- `reranker enabled (cohere, model: chained:cohere->local-transformers)` in logs even with a plain Cohere config

### Fix

`LocalTransformersRerankerProvider` is now only instantiated when `rerankerCfg.fallbackProvider === "local-transformers"` is explicitly set in the plugin config. The default path (no `fallbackProvider` or `"disabled"`) uses Cohere directly with no local fallback — matching the correct behavior already implemented in `lib/providers/factory.js`.

**After the fix:** `reranker enabled (cohere, model: chained:cohere->none)` — Cohere only, no ONNX load, no event loop blocking.

### Who is affected

Any installation with `reranker.enabled: true` and `reranker.apiKey` (Cohere) but **without** an explicit `reranker.fallbackProvider: "local-transformers"` config key. This is the default config shown in the README and installation guide.

### Upgrade

```bash
clawhub package update @cyb3rb1ade/plur1bus-memory
systemctl --user restart openclaw-gateway
```

Or from source:
```bash
git -C ~/.openclaw/extensions/memory-lancedb-namespaced pull
systemctl --user restart openclaw-gateway
```
