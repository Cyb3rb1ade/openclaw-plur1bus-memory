/**
 * lib/enrichment/sidecar.js — append-only sidecar of enrichment entries and
 * the in-memory indexes the retrieval arms read.
 *
 * Production layout: `{baseDbPath}/{agentId}/_enrich/enrichment.jsonl` (live
 * job) and `enrichment.backfill.jsonl` (backfill script). Each writer owns
 * its file, so there is no cross-process lock; the reader merges both and the
 * newest `enrichedAt` per id wins (ties: later file in the list, then later
 * line). The bench passes its own files (`results/enrich/<tag>/<conv>.jsonl`).
 *
 * Memory rows are never written. Entries are validated and projected to a
 * fixed field list on write and on read, so a field such as
 * `validFrom`/`validUntil` can never reach the file. Membership in an index
 * grants no access: arms hydrate rows through the canonical ACL and must check
 * `isEntryFresh(entry, row.text)` before using an entry.
 *
 * Reading is incremental like lib/graph-edge-index.js: per file only the
 * appended bytes are parsed; a rewritten file (other inode, shrunk, new head)
 * rebuilds the index. One refresh reads at most `maxBytesPerRefresh` bytes
 * (256 KB, about 12–40 ms of synchronous parsing) so a first load of a
 * large sidecar never blocks the main thread in one go; the rest is read off
 * the recall path by `drainEnrichmentIndex`, one refresh per event-loop turn.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";

import { journalIdentity, journalOnlyGrew, readJsonlRange } from "../neo-arch.js";
import { safeDebug, safeWarn } from "../safe-logging.js";
import { resolveInside, safeAgentId } from "../sql-safety.js";
import { DEFAULT_EVENT_TIME_ZONE, parseYmd } from "./date-resolver.js";
import {
  DATE_CHECKS,
  ENRICH_FACETS,
  ENRICH_LIMITS,
  EVENT_KINDS,
  EVENT_PRECISIONS,
  EVENT_SOURCES,
  enrichmentContentHash,
  normalizeEnrichmentName,
} from "./enrich-llm.js";

/** Directory below the agent's LanceDB directory. */
export const ENRICH_DIR_NAME = "_enrich";
/** File written by the live enrichment job. */
export const ENRICH_LIVE_FILE = "enrichment.jsonl";
/** File written by the backfill script. */
export const ENRICH_BACKFILL_FILE = "enrichment.backfill.jsonl";
/** Default byte budget of one index refresh (synchronous, may run on the recall path). */
export const ENRICH_REFRESH_MAX_BYTES = 256 * 1024;
/** Upper bound of refreshes in one background drain. */
export const ENRICH_DRAIN_MAX_ROUNDS = 10_000;
/** Sidecar files by writer. */
export const ENRICH_WRITERS = Object.freeze(["live", "backfill"]);

const FACET_SET = new Set(ENRICH_FACETS);
const MAX_ID_CHARS = 256;

/**
 * Sidecar paths of one agent, checked against path traversal.
 *
 * @param {string} baseDbPath LanceDB base directory (must exist)
 * @param {string} agentId
 * @returns {{dir: string, live: string, backfill: string}}
 */
export function enrichmentSidecarPaths(baseDbPath, agentId) {
  const id = safeAgentId(agentId);
  return {
    dir: resolveInside(baseDbPath, id, ENRICH_DIR_NAME),
    live: resolveInside(baseDbPath, id, ENRICH_DIR_NAME, ENRICH_LIVE_FILE),
    backfill: resolveInside(baseDbPath, id, ENRICH_DIR_NAME, ENRICH_BACKFILL_FILE),
  };
}

function names(value, max) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const name = normalizeEnrichmentName(item);
    if (!name) continue;
    if (name.length > ENRICH_LIMITS.maxNameChars) return null;
    if (!out.includes(name)) out.push(name);
  }
  return out.length > max ? null : out;
}

function storedEvent(value) {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== "object" || Array.isArray(value)) return { error: "event" };
  const fromCd = parseYmd(value.from);
  const untilCd = parseYmd(value.until);
  if (fromCd == null || untilCd == null || untilCd < fromCd) return { error: "event-date" };
  if (!Number.isFinite(value.fromMs) || !Number.isFinite(value.untilMs) || value.untilMs <= value.fromMs) return { error: "event-ms" };
  if (!EVENT_PRECISIONS.includes(value.precision)) return { error: "event-precision" };
  if (value.kind !== null && value.kind !== undefined && !EVENT_KINDS.includes(value.kind)) return { error: "event-kind" };
  if (!EVENT_SOURCES.includes(value.source)) return { error: "event-source" };
  if (typeof value.phrase !== "string") return { error: "event-phrase" };
  return {
    value: {
      from: value.from,
      until: value.until,
      fromMs: value.fromMs,
      untilMs: value.untilMs,
      precision: value.precision,
      kind: value.kind ?? null,
      phrase: value.phrase.slice(0, ENRICH_LIMITS.maxPhraseChars),
      source: value.source,
    },
  };
}

/**
 * Validates an entry and projects it to the fixed sidecar field list
 * (unknown fields are dropped).
 *
 * @param {object} raw
 * @returns {{ok: true, entry: object}|{ok: false, error: string}}
 */
export function projectEnrichmentEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "not-object" };
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id || id.length > MAX_ID_CHARS || /[\r\n]/u.test(id)) return { ok: false, error: "id" };
  if (typeof raw.contentHash !== "string" || !/^[0-9a-f]{32,64}$/u.test(raw.contentHash)) return { ok: false, error: "contentHash" };
  if (!Number.isFinite(raw.enrichedAt) || raw.enrichedAt <= 0) return { ok: false, error: "enrichedAt" };
  if (!Number.isInteger(raw.enrichVersion) || raw.enrichVersion < 1) return { ok: false, error: "enrichVersion" };
  const entities = names(raw.entities, ENRICH_LIMITS.maxEntities);
  if (!entities) return { ok: false, error: "entities" };
  const about = names(raw.about, ENRICH_LIMITS.maxAbout);
  if (!about) return { ok: false, error: "about" };
  if (!Array.isArray(raw.facets) || raw.facets.length > ENRICH_LIMITS.maxFacets || !raw.facets.every((f) => FACET_SET.has(f))) return { ok: false, error: "facets" };
  if (!DATE_CHECKS.includes(raw.dateCheck)) return { ok: false, error: "dateCheck" };
  const event = storedEvent(raw.event);
  if (event.error) return { ok: false, error: event.error };
  const entry = {
    id,
    contentHash: raw.contentHash,
    enrichedAt: raw.enrichedAt,
    enrichVersion: raw.enrichVersion,
    model: typeof raw.model === "string" ? raw.model.slice(0, 120) : "",
    promptHash: typeof raw.promptHash === "string" ? raw.promptHash.slice(0, 64) : "",
    timeZone: typeof raw.timeZone === "string" && raw.timeZone ? raw.timeZone.slice(0, 64) : DEFAULT_EVENT_TIME_ZONE,
    anchorTs: Number.isFinite(raw.anchorTs) && raw.anchorTs > 0 ? raw.anchorTs : 0,
    entities,
    about,
    facets: [...new Set(raw.facets)],
    event: event.value,
    dateCheck: raw.dateCheck,
  };
  if (typeof raw.dateReason === "string" && raw.dateReason) entry.dateReason = raw.dateReason.slice(0, 40);
  for (const field of ["eventCandidate", "parserEvent"]) {
    if (raw[field] == null) continue;
    const extra = storedEvent(raw[field]);
    if (extra.error) return { ok: false, error: `${field}-${extra.error}` };
    entry[field] = extra.value;
  }
  return { ok: true, entry };
}

/**
 * Appends validated entries to an agent's sidecar (production writers: the
 * live job and the backfill script). The path comes from
 * enrichmentSidecarPaths (safeAgentId + resolveInside).
 *
 * @param {string} baseDbPath LanceDB base directory of the agent's namespace
 * @param {string} agentId
 * @param {"live"|"backfill"} writer which file of the agent
 * @param {object[]} entries
 * @returns {{written: number, invalid: Array<{id: string, error: string}>}}
 */
export function appendAgentEnrichmentEntries(baseDbPath, agentId, writer, entries) {
  if (!ENRICH_WRITERS.includes(writer)) throw new TypeError(`appendAgentEnrichmentEntries: unknown writer ${String(writer).slice(0, 20)}`);
  const paths = enrichmentSidecarPaths(baseDbPath, agentId);
  return appendEnrichmentEntriesToFile(paths[writer], entries);
}

/**
 * Appends validated entries to a file the caller chose (directory 0o700,
 * file 0o600). Bench and tests only: the path is not checked, so production
 * code uses appendAgentEnrichmentEntries. Invalid entries are not written
 * and are returned.
 *
 * @param {string} file target file (a bench result path)
 * @param {object[]} entries
 * @returns {{written: number, invalid: Array<{id: string, error: string}>}}
 */
export function appendEnrichmentEntriesToFile(file, entries) {
  const lines = [];
  const invalid = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    const projected = projectEnrichmentEntry(raw);
    if (projected.ok) lines.push(JSON.stringify(projected.entry));
    else invalid.push({ id: typeof raw?.id === "string" ? raw.id : "", error: projected.error });
  }
  if (lines.length) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  }
  return { written: lines.length, invalid };
}

/**
 * Whether an entry was computed from exactly this text.
 *
 * @param {{contentHash?: string}|null|undefined} entry
 * @param {string} text current memory text
 * @returns {boolean}
 */
export function isEntryFresh(entry, text) {
  if (!entry || typeof entry.contentHash !== "string") return false;
  const current = enrichmentContentHash(text);
  return entry.contentHash.length === current.length
    ? entry.contentHash === current
    : entry.contentHash.slice(0, current.length) === current;
}

function addTo(map, key, id) {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  set.add(id);
}

function removeFrom(map, key, id) {
  const set = map.get(key);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) map.delete(key);
}

const pairKey = (person, facet) => `${person}\u0000${facet}`;

/**
 * Empty in-memory index. `offer` keeps the winning revision per id (newest
 * `enrichedAt`, then the higher `[fileIndex, seq]`).
 *
 * @returns {{
 *   offer: (entry: object, fileIndex?: number, seq?: number) => boolean,
 *   size: number,
 *   get: (id: string) => object|null,
 *   lookup: (id: string, text: string) => object|null,
 *   ids: () => string[],
 *   idsForEntity: (name: string) => string[],
 *   idsAbout: (name: string) => string[],
 *   idsForFacet: (facet: string) => string[],
 *   idsAboutFacet: (name: string, facet: string) => string[],
 *   idsWithEvent: () => string[],
 *   eventsOverlapping: (fromMs: number, untilMs: number) => string[],
 *   entityDocFreq: (name: string) => number,
 *   personDocFreq: (name: string) => number,
 *   hubEntities: (opts?: {ratio?: number, minDocs?: number}) => Set<string>,
 *   hubPersons: (opts?: {ratio?: number, minDocs?: number}) => Set<string>,
 *   vocabulary: () => {entities: string[], persons: string[]},
 * }}
 */
export function createEnrichmentIndex() {
  const winners = new Map();
  const byEntity = new Map();
  const byPerson = new Map();
  const byFacet = new Map();
  const byPersonFacet = new Map();
  const withEvent = new Set();
  let sortedEvents = null;

  const unindex = (entry) => {
    for (const e of entry.entities) removeFrom(byEntity, e, entry.id);
    for (const p of entry.about) removeFrom(byPerson, p, entry.id);
    for (const f of entry.facets) {
      removeFrom(byFacet, f, entry.id);
      for (const p of entry.about) removeFrom(byPersonFacet, pairKey(p, f), entry.id);
    }
    if (withEvent.delete(entry.id)) sortedEvents = null;
  };
  const index = (entry) => {
    for (const e of entry.entities) addTo(byEntity, e, entry.id);
    for (const p of entry.about) addTo(byPerson, p, entry.id);
    for (const f of entry.facets) {
      addTo(byFacet, f, entry.id);
      for (const p of entry.about) addTo(byPersonFacet, pairKey(p, f), entry.id);
    }
    if (entry.event) { withEvent.add(entry.id); sortedEvents = null; }
  };
  const ids = (set) => (set ? [...set] : []);
  const hubs = (map, { ratio = 0.05, minDocs = 2 } = {}) => {
    const limit = Math.max(minDocs, ratio * winners.size);
    const out = new Set();
    for (const [name, set] of map) if (set.size > limit) out.add(name);
    return out;
  };

  return {
    offer(entry, fileIndex = 0, seq = 0) {
      const current = winners.get(entry.id);
      if (current) {
        const [at, fi, sq] = current.rank;
        const newer = entry.enrichedAt > at || (entry.enrichedAt === at && (fileIndex > fi || (fileIndex === fi && seq >= sq)));
        if (!newer) return false;
        unindex(current.entry);
      }
      winners.set(entry.id, { entry, rank: [entry.enrichedAt, fileIndex, seq] });
      index(entry);
      return true;
    },
    get size() { return winners.size; },
    get: (id) => winners.get(String(id))?.entry ?? null,
    lookup(id, text) {
      const entry = winners.get(String(id))?.entry ?? null;
      return entry && isEntryFresh(entry, text) ? entry : null;
    },
    ids: () => [...winners.keys()],
    idsForEntity: (name) => ids(byEntity.get(normalizeEnrichmentName(name))),
    idsAbout: (name) => ids(byPerson.get(normalizeEnrichmentName(name))),
    idsForFacet: (facet) => ids(byFacet.get(String(facet ?? "").trim().toLowerCase())),
    idsAboutFacet: (name, facet) => ids(byPersonFacet.get(pairKey(normalizeEnrichmentName(name), String(facet ?? "").trim().toLowerCase()))),
    idsWithEvent: () => [...withEvent],
    eventsOverlapping(fromMs, untilMs) {
      if (!Number.isFinite(fromMs) || !Number.isFinite(untilMs) || untilMs <= fromMs) return [];
      if (!sortedEvents) {
        sortedEvents = [...withEvent].map((id) => winners.get(id).entry).map((e) => [e.event.fromMs, e.event.untilMs, e.id]).sort((a, b) => a[0] - b[0]);
      }
      // Events starting before untilMs, binary search on the sorted starts.
      let lo = 0;
      let hi = sortedEvents.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedEvents[mid][0] < untilMs) lo = mid + 1; else hi = mid;
      }
      const out = [];
      for (let i = 0; i < lo; i++) if (sortedEvents[i][1] > fromMs) out.push(sortedEvents[i][2]);
      return out;
    },
    entityDocFreq: (name) => byEntity.get(normalizeEnrichmentName(name))?.size ?? 0,
    personDocFreq: (name) => byPerson.get(normalizeEnrichmentName(name))?.size ?? 0,
    hubEntities: (opts) => hubs(byEntity, opts),
    hubPersons: (opts) => hubs(byPerson, opts),
    vocabulary: () => ({ entities: [...byEntity.keys()], persons: [...byPerson.keys()] }),
  };
}

const states = new Map();
const drains = new Map();
let generation = 0;

const stateKey = (list, minEnrichVersion) => JSON.stringify([list, minEnrichVersion]);
const fileList = (files) => (Array.isArray(files) ? files : [files]).filter(Boolean).map(String);

function freshState(files, minEnrichVersion) {
  return {
    minEnrichVersion,
    files: files.map((path) => ({ path, identity: null, seq: 0, caughtUp: false })),
    index: createEnrichmentIndex(),
    stats: { lines: 0, invalid: 0, parseErrors: 0, oldVersion: 0, rebuilds: 0 },
  };
}

/**
 * Index over one or more sidecar files, refreshed incrementally on each call
 * (cached per file list). Reads at most `maxBytesPerRefresh` bytes per call;
 * `complete` is false until every file has been read to its end.
 *
 * @param {string[]} files sidecar files in tie-break order (e.g. [backfill, live])
 * @param {{maxBytesPerRefresh?: number, minEnrichVersion?: number, logger?: object}} [opts]
 * @returns {{index: ReturnType<typeof createEnrichmentIndex>, complete: boolean,
 *   stats: {lines: number, invalid: number, parseErrors: number, oldVersion: number, rebuilds: number,
 *   files: Array<{path: string, offset: number, size: number}>}}}
 */
export function loadEnrichmentIndex(files, { maxBytesPerRefresh = ENRICH_REFRESH_MAX_BYTES, minEnrichVersion = 1, logger = null } = {}) {
  const list = fileList(files);
  const key = stateKey(list, minEnrichVersion);
  let state = states.get(key);
  const identities = list.map((path) => journalIdentity(path));
  const rewritten = state && state.files.some((file, i) => file.identity && (!identities[i] || !journalOnlyGrew(file.identity, identities[i])));
  if (!state || rewritten) {
    const rebuilds = state ? state.stats.rebuilds + 1 : 0;
    state = freshState(list, minEnrichVersion);
    state.stats.rebuilds = rebuilds;
    states.set(key, state);
  }
  let budget = Math.max(1, Number(maxBytesPerRefresh) || ENRICH_REFRESH_MAX_BYTES);
  let complete = true;
  let invalidNow = 0;
  state.files.forEach((file, fileIndex) => {
    const identity = identities[fileIndex];
    if (!identity) { file.caughtUp = true; return; }
    const offset = file.identity ? file.identity.size : 0;
    if (identity.size <= offset) { file.identity = { ...identity, size: offset }; file.caughtUp = true; return; }
    if (budget <= 0) { complete = false; return; }
    let end = Math.min(identity.size, offset + budget);
    let read;
    try {
      read = readJsonlRange(file.path, offset, end);
      // A line longer than the budget: widen the window until it ends,
      // rather than stall on it forever.
      while (read.nextOffset === offset && end < identity.size) {
        end = Math.min(identity.size, offset + (end - offset) * 2);
        read = readJsonlRange(file.path, offset, end);
      }
    } catch (error) {
      safeWarn(logger, "enrichment-sidecar", error, { file: basename(file.path) });
      complete = false;
      return;
    }
    for (const record of read.records) {
      file.seq++;
      state.stats.lines++;
      if (record?.__parseError) { state.stats.parseErrors++; invalidNow++; continue; }
      const projected = projectEnrichmentEntry(record);
      if (!projected.ok) { state.stats.invalid++; invalidNow++; continue; }
      if (projected.entry.enrichVersion < state.minEnrichVersion) { state.stats.oldVersion++; continue; }
      state.index.offer(projected.entry, fileIndex, file.seq);
    }
    budget -= read.nextOffset - offset;
    // Size = parsed bytes: a half-written last line is read again next time.
    file.identity = { ...identity, size: read.nextOffset };
    file.caughtUp = end >= identity.size;
    if (!file.caughtUp) complete = false;
  });
  if (invalidNow > 0) logger?.debug?.(`plur1bus-enrich: skipped ${invalidNow} unreadable sidecar line(s)`);
  return {
    index: state.index,
    complete,
    stats: {
      ...state.stats,
      files: state.files.map((file, i) => ({ path: file.path, offset: file.identity?.size ?? 0, size: identities[i]?.size ?? 0 })),
    },
  };
}

/**
 * Reads the rest of a partly loaded sidecar off the recall path: one
 * loadEnrichmentIndex refresh per event-loop turn (setImmediate) until the
 * index is complete, a refresh makes no progress (read error), the round
 * limit is hit or resetEnrichmentIndexes runs. At most one drain per file
 * list; a second call returns the running one. Never rejects.
 *
 * @param {string[]} files same list and order as for loadEnrichmentIndex
 * @param {{maxBytesPerRefresh?: number, minEnrichVersion?: number, logger?: object, maxRounds?: number}} [opts]
 * @returns {Promise<{complete: boolean, rounds: number, stopped?: string}>}
 */
export function drainEnrichmentIndex(files, { maxRounds = ENRICH_DRAIN_MAX_ROUNDS, ...opts } = {}) {
  const list = fileList(files);
  const key = stateKey(list, opts.minEnrichVersion ?? 1);
  const running = drains.get(key);
  if (running) return running;
  const started = generation;
  let promise = null;
  promise = (async () => {
    let rounds = 0;
    let lastOffsets = null;
    try {
      for (;;) {
        await new Promise((resolve) => { setImmediate(resolve); });
        if (started !== generation) return { complete: false, rounds, stopped: "reset" };
        const loaded = loadEnrichmentIndex(list, opts);
        rounds++;
        if (loaded.complete) return { complete: true, rounds };
        const offsets = loaded.stats.files.map((file) => file.offset).join(",");
        if (offsets === lastOffsets) return { complete: false, rounds, stopped: "no-progress" };
        lastOffsets = offsets;
        if (rounds >= maxRounds) return { complete: false, rounds, stopped: "max-rounds" };
      }
    } catch (error) {
      safeDebug(opts.logger, "enrichment-sidecar.drain", error);
      return { complete: false, rounds, stopped: "error" };
    } finally {
      if (drains.get(key) === promise) drains.delete(key);
    }
  })();
  drains.set(key, promise);
  return promise;
}

/** Test hook: forget every cached sidecar index and stop running drains. */
export function resetEnrichmentIndexes() {
  generation++;
  states.clear();
  drains.clear();
}
