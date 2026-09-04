/**
 * Memory runtime for the OpenClaw host.
 *
 * OpenClaw asks the plugin that owns the memory slot for a `runtime` through
 * `registerMemoryCapability`. Without one, `doctor.memory.status` answers
 * "memory plugin unavailable" and the Memory page in the Control UI shows no
 * provider, no embedding state and no dreaming status. This module builds
 * that runtime on top of PLUR1BUS' own recall pipeline and provider settings.
 *
 * What it deliberately does not do:
 * - It never shares pool handles with the host. `close()` is a no-op because
 *   the host closes the manager after every status call and PLUR1BUS' pools
 *   outlive any single request.
 * - It only reads the agent's private partition. A host-originated search has
 *   no session, no workspace identity and no user principal, so the shared
 *   pools stay out of it; `authorizeSearchHits` additionally drops anything
 *   that claims to come from session transcripts.
 * - Cards are addressed as `plur1bus://<agentId>/<cardId>`; `readFile` on
 *   such a path returns that card's text, nothing from disk.
 */
export const MEMORY_HOST_PATH_SCHEME = "plur1bus://";
const PROBE_TEXT = "PLUR1BUS embedding readiness probe";
const PROBE_CACHE_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const SNIPPET_MAX_CHARS = 400;
const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS_CAP = 50;
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function plainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Build the host path for one card. */
export function memoryHostPath(agentId, cardId) {
  return `${MEMORY_HOST_PATH_SCHEME}${encodeURIComponent(agentId)}/${encodeURIComponent(cardId)}`;
}

/** Parse a host path back into its parts, or null for anything that is not ours. */
export function parseMemoryHostPath(relPath) {
  if (typeof relPath !== "string" || !relPath.startsWith(MEMORY_HOST_PATH_SCHEME)) return null;
  const rest = relPath.slice(MEMORY_HOST_PATH_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  let agentId;
  let cardId;
  try {
    agentId = decodeURIComponent(rest.slice(0, slash));
    cardId = decodeURIComponent(rest.slice(slash + 1));
  } catch {
    return null;
  }
  if (!AGENT_ID_RE.test(agentId) || !CARD_ID_RE.test(cardId)) return null;
  return { agentId, cardId };
}

function snippetOf(entry) {
  const summary = typeof entry?.summary === "string" ? entry.summary.trim() : "";
  const text = typeof entry?.text === "string" ? entry.text.trim() : "";
  const base = summary || text;
  return base.length > SNIPPET_MAX_CHARS ? `${base.slice(0, SNIPPET_MAX_CHARS).trimEnd()}…` : base;
}

function lineCount(text) {
  return typeof text === "string" && text ? text.split("\n").length : 1;
}

/** Map one PLUR1BUS recall hit onto the host's MemorySearchResult shape. */
export function toHostSearchResult(agentId, hit) {
  const entry = plainRecord(hit?.entry) ? hit.entry : plainRecord(hit) ? hit : {};
  const id = typeof entry.id === "string" && entry.id ? entry.id : null;
  if (!id) return null;
  const text = typeof entry.text === "string" ? entry.text : "";
  const category = typeof entry.category === "string" && entry.category ? entry.category : "memory";
  const isDream = entry.memoryClass === "dream";
  return {
    path: memoryHostPath(agentId, id),
    startLine: 1,
    endLine: lineCount(text),
    score: clampScore(hit?.score ?? entry.score),
    snippet: isDream ? `🌙 ${snippetOf(entry)}` : snippetOf(entry),
    source: "memory",
    ...(Number.isFinite(Number(entry.importance)) ? { importance: clampScore(entry.importance) } : {}),
    citation: `PLUR1BUS ${category}${isDream ? " (dream)" : ""}`,
  };
}

/** Resolve the workspace directory the host configured for an agent. */
export function resolveAgentWorkspaceDir(hostConfig, agentId) {
  const agents = plainRecord(hostConfig?.agents) ? hostConfig.agents : {};
  const entry = plainRecord(agents.entries) ? agents.entries[agentId] : null;
  const own = plainRecord(entry) && typeof entry.workspace === "string" && entry.workspace.trim() ? entry.workspace.trim() : null;
  if (own) return own;
  const defaults = plainRecord(agents.defaults) ? agents.defaults : {};
  return typeof defaults.workspace === "string" && defaults.workspace.trim() ? defaults.workspace.trim() : null;
}

/**
 * Create the runtime object for `registerMemoryCapability({ runtime })`.
 *
 * Every dependency is a function so the runtime can be registered before the
 * pools and providers exist; they are only dereferenced when the host calls.
 */
export function createMemoryHostRuntime({
  recall,
  readCard,
  provider,
  embed,
  cardCount = async () => null,
  hostConfig = () => ({}),
  dbPath = () => null,
  now = Date.now,
  logger = null,
} = {}) {
  if (typeof recall !== "function") throw new Error("memory host runtime needs a recall function");
  if (typeof readCard !== "function") throw new Error("memory host runtime needs a card reader");
  if (typeof provider !== "function") throw new Error("memory host runtime needs a provider descriptor");
  if (typeof embed !== "function") throw new Error("memory host runtime needs an embedding function");

  let probeCache = null;

  const probeEmbeddingAvailability = async () => {
    const at = now();
    if (probeCache && probeCache.cacheExpiresAtMs > at) return { ...probeCache, cached: true };
    let result;
    try {
      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("embedding probe timed out")), PROBE_TIMEOUT_MS);
        timer.unref?.();
      });
      const vector = await Promise.race([embed(PROBE_TEXT), timeout]);
      const ok = Array.isArray(vector) ? vector.length > 0 : ArrayBuffer.isView(vector) && vector.length > 0;
      result = ok ? { ok: true } : { ok: false, error: "embedding provider returned no vector" };
    } catch (error) {
      result = { ok: false, error: String(error?.message || error).slice(0, 200) };
    }
    probeCache = { ...result, checked: true, cached: false, checkedAtMs: at, cacheExpiresAtMs: at + PROBE_CACHE_MS };
    return probeCache;
  };

  const createManager = (agentId, chunks) => {
    const describe = () => (plainRecord(provider()) ? provider() : {});
    return Object.freeze({
      async search(query, opts = {}) {
        const text = typeof query === "string" ? query.trim() : "";
        if (!text) return [];
        const sources = Array.isArray(opts?.sources) ? opts.sources : null;
        if (sources && !sources.includes("memory")) return [];
        const limit = boundedInteger(opts?.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_CAP);
        const minScore = Number.isFinite(Number(opts?.minScore)) ? clampScore(opts.minScore) : null;
        // The recall pipeline has no cancellation input; the host's signal is
        // accepted here for the contract's sake and not propagated.
        const hits = await recall({ agentId, query: text, limit, signal: opts?.signal ?? null });
        const results = [];
        for (const hit of Array.isArray(hits) ? hits : []) {
          const mapped = toHostSearchResult(agentId, hit);
          if (!mapped) continue;
          if (minScore !== null && mapped.score < minScore) continue;
          results.push(mapped);
          if (results.length >= limit) break;
        }
        return results;
      },
      async readFile({ relPath, from, lines } = {}) {
        const parsed = parseMemoryHostPath(relPath);
        if (!parsed || parsed.agentId !== agentId) throw new Error("memory path is not a PLUR1BUS card of this agent");
        const card = await readCard({ agentId, cardId: parsed.cardId });
        if (!card) throw new Error("memory card not found");
        const all = String(card.text ?? "").split("\n");
        const start = boundedInteger(from, 1, 1, Math.max(1, all.length));
        const count = boundedInteger(lines, all.length, 1, all.length);
        const slice = all.slice(start - 1, start - 1 + count);
        const truncated = start - 1 + count < all.length;
        return {
          path: relPath,
          text: slice.join("\n"),
          from: start,
          lines: slice.length,
          truncated,
          ...(truncated ? { nextFrom: start + slice.length } : {}),
        };
      },
      status() {
        const description = describe();
        const workspaceDir = resolveAgentWorkspaceDir(hostConfig(), agentId);
        return {
          backend: "builtin",
          provider: typeof description.provider === "string" ? description.provider : "plur1bus",
          ...(typeof description.model === "string" ? { model: description.model } : {}),
          ...(workspaceDir ? { workspaceDir } : {}),
          ...(typeof dbPath() === "string" ? { dbPath: dbPath() } : {}),
          dirty: false,
          sources: ["memory"],
          ...(Number.isSafeInteger(chunks) ? {
            files: 1,
            chunks,
            sourceCounts: [{ source: "memory", files: 1, chunks }],
          } : {}),
        };
      },
      getCachedEmbeddingAvailability() {
        return probeCache ? { ...probeCache, cached: true } : null;
      },
      probeEmbeddingAvailability,
      async probeVectorAvailability() {
        return true;
      },
      async probeVectorStoreAvailability() {
        return true;
      },
      async close() {
        // Shared pools; nothing to release per manager.
      },
    });
  };

  return Object.freeze({
    async getMemorySearchManager({ agentId, purpose = "default" } = {}) {
      if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) {
        return { manager: null, error: "invalid agent id" };
      }
      const startedAt = now();
      try {
        let chunks = null;
        try {
          chunks = await cardCount(agentId);
        } catch (error) {
          logger?.debug?.(`memory-host-runtime: card count unavailable for ${agentId}: ${error?.message || error}`);
        }
        const manager = createManager(agentId, chunks);
        return { manager, debug: { backend: "builtin", purpose, managerMs: Math.max(0, now() - startedAt) } };
      } catch (error) {
        logger?.warn?.(`memory-host-runtime: manager unavailable for ${agentId}: ${error?.message || error}`);
        return { manager: null, error: "PLUR1BUS memory runtime unavailable" };
      }
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" };
    },
    async authorizeSearchHits({ hits } = {}) {
      return (Array.isArray(hits) ? hits : []).filter((hit) => hit?.source !== "sessions");
    },
  });
}
