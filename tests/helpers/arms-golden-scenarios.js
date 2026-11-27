/**
 * tests/helpers/arms-golden-scenarios.js
 *
 * DB-free recall scenarios for the retrieval-arm switches (V0, V2, V3c, V3a).
 * `runArmsGoldenScenarios` takes the pipeline and the renderer as arguments,
 * so the same scenarios run against the current tree and against a copy of
 * the tree before the switches existed: the fixture
 * `tests/fixtures/arms-golden/expected.json` was produced from that copy, and
 * the test asserts that the current code with every switch absent or off
 * produces it byte for byte.
 *
 * The fake table honours `limit()` on vector searches (rows sorted by
 * `_distance`), answers `id IN (...)` / `id = '...'` lookups and the keyword
 * fallback's LIKE / createdAt predicates. Rows carry a `vector`, and
 * `_distance` is the squared L2 distance to the query vector, as LanceDB
 * reports it for the default metric.
 */

export const GOLDEN_NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAY = 86_400_000;
export const GOLDEN_DIM = 6;

/** Axis-mixing unit vector: `weights` over GOLDEN_DIM axes, normalised. */
export function unitVector(weights) {
  const v = Array.from({ length: GOLDEN_DIM }, (_, i) => Number(weights[i] ?? 0));
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / len);
}

/** Squared L2 distance (LanceDB's default `_distance`). */
export function squaredL2(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return sum;
}

/** Stub embeddings: every text maps to a fixed vector through `table`, else axis 5. */
export function goldenEmbeddings(table = {}, { delayMs = 0 } = {}) {
  const embed = async (text) => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    for (const [needle, vector] of Object.entries(table)) {
      if (String(text).includes(needle)) return vector;
    }
    return unitVector([0, 0, 0, 0, 0, 1]);
  };
  return { dim: GOLDEN_DIM, embed, embedQuery: embed };
}

/**
 * One row in the memory shape `projectRecallEntry` reads.
 * @param {object} opts
 * @returns {object}
 */
export function goldenRow(opts) {
  return {
    id: opts.id,
    text: opts.text ?? `Memory ${opts.id}`,
    summary: opts.summary ?? "",
    category: opts.category ?? "fact",
    origin: "dm",
    status: opts.status ?? "active",
    importance: 0.5,
    memoryStrength: opts.memoryStrength ?? 1,
    memoryClass: "standard",
    createdAt: opts.createdAt ?? GOLDEN_NOW - 10 * DAY,
    updatedAt: 0,
    agentId: opts.agentId ?? "agent-a",
    storedBy: opts.storedBy ?? opts.agentId ?? "agent-a",
    scope: opts.scope ?? "agent-private",
    workspaceKey: "",
    workspaceId: "",
    ownerUserId: "",
    epistemicStatus: "",
    validFrom: 0,
    validUntil: 0,
    sourceTurnId: opts.sourceTurnId ?? "",
    chunkGroupId: "",
    vector: opts.vector ?? unitVector([1]),
  };
}

/**
 * Fake LanceDB table over `rows`.
 * @param {object[]} rows
 * @param {{log?: string[]}} [opts] `log` receives one entry per query kind
 * @returns {object}
 */
export function goldenTable(rows, { log = null } = {}) {
  const matchWhere = (clause) => {
    const text = String(clause ?? "");
    const inMatch = /^id\s+IN\s*\((.+)\)$/i.exec(text);
    if (inMatch) {
      const ids = new Set((inMatch[1].match(/'([^']*)'/g) ?? []).map((s) => s.slice(1, -1)));
      return rows.filter((r) => ids.has(r.id));
    }
    const eqMatch = /^id\s*=\s*'([^']+)'$/i.exec(text);
    if (eqMatch) return rows.filter((r) => r.id === eqMatch[1]);
    const since = /createdAt\s*>=\s*(\d+)/.exec(text);
    if (since) return rows.filter((r) => r.status === "active" && Number(r.createdAt) >= Number(since[1]));
    const likes = [...text.matchAll(/LIKE '%([^%']+)%'/g)].map((m) => m[1]);
    if (likes.length) return rows.filter((r) => r.status === "active" && likes.some((k) => String(r.text).toLowerCase().includes(k)));
    return rows;
  };
  return {
    vectorSearch(vector) {
      log?.push("vectorSearch");
      const ranked = rows
        .map((row) => ({ ...row, _distance: squaredL2(vector, row.vector) }))
        .sort((a, b) => a._distance - b._distance || (a.id < b.id ? -1 : 1));
      const builder = {
        where() { return builder; },
        limit(n) { return { async toArray() { return ranked.slice(0, n); } }; },
      };
      return builder;
    },
    query() {
      return {
        where(clause) {
          log?.push(/^id\s/i.test(String(clause)) ? "getByIds" : "query");
          const matched = matchWhere(clause);
          const q = {
            select() { return q; },
            limit(n) { return { async toArray() { return matched.slice(0, n).map((r) => ({ ...r })); } }; },
          };
          return q;
        },
      };
    },
  };
}

const silentLogger = { info() {}, warn() {}, debug() {}, error() {} };

/** Reverses the candidate order (a reranker that moves tail rows up). */
const reverseReranker = {
  async rerank(_query, docs, limit) {
    return docs.map((_, i) => ({ index: docs.length - 1 - i, relevance_score: 1 - i / (docs.length + 1) })).slice(0, limit);
  },
};

/** 24 rows spread over the axes, deterministic. */
export function goldenRows() {
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const axis = i % 4;
    const w = [0, 0, 0, 0, 0, 0];
    w[axis] = 1;
    w[(axis + 1) % 4] = 0.15 * (i % 5);
    w[4] = 0.05 * (i % 7);
    rows.push(goldenRow({
      id: `m${String(i).padStart(2, "0")}`,
      text: [
        `[2026-11-${String(1 + (i % 19)).padStart(2, "0")} 10:00] Melanie: I went hiking with the kids, trip number ${i}`,
        `[2026-11-${String(1 + (i % 19)).padStart(2, "0")} 11:00] Caroline: I painted a lake sunrise, picture ${i}`,
        `[2026-11-${String(1 + (i % 19)).padStart(2, "0")} 12:00] Melanie: We adopted a dog named Oscar, note ${i}`,
        `[2026-11-${String(1 + (i % 19)).padStart(2, "0")} 13:00] Caroline: The support group met on Friday, entry ${i}`,
      ][axis],
      createdAt: GOLDEN_NOW - (i + 1) * DAY / 2,
      vector: unitVector(w),
      memoryStrength: 1 - 0.01 * (i % 3),
    }));
  }
  return rows;
}

/** Base parameters every scenario shares. */
function base(extra = {}) {
  return {
    agentId: "agent-a",
    topN: 6,
    budget: 6,
    candidateTopK: 12,
    rerankCandidates: 12,
    recallMinScore: 0.05,
    importanceBoost: 0,
    canonicalEnabled: false,
    associativeEnabled: false,
    dedupEnabled: true,
    logger: silentLogger,
    now: GOLDEN_NOW,
    ...extra,
  };
}

const QUERY_VECTORS = {
  "activities": unitVector([1, 0.3, 0, 0, 0.1]),
  "painted": unitVector([0, 1, 0.2, 0, 0]),
  "dog": unitVector([0, 0, 1, 0.1, 0]),
  "yesterday": unitVector([0.5, 0.5, 0.2, 0.2, 0]),
  "When": unitVector([0, 0.1, 0.2, 1, 0]),
};

/**
 * Pipeline scenarios: name → parameters (without dbTable/embeddings).
 * `extra` is merged into every scenario (e.g. explicit-off switches).
 * @param {object} [extra]
 * @returns {Array<{name: string, params: object, slowEmbed?: boolean}>}
 */
export function pipelineScenarios(extra = {}) {
  return [
    { name: "plain", params: base({ query: "Who painted the lake?", ...extra }) },
    { name: "rerank-deferred", params: base({ query: "Tell me about the dog", reranker: reverseReranker, deferFinalCap: true, candidateHardLimit: 100, ...extra }) },
    { name: "collection-query", params: base({ query: "What activities does Melanie partake in?", deferFinalCap: true, candidateHardLimit: 100, reranker: reverseReranker, ...extra }) },
    { name: "collection-query-capped", params: base({ query: "What activities does Melanie partake in?", ...extra }) },
    { name: "when-question", params: base({ query: "When did Caroline go to the support group?", deferFinalCap: true, candidateHardLimit: 100, ...extra }) },
    { name: "temporal-intent", params: base({ query: "What did we talk about yesterday?", ...extra }) },
    { name: "trace", params: base({ query: "What activities does Melanie like?", decisionTrace: true, ...extra }) },
    { name: "keyword-fallback", slowEmbed: true, params: base({ query: "hiking kids trip", keywordFallback: true, embedDeadlineAt: 1, deferFinalCap: true, candidateHardLimit: 100, ...extra }) },
  ];
}

function plain(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => {
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "function") return undefined;
    return v;
  }));
}

/** Items for the renderer, each with an `event` field the off path must ignore. */
export function renderItems() {
  return [
    { id: "r1", category: "fact", source: "memory", display: "Melanie went camping with the kids.", createdAt: GOLDEN_NOW - 30 * DAY, memoryStrength: 1, event: { from: "2026-10-14", until: "2026-10-14", fromMs: Date.UTC(2026, 9, 14), untilMs: Date.UTC(2026, 9, 15), precision: "day", kind: "past", source: "relative", phrase: "last weekend" } },
    { id: "r2", category: "fact", source: "memory", display: "Caroline plans a trip in June.", createdAt: GOLDEN_NOW - 2 * DAY, memoryStrength: 1, event: { from: "2027-06-01", until: "2027-06-30", fromMs: Date.UTC(2027, 5, 1), untilMs: Date.UTC(2027, 6, 1), precision: "month", kind: "planned", source: "explicit", phrase: "in June" } },
    { id: "r3", category: "fact", source: "memory", display: "Oscar is a golden retriever.", createdAt: GOLDEN_NOW - 400 * DAY, memoryStrength: 1 },
  ];
}

/**
 * Runs every scenario and returns a JSON-safe object.
 * @param {{runRecallPipeline: Function, formatRelevantMemoriesContext: Function, extra?: object, renderOptions?: object}} deps
 * @returns {Promise<object>}
 */
export async function runArmsGoldenScenarios({ runRecallPipeline, formatRelevantMemoriesContext, extra = {}, renderOptions = {} }) {
  const out = {};
  for (const scenario of pipelineScenarios(extra)) {
    const rows = goldenRows();
    const result = await runRecallPipeline({
      ...scenario.params,
      dbTable: goldenTable(rows),
      embeddings: goldenEmbeddings(QUERY_VECTORS, { delayMs: scenario.slowEmbed ? 40 : 0 }),
    });
    const { trace, ...rest } = result;
    out[scenario.name] = plain({ ...rest, trace: trace ? { summary: trace.summary ?? null, decisions: (trace.decisions ?? []).length, candidates: (trace.candidates ?? []).length } : null });
  }
  out.render = formatRelevantMemoriesContext(renderItems(), { now: GOLDEN_NOW, maxTotalChars: 20_000, timeZone: "UTC", ...renderOptions });
  return out;
}
