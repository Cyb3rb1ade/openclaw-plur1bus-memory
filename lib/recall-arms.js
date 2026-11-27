/**
 * lib/recall-arms.js — retrieval arms over the enrichment sidecar (V2 entity
 * and facet arm, V3c event-time arm) and their fusion with the vector list.
 *
 * The arms add candidates the vector search misses; they never replace it:
 *
 * - entity arm: question persons and entities, matched lexically against the
 *   agent's sidecar vocabulary, plus facets routed from question words.
 *   Hub persons/entities (document frequency above `hubRatio` of the rows,
 *   the owner and agent names in production, both speakers on LOCOMO) never
 *   count for matching or expansion, only as a conjunctive `about` filter
 *   together with a facet. Optional seed expansion over the non-hub entities
 *   of the top vector hits (own deadline, after the vector search).
 * - event arm: a question date window (lib/enrichment/date-resolver.js)
 *   selects rows whose event overlaps it; a "when" question without a window
 *   selects rows that have an event date at all.
 *
 * Phase A (index, candidates, hydration) starts at pipeline entry and runs
 * while the query is embedded; phase B (similarity, seed expansion, fusion)
 * needs the query vector. Each phase has its own deadline and fails open: a
 * late, failing or empty arm leaves the vector list unchanged. Rows reach the
 * fused list only through the caller's hydration callback, which applies the
 * same lifecycle and ACL gates as the keyword fallback, and only when the
 * sidecar entry was computed from the current row text — index membership
 * grants no access. Nothing is written.
 *
 * Score scale: an arm row's `score`/`vectorScore` is the score the vector
 * search would have reported for it, `distanceToScore(squared L2)` (LanceDB's
 * default metric reports squared L2 as `_distance`), so the additive terms in
 * the scoring step stay comparable; the raw cosine is kept as `armCosine`.
 * That holds for a flat scan only: with a vector index (hnswPq from 256 rows,
 * engine/store/memory-db.js) `_distance` is approximate and usually larger,
 * so vector rows would score lower than arm rows of the same nearness. The
 * pipeline logs one warning per table when it finds a vector index while the
 * arms are on (a read-only check in the 27.11.2026 review found none on the
 * production tables).
 * Fusion only decides which rows fill the candidate slots; the scoring step
 * and the reranker order them.
 *
 * Latency: shadow mode costs what on costs (phase A, and with the entity arm
 * a seed expansion of up to expansionTimeoutMs after the vector search); it
 * only does not change the result.
 */

import { DEFAULT_EVENT_TIME_ZONE, resolveEventDates } from "./enrichment/date-resolver.js";
import { ENRICH_FACETS, normalizeEnrichmentName } from "./enrichment/enrich-llm.js";
import { distanceToScore } from "./score.js";

export const RETRIEVAL_ARM_MODES = Object.freeze(["off", "shadow", "on"]);
export const RETRIEVAL_ARM_FUSIONS = Object.freeze(["rrf", "slots"]);

/** Defaults of recall.retrievalArms (everything off). */
export const RETRIEVAL_ARM_DEFAULTS = Object.freeze({
  mode: "off",
  entity: false,
  eventTime: false,
  fusion: "rrf",
  timeoutMs: 150,
  expansionTimeoutMs: 150,
  armTopK: 30,
  slots: 30,
  rrfK: 60,
  hubRatio: 0.05,
  hubMinDocs: 2,
  minArmScore: 0.1,
  maxHydrate: 200,
  seedExpansion: true,
  seedCount: 5,
  timeZone: DEFAULT_EVENT_TIME_ZONE,
});

const FACET_SET = new Set(ENRICH_FACETS);
const MAX_QUERY_CHARS = 1_000;
const MAX_NGRAM = 4;
const MAX_FACETS = 3;
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for", "with", "by", "from", "is", "was",
  "are", "were", "do", "does", "did", "has", "have", "had", "what", "which", "who", "when", "where",
  "why", "how", "i", "me", "my", "you", "your", "he", "she", "it", "we", "they", "his", "her", "its",
  "our", "their", "this", "that", "these", "those", "any", "some", "all",
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "und", "oder",
  "von", "vom", "zu", "zum", "zur", "mit", "für", "im", "am", "an", "auf", "aus", "bei", "ist", "war",
  "sind", "hat", "habe", "hast", "ich", "du", "er", "sie", "es", "wir", "ihr", "mein", "meine", "dein",
  "was", "wer", "wann", "wo", "wie", "warum", "welche", "welcher", "welches", "alle",
]);

// Lexical facet routing: word-start stems (EN/DE) → facets. A stem may name
// several facets ("activities" → hobby, sport, art); a trailing "$" makes it
// a whole word ("pet$" does not match "peter").
const FACET_STEMS = [
  [["hobby", "sport", "art"], ["activit", "aktivität", "pastime", "leisure", "freizeit", "for fun", "partake", "unternehm"]],
  [["hobby"], ["hobb", "interest", "craft", "garden", "camp$", "camping", "game", "spiele"]],
  [["sport"], ["sport", "run$", "runs$", "running", "jog", "hike", "hiking", "swim", "bike", "biking", "cycling", "yoga", "gym$", "football", "soccer", "tennis", "climb", "skiing", "marathon", "fitness", "exercis", "wander", "laufen", "joggen", "schwimm", "fahrrad", "radfahr", "kletter", "training"]],
  [["art"], ["art$", "arts$", "artist", "artwork", "paint", "drawing", "sculpt", "pottery", "photograph", "kunst", "malen", "gemälde", "bilder", "zeichn", "bastel", "töpfer"]],
  [["music"], ["music", "song", "sing$", "singing", "singer", "instrument", "guitar", "piano", "violin", "concert", "band$", "bands$", "album", "musik", "lied", "konzert", "gitarre", "klavier", "geige"]],
  [["media"], ["book", "read$", "reads$", "reading", "novel", "author", "movie", "film", "show$", "shows$", "series", "tv$", "podcast", "buch", "bücher", "lesen", "gelesen", "roman", "serie", "sendung"]],
  [["travel"], ["travel", "trip", "vacation", "holiday", "visit", "place", "countr", "city", "cities", "abroad", "flight", "reise", "urlaub", "besuch", "orte$", "länder", "stadt", "städte", "ausflug"]],
  [["food"], ["food", "eat$", "eats$", "eating", "cook", "recipe", "meal", "restaurant", "bake", "baking", "dish$", "dishes$", "essen", "kochen", "gekocht", "rezept", "backen", "gebacken", "gericht", "mahlzeit"]],
  [["pets"], ["pet$", "pets$", "dog", "cat$", "cats$", "puppy", "puppies", "pup$", "pups$", "kitten", "horse", "bird", "haustier", "hund", "katze", "pferd", "vogel"]],
  [["family"], ["family", "famil", "kid$", "kids$", "child", "son$", "sons$", "daughter", "parent", "mother", "father", "mom$", "dad$", "sister", "brother", "grandm", "grandf", "grandp", "grandc", "kinder", "kindern", "sohn", "tochter", "eltern", "mutter", "vater", "schwester", "bruder", "oma$", "opa$", "enkel"]],
  [["friends"], ["friend", "freund"]],
  [["relationship"], ["relationship", "partner", "boyfriend", "girlfriend", "husband", "wife$", "married", "marriage", "dating", "beziehung", "ehe$", "verheiratet", "hochzeitstag"]],
  [["work"], ["work", "job$", "jobs$", "career", "office", "company", "colleague", "project", "business", "arbeit", "beruf", "firma", "kolleg", "projekt", "büro"]],
  [["tech"], ["tech", "computer", "software", "app$", "apps$", "coding", "programming", "laptop", "phone", "technik", "rechner", "programm", "handy"]],
  [["education"], ["school", "study", "studies", "studied", "class$", "classes$", "course", "degree", "universit", "college", "learn", "schule", "studi", "kurs", "lernen", "ausbildung"]],
  [["health"], ["health", "doctor", "sick", "ill$", "illness", "hospital", "therap", "medic", "injur", "gesundheit", "arzt", "ärzt", "krank", "therapie", "medikament"]],
  [["finance"], ["money", "buy$", "buys$", "buying", "bought", "purchas", "spend", "spent", "cost$", "costs$", "price", "saving", "geld", "kaufen", "gekauft", "ausgegeben", "preis", "sparen"]],
  [["home"], ["home", "house", "apartment", "move$", "moved$", "moving", "room$", "rooms$", "haus$", "wohnung", "umzug", "zimmer"]],
  [["events"], ["event", "party", "parties", "celebrat", "wedding", "birthday", "festival", "ceremon", "parade", "conference", "feier", "hochzeit", "geburtstag", "fest$", "veranstalt"]],
  [["plans"], ["plan$", "plans$", "planned", "planning", "goal", "future", "dream", "hope", "wish", "ziel", "vorhaben", "zukunft", "wunsch", "traum"]],
  [["identity"], ["identity", "value", "belief", "believe", "faith", "religio", "gender", "transgender", "lgbtq", "pride", "activis", "identität", "werte$", "glaube"]],
].map(([facets, stems]) => [
  facets.filter((f) => FACET_SET.has(f)),
  new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${stems.map((stem) => {
    const whole = stem.endsWith("$");
    const body = (whole ? stem.slice(0, -1) : stem).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return whole ? `${body}(?![\\p{L}\\p{N}])` : body;
  }).join("|")})`, "u"),
]);

const WHEN_RES = [
  /^\s*(?:when|wann)\b/u,
  /\b(?:what|which)\s+(?:day|date|month|year|week|time|season)\b/u,
  /\bhow\s+long\s+ago\b/u,
  /\b(?:an\s+welchem|in\s+welchem|welche[mnrs]?)\s+(?:tag|datum|monat|jahr|woche)\b/u,
  /\bseit\s+wann\b/u,
  /\bwie\s+lange\s+(?:ist|war)\b[^?]*\bher\b/u,
];

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampNum(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Normalised recall.retrievalArms. `active` is true when the mode is shadow
 * or on and at least one arm is switched on.
 *
 * @param {unknown} cfg
 * @returns {Readonly<typeof RETRIEVAL_ARM_DEFAULTS & {active: boolean}>}
 */
export function normalizeRetrievalArmsConfig(cfg) {
  const s = cfg && typeof cfg === "object" ? cfg : {};
  const d = RETRIEVAL_ARM_DEFAULTS;
  const mode = RETRIEVAL_ARM_MODES.includes(s.mode) ? s.mode : "off";
  const entity = s.entity === true;
  const eventTime = s.eventTime === true;
  // An invalid zone is not checked here: the event arm's date resolver
  // throws a RangeError for it, which planRetrievalArms logs and reports.
  const timeZone = typeof s.timeZone === "string" && s.timeZone ? s.timeZone.slice(0, 64) : d.timeZone;
  return Object.freeze({
    mode,
    entity,
    eventTime,
    fusion: RETRIEVAL_ARM_FUSIONS.includes(s.fusion) ? s.fusion : d.fusion,
    timeoutMs: clampInt(s.timeoutMs, d.timeoutMs, 10, 5_000),
    expansionTimeoutMs: clampInt(s.expansionTimeoutMs, d.expansionTimeoutMs, 10, 5_000),
    armTopK: clampInt(s.armTopK, d.armTopK, 1, 200),
    slots: clampInt(s.slots, d.slots, 0, 200),
    rrfK: clampInt(s.rrfK, d.rrfK, 1, 1_000),
    hubRatio: clampNum(s.hubRatio, d.hubRatio, 0.001, 1),
    hubMinDocs: clampInt(s.hubMinDocs, d.hubMinDocs, 1, 1_000_000),
    minArmScore: clampNum(s.minArmScore, d.minArmScore, 0, 1),
    maxHydrate: clampInt(s.maxHydrate, d.maxHydrate, 1, 1_000),
    seedExpansion: s.seedExpansion !== false,
    seedCount: clampInt(s.seedCount, d.seedCount, 0, 50),
    timeZone,
    active: mode !== "off" && (entity || eventTime),
  });
}

/**
 * Whether a question asks for a point in time ("When did …", "Wann war …").
 *
 * @param {unknown} query
 * @returns {boolean}
 */
export function isWhenQuestion(query) {
  if (typeof query !== "string") return false;
  const text = query.slice(0, 300).toLowerCase();
  return WHEN_RES.some((re) => re.test(text));
}

/**
 * Facets named by question words, at most three, in order of the first
 * matching rule.
 *
 * @param {unknown} query
 * @returns {string[]}
 */
export function routeQueryFacets(query) {
  if (typeof query !== "string") return [];
  const text = query.slice(0, MAX_QUERY_CHARS).toLowerCase().normalize("NFC");
  const out = [];
  for (const [facets, re] of FACET_STEMS) {
    if (!re.test(text)) continue;
    for (const facet of facets) if (!out.includes(facet)) out.push(facet);
    if (out.length >= MAX_FACETS) break;
  }
  return out.slice(0, MAX_FACETS);
}

function queryTokens(query) {
  return String(query ?? "")
    .slice(0, MAX_QUERY_CHARS)
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .split(/[^\p{L}\p{N}'&.-]+/u)
    .map((t) => t.replace(/^['.&-]+|['.&-]+$/g, ""))
    .filter(Boolean);
}

/**
 * Question n-grams (1–4 tokens) that name a person or entity of the index.
 * A trailing possessive ("melanie's") or German genitive -s ("evas") is
 * also tried without it.
 *
 * @param {string} query
 * @param {ReturnType<import("./enrichment/sidecar.js").createEnrichmentIndex>} index
 * @returns {{persons: string[], entities: string[]}}
 */
export function matchQueryVocabulary(query, index) {
  const tokens = queryTokens(query);
  const persons = new Set();
  const entities = new Set();
  const variants = (word) => {
    const out = [word];
    if (word.endsWith("'s")) out.push(word.slice(0, -2));
    else if (word.endsWith("s") && word.length > 3) out.push(word.slice(0, -1));
    return out;
  };
  for (let n = 1; n <= MAX_NGRAM; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const head = tokens.slice(i, i + n - 1);
      if (n === 1 && (STOPWORDS.has(tokens[i]) || tokens[i].length < 2)) continue;
      for (const last of variants(tokens[i + n - 1])) {
        const name = normalizeEnrichmentName([...head, last].join(" "));
        if (!name || (n === 1 && STOPWORDS.has(name))) continue;
        if (index.personDocFreq(name) > 0) persons.add(name);
        if (index.entityDocFreq(name) > 0) entities.add(name);
      }
    }
  }
  return { persons: [...persons], entities: [...entities] };
}

const hubCache = new WeakMap();

function hubSets(index, config) {
  const key = `${index.size}|${config.hubRatio}|${config.hubMinDocs}`;
  const cached = hubCache.get(index);
  if (cached?.key === key) return cached;
  const opts = { ratio: config.hubRatio, minDocs: config.hubMinDocs };
  const value = { key, entities: index.hubEntities(opts), persons: index.hubPersons(opts) };
  hubCache.set(index, value);
  return value;
}

function bumpCount(map, id, by = 1) {
  map.set(id, (map.get(id) ?? 0) + by);
}

function rankCandidates(index, scored, maxHydrate) {
  return [...scored.entries()]
    .map(([id, pre]) => ({ id, pre, anchorTs: index.get(id)?.anchorTs ?? 0 }))
    .filter((c) => c.pre > 0)
    .sort((a, b) => b.pre - a.pre || b.anchorTs - a.anchorTs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, maxHydrate);
}

/**
 * Pure candidate selection over the index (phase A, no I/O).
 *
 * @param {{query: string, index: object, now: number, config: ReturnType<typeof normalizeRetrievalArmsConfig>, logger?: object}} args
 * @returns {{matched: {persons: string[], entities: string[], hubPersons: string[]},
 *   entity: null|{facets: string[], candidates: Array<{id: string, pre: number}>, facetIds: Set<string>, shared: Map<string, number>},
 *   event: null|{window: null|{from: string, until: string, fromMs: number, untilMs: number}, when: boolean,
 *     candidates: Array<{id: string, pre: number}>, inWindow: Set<string>, shared: Map<string, number>, aboutPerson: Set<string>}}}
 */
export function planRetrievalArms({ query, index, now, config, logger = null }) {
  const hubs = hubSets(index, config);
  const vocab = matchQueryVocabulary(query, index);
  const nonHubEntities = vocab.entities.filter((e) => !hubs.entities.has(e));
  const nonHubPersons = vocab.persons.filter((p) => !hubs.persons.has(p));
  const allPersons = vocab.persons;
  // Shared non-hub names per row (entities and non-hub persons alike).
  const shared = new Map();
  for (const e of nonHubEntities) for (const id of index.idsForEntity(e)) bumpCount(shared, id);
  for (const p of nonHubPersons) for (const id of index.idsAbout(p)) bumpCount(shared, id);
  const plan = {
    matched: { persons: allPersons, entities: vocab.entities, hubPersons: allPersons.filter((p) => hubs.persons.has(p)) },
    entity: null,
    event: null,
  };

  if (config.entity) {
    const facets = routeQueryFacets(query);
    const facetIds = new Set();
    for (const p of allPersons) for (const f of facets) for (const id of index.idsAboutFacet(p, f)) facetIds.add(id);
    const pre = new Map();
    for (const [id, count] of shared) pre.set(id, Math.tanh(0.5 * count));
    for (const id of facetIds) pre.set(id, (pre.get(id) ?? 0) + 0.5);
    plan.entity = { facets, facetIds, shared, candidates: rankCandidates(index, pre, config.maxHydrate) };
  }

  if (config.eventTime) {
    let window = null;
    let windowError = null;
    try {
      // Same cap as the other question analysers: a pasted document is no question.
      const text = String(query ?? "").slice(0, MAX_QUERY_CHARS);
      const hit = resolveEventDates(text, Number.isFinite(now) ? now : null, { timeZone: config.timeZone })[0] ?? null;
      if (hit) window = { from: hit.from, until: hit.until, fromMs: hit.fromMs, untilMs: hit.untilMs };
    } catch (error) {
      // Invalid zone or a resolver defect: no window, the "when" rule still applies.
      windowError = String(error?.message || error).slice(0, 120);
      logger?.debug?.(`recall-arms: question date not resolved: ${windowError}`);
    }
    const when = !window && isWhenQuestion(query);
    if (window || when) {
      const ids = window ? index.eventsOverlapping(window.fromMs, window.untilMs) : index.idsWithEvent();
      const inWindow = window ? new Set(ids) : new Set();
      const personSet = new Set(allPersons);
      const aboutPerson = new Set();
      const pre = new Map();
      for (const id of ids) {
        const entry = index.get(id);
        const about = Array.isArray(entry?.about) && entry.about.some((p) => personSet.has(p));
        if (about) aboutPerson.add(id);
        // Every row with an event qualifies; names and persons only order
        // which rows are hydrated first when there are more than maxHydrate.
        pre.set(id, 0.01 + (inWindow.has(id) ? 0.5 : 0) + Math.tanh(0.5 * (shared.get(id) ?? 0)) + (about ? 0.25 : 0));
      }
      plan.event = { window, when, inWindow, shared, aboutPerson, candidates: rankCandidates(index, pre, config.maxHydrate) };
    }
    if (windowError) plan.eventError = windowError;
  }
  return plan;
}

function squaredL2(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Number(a[i]) - Number(b[i]);
    sum += d * d;
  }
  return sum;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

// LanceDB returns the vector column as an Arrow Vector: it has `length`,
// `get(i)` and `toArray()`, but `vector[i]` is undefined.
function plainVector(value) {
  if (!value) return null;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value;
  if (typeof value.toArray === "function") return value.toArray();
  if (typeof value[Symbol.iterator] === "function") return Array.from(value);
  return null;
}

/**
 * Score the vector search would report for a row (squared L2 → score) plus
 * the raw cosine; null when the row has no vector of the query's length.
 * Accepts arrays, typed arrays and Arrow vectors.
 *
 * @param {ArrayLike<number>} queryVector
 * @param {ArrayLike<number>|{toArray: Function}|null|undefined} rowVector
 * @returns {{score: number, cosine: number}|null}
 */
export function armSimilarity(queryVector, rowVector) {
  const q = plainVector(queryVector);
  const v = plainVector(rowVector);
  if (!q || !v || v.length !== q.length || v.length === 0) return null;
  const score = distanceToScore(squaredL2(q, v));
  return Number.isFinite(score) ? { score, cosine: cosine(q, v) } : null;
}

/**
 * Fuses the vector list with arm lists. Only membership changes: vector
 * items stay the same objects, arm-only items are added, the cut is `limit`.
 *
 * - "rrf": Σ 1/(k + rank) over the lists (vector list included), cut at
 *   `limit`; ties keep the vector order.
 * - "slots": vector top (limit − slots), then arm rows not yet included
 *   (round robin over the arm lists), then the remaining vector rows until
 *   `limit` is reached again.
 *
 * @param {{vectorResults: Array<{entry: {id: string}}>, armLists: Array<Array<{entry: {id: string}}>>,
 *   fusion: "rrf"|"slots", limit: number, rrfK?: number, slots?: number}} args
 * @returns {{results: Array, added: string[], displaced: string[]}}
 */
export function fuseRetrievalArms({ vectorResults, armLists, fusion, limit, rrfK = 60, slots = 30 }) {
  const vector = Array.isArray(vectorResults) ? vectorResults : [];
  const lists = (Array.isArray(armLists) ? armLists : []).filter((l) => Array.isArray(l) && l.length > 0);
  const cap = Math.max(0, Math.floor(limit));
  const vectorIds = new Set(vector.map((r) => r.entry.id));
  let results;
  if (lists.length === 0) {
    results = vector.slice(0, cap);
  } else if (fusion === "slots") {
    const keep = Math.max(0, cap - slots);
    results = vector.slice(0, keep);
    const taken = new Set(results.map((r) => r.entry.id));
    const cursors = lists.map(() => 0);
    let progress = true;
    let addedCount = 0;
    while (progress && addedCount < slots && results.length < cap) {
      progress = false;
      for (let li = 0; li < lists.length && addedCount < slots && results.length < cap; li++) {
        const list = lists[li];
        while (cursors[li] < list.length) {
          const item = list[cursors[li]++];
          if (taken.has(item.entry.id)) continue;
          taken.add(item.entry.id);
          results.push(item);
          addedCount++;
          progress = true;
          break;
        }
      }
    }
    for (let i = keep; i < vector.length && results.length < cap; i++) {
      if (taken.has(vector[i].entry.id)) continue;
      taken.add(vector[i].entry.id);
      results.push(vector[i]);
    }
  } else {
    const k = Math.max(1, rrfK);
    const fused = new Map();
    const add = (item, rank, listIndex) => {
      const id = item.entry.id;
      let slot = fused.get(id);
      if (!slot) {
        slot = { item, score: 0, firstList: listIndex, firstRank: rank };
        fused.set(id, slot);
      }
      slot.score += 1 / (k + rank);
    };
    vector.forEach((item, i) => add(item, i + 1, 0));
    lists.forEach((list, li) => {
      const seen = new Set();
      let rank = 0;
      for (const item of list) {
        if (seen.has(item.entry.id)) continue;
        seen.add(item.entry.id);
        add(item, ++rank, li + 1);
      }
    });
    results = [...fused.values()]
      .sort((a, b) => b.score - a.score || a.firstList - b.firstList || a.firstRank - b.firstRank)
      .slice(0, cap)
      .map((slot) => slot.item);
  }
  const kept = new Set(results.map((r) => r.entry.id));
  return {
    results,
    added: results.filter((r) => !vectorIds.has(r.entry.id)).map((r) => r.entry.id),
    displaced: vector.filter((r) => !kept.has(r.entry.id)).map((r) => r.entry.id),
  };
}

function resolveIndex(source) {
  const value = typeof source === "function" ? source() : source;
  if (!value) return { index: null, complete: false };
  if (typeof value.offer === "function" && typeof value.lookup === "function") return { index: value, complete: true };
  if (value.index && typeof value.index.lookup === "function") return { index: value.index, complete: value.complete !== false };
  return { index: null, complete: false };
}

function deadline(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(DEADLINE), Math.max(0, ms)); });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}
const DEADLINE = Symbol("plur1bus.arms.deadline");

function describe(error) {
  return String(error?.message || error || "error").slice(0, 160);
}

/**
 * Starts phase A in the background. It runs after the current macrotask
 * (setImmediate), so the caller's embedding request, including one queued
 * as a microtask by the keyword-fallback path, is sent before the sidecar
 * refresh and the candidate planning take the main thread. The returned
 * promise never rejects.
 *
 * @param {{query: string, now: number, config: ReturnType<typeof normalizeRetrievalArmsConfig>,
 *   enrichmentIndex: unknown, hydrate: (ids: string[]) => Promise<Array<{row: object, entry: object}>>,
 *   logger?: object}} args `hydrate` returns rows that passed lifecycle and ACL
 * @returns {{startedAt: number, promise: Promise<object>}}
 */
export function startRetrievalArms({ query, now, config, enrichmentIndex, hydrate, logger = null }) {
  const startedAt = Date.now();
  const run = async () => {
    const state = { index: null, complete: false, plan: null, hydrated: new Map(), error: null, hydrateMs: 0 };
    try {
      const resolved = resolveIndex(enrichmentIndex);
      state.index = resolved.index;
      state.complete = resolved.complete;
      if (!state.index || state.index.size === 0) return state;
      state.plan = planRetrievalArms({ query, index: state.index, now, config, logger });
      const ids = new Set();
      for (const c of state.plan.entity?.candidates ?? []) ids.add(c.id);
      for (const c of state.plan.event?.candidates ?? []) ids.add(c.id);
      if (ids.size > 0) {
        const t0 = Date.now();
        for (const item of await hydrate([...ids])) state.hydrated.set(item.entry.id, item);
        state.hydrateMs = Date.now() - t0;
      }
    } catch (error) {
      state.error = describe(error);
      logger?.debug?.(`recall-arms: phase A failed: ${state.error}`);
    }
    return state;
  };
  const promise = new Promise((resolve) => { setImmediate(resolve); }).then(run);
  return { startedAt, promise };
}

function freshItem(state, id, queryVector, armScoreBonus, minArmScore, arm) {
  const hydrated = state.hydrated.get(id);
  if (!hydrated) return null;
  const { row, entry } = hydrated;
  if (!state.index.lookup(id, typeof row.text === "string" ? row.text : String(entry.text ?? ""))) return null;
  const sim = armSimilarity(queryVector, row.vector);
  if (!sim || sim.score < minArmScore) return null;
  return {
    entry,
    score: sim.score,
    vectorScore: sim.score,
    source: "vector",
    retrievalArm: arm,
    armScore: sim.score + armScoreBonus,
    armCosine: sim.cosine,
  };
}

/**
 * Phase B: waits for phase A until its deadline, runs the optional seed
 * expansion under its own deadline, scores and fuses. Never throws; on any
 * failure the vector list comes back unchanged.
 *
 * @param {{startedAt: number, promise: Promise<object>}} task from startRetrievalArms
 * @param {{queryVector: ArrayLike<number>, vectorResults: Array, limit: number,
 *   config: ReturnType<typeof normalizeRetrievalArmsConfig>,
 *   hydrate: (ids: string[]) => Promise<Array<{row: object, entry: object}>>, logger?: object}} args
 * @returns {Promise<{results: Array, diagnostics: object}>}
 */
export async function finishRetrievalArms(task, { queryVector, vectorResults, limit, config, hydrate, logger = null }) {
  const diagnostics = {
    mode: config.mode,
    fusion: config.fusion,
    ms: 0,
    timedOut: false,
    indexComplete: false,
    indexSize: 0,
    entity: null,
    event: null,
    expansion: null,
    added: [],
    displaced: [],
  };
  const unchanged = () => ({ results: vectorResults, diagnostics });
  try {
    const remaining = config.timeoutMs - (Date.now() - task.startedAt);
    const state = await deadline(task.promise, remaining);
    if (state === DEADLINE) {
      diagnostics.timedOut = true;
      return unchanged();
    }
    diagnostics.indexComplete = state.complete;
    diagnostics.indexSize = state.index?.size ?? 0;
    if (state.error) {
      diagnostics.error = state.error;
      return unchanged();
    }
    if (!state.index || !state.plan || !queryVector) return unchanged();
    const { plan } = state;
    diagnostics.matched = { persons: plan.matched.persons.length, hubPersons: plan.matched.hubPersons.length, entities: plan.matched.entities.length };
    if (plan.eventError) diagnostics.eventError = plan.eventError;
    const vectorIds = new Set(vectorResults.map((r) => r.entry.id));
    const armLists = [];

    if (plan.entity) {
      const list = [];
      for (const { id } of plan.entity.candidates) {
        const bonus = (plan.entity.facetIds.has(id) ? 0.5 : 0) + Math.tanh(0.5 * (plan.entity.shared.get(id) ?? 0));
        const item = freshItem(state, id, queryVector, bonus, config.minArmScore, "entity");
        if (item) list.push(item);
      }
      // Seed expansion: non-hub entities of the top vector hits (own deadline).
      if (config.seedExpansion && config.seedCount > 0 && vectorResults.length > 0) {
        const hubs = hubSets(state.index, config);
        const counts = new Map();
        for (const r of vectorResults.slice(0, config.seedCount)) {
          const entry = state.index.lookup(r.entry.id, r.entry.text);
          if (!entry) continue;
          for (const e of entry.entities) {
            if (hubs.entities.has(e)) continue;
            for (const id of state.index.idsForEntity(e)) {
              if (vectorIds.has(id) || state.hydrated.has(id)) continue;
              bumpCount(counts, id);
            }
          }
        }
        const ranked = rankCandidates(state.index, new Map([...counts].map(([id, n]) => [id, Math.tanh(0.5 * n)])), config.maxHydrate);
        diagnostics.expansion = { candidates: ranked.length, hydrated: 0, timedOut: false };
        if (ranked.length > 0) {
          const started = Date.now();
          let extra;
          try {
            extra = await deadline(Promise.resolve().then(() => hydrate(ranked.map((c) => c.id))), config.expansionTimeoutMs);
          } catch (error) {
            // A failed expansion keeps the direct candidates.
            diagnostics.expansion.error = describe(error);
            logger?.debug?.(`recall-arms: seed expansion failed: ${diagnostics.expansion.error}`);
            extra = [];
          }
          if (extra === DEADLINE) {
            diagnostics.expansion.timedOut = true;
          } else {
            for (const item of extra) state.hydrated.set(item.entry.id, item);
            diagnostics.expansion.hydrated = extra.length;
            diagnostics.expansion.ms = Date.now() - started;
            for (const c of ranked) {
              const item = freshItem(state, c.id, queryVector, Math.tanh(0.5 * (counts.get(c.id) ?? 0)), config.minArmScore, "entity-expansion");
              if (item) list.push(item);
            }
          }
        }
      }
      list.sort((a, b) => b.armScore - a.armScore);
      const top = list.slice(0, config.armTopK);
      armLists.push(top);
      diagnostics.entity = {
        facets: plan.entity.facets,
        candidates: plan.entity.candidates.length,
        scored: list.length,
        list: top.map((r) => r.entry.id),
      };
    }

    if (plan.event) {
      const list = [];
      for (const { id } of plan.event.candidates) {
        const bonus = (plan.event.inWindow.has(id) ? 0.5 : 0) + Math.tanh(0.5 * (plan.event.shared.get(id) ?? 0)) + (plan.event.aboutPerson.has(id) ? 0.25 : 0);
        const item = freshItem(state, id, queryVector, bonus, config.minArmScore, "event");
        if (item) list.push(item);
      }
      list.sort((a, b) => b.armScore - a.armScore);
      const top = list.slice(0, config.armTopK);
      armLists.push(top);
      diagnostics.event = {
        window: plan.event.window ? { from: plan.event.window.from, until: plan.event.window.until } : null,
        when: plan.event.when,
        candidates: plan.event.candidates.length,
        scored: list.length,
        list: top.map((r) => r.entry.id),
      };
    }

    const fused = fuseRetrievalArms({ vectorResults, armLists, fusion: config.fusion, limit, rrfK: config.rrfK, slots: config.slots });
    diagnostics.added = fused.added;
    diagnostics.displaced = fused.displaced;
    diagnostics.ms = Date.now() - task.startedAt;
    return { results: fused.results, diagnostics };
  } catch (error) {
    diagnostics.error = describe(error);
    diagnostics.ms = Date.now() - task.startedAt;
    logger?.debug?.(`recall-arms: phase B failed: ${diagnostics.error}`);
    return unchanged();
  }
}
