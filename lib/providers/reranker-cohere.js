/**
 * lib/providers/reranker-cohere.js — the Cohere preset of the remote reranker.
 *
 * Kept as its own class for existing callers. From contract 1.15.0 on it is the "cohere"
 * preset of RemoteRerankerProvider: default endpoint https://api.cohere.com/v2/rerank,
 * overridable with `baseUrl`/`protocol`, requests through HostServices.fetch
 * when the host injected one, key from `apiKeyRef` → `apiKeyEnv` → `apiKey` →
 * COHERE_API_KEY.
 */

import { RemoteRerankerProvider } from "./reranker-remote.js";

export class CohereRerankerProvider extends RemoteRerankerProvider {
  constructor(cfg = {}) {
    super({ ...cfg, provider: "cohere" });
  }
}
