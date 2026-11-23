/**
 * Writer for `.plur1bus/semantic-lens-index.json`, the precomputed community
 * index the Semantic Lens recall booster reads (lib/semantic-lens-index.js).
 *
 * Until 7.20.3 nothing produced this file: the reader shipped in 6.6.0, the
 * three live indexes were generated once by hand on 2026-06-14, and the 6.8.7
 * changelog wrongly listed it as part of the nightly semantic discovery.
 *
 * The writer needs no searches of its own. The nightly discovery already stores
 * each memory's nearest neighbours in `link-index.json` (`entries[id].similar`);
 * those pairs are the edges of the graph clustered here.
 */
import { join } from "node:path";
import { atomicWriteText } from "./obsidian/safe-paths.js";
import { mutationAllowed } from "./obsidian-mutation-policy.js";

const INDEX_PATH_REL = join(".plur1bus", "semantic-lens-index.json");
const MAX_ITERATIONS = 20;
const MAX_LABEL_VALUES = 5;

export const SEMANTIC_LENS_WRITER_DEFAULTS = Object.freeze({
  minCommunitySize: 2,
  maxRepresentatives: 3,
  maxBridges: 5,
  maxFaded: 3,
});

function ownerOf(record) {
  return String(record.agentId || record.storedBy || "");
}

function createdAtMs(record) {
  const n = Number(record.createdAt);
  return Number.isFinite(n) ? n : 0;
}

function importanceOf(record) {
  const n = Number(record.importance);
  return Number.isFinite(n) ? n : 0.5;
}

/**
 * Undirected adjacency over active memories, from the link index's neighbour lists.
 * Ids missing from `active` (archived, superseded, deleted since) are dropped.
 */
function buildAdjacency(linkEntries, active) {
  const adjacency = new Map();
  const link = (a, b) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a).add(b);
  };
  for (const [id, entry] of Object.entries(linkEntries || {})) {
    if (!active.has(id) || !Array.isArray(entry?.similar)) continue;
    for (const other of entry.similar) {
      if (typeof other !== "string" || other === id || !active.has(other)) continue;
      link(id, other);
      link(other, id);
    }
  }
  return adjacency;
}

/**
 * Deterministic community detection: the local-moving phase of Louvain. Each
 * memory starts alone and moves to the neighbouring community with the largest
 * modularity gain; nodes are visited in id order and ties keep the current
 * community, then the smaller id, so the same graph always yields the same
 * communities. (Plain label propagation with smallest-label ties merges two
 * groups joined by a single edge.)
 *
 * @returns {Map<string, string>} memory id -> community key
 */
function detectCommunities(adjacency) {
  const nodes = [...adjacency.keys()].sort();
  let twoM = 0;
  for (const id of nodes) twoM += adjacency.get(id).size;
  const community = new Map(nodes.map((id) => [id, id]));
  if (twoM === 0) return community;
  const total = new Map(nodes.map((id) => [id, adjacency.get(id).size]));
  for (let round = 0; round < MAX_ITERATIONS; round++) {
    let moved = false;
    for (const id of nodes) {
      const degree = adjacency.get(id).size;
      const current = community.get(id);
      total.set(current, total.get(current) - degree);
      const links = new Map();
      for (const neighbour of adjacency.get(id)) {
        const c = community.get(neighbour);
        links.set(c, (links.get(c) || 0) + 1);
      }
      const gain = (c) => (links.get(c) || 0) - ((total.get(c) || 0) * degree) / twoM;
      let best = current;
      let bestGain = gain(current);
      for (const c of [...links.keys()].sort()) {
        const g = gain(c);
        if (g > bestGain + 1e-12) {
          best = c;
          bestGain = g;
        }
      }
      total.set(best, (total.get(best) || 0) + degree);
      if (best !== current) {
        community.set(id, best);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return community;
}

function distinctValues(values) {
  return [...new Set(values.filter(Boolean))].sort().slice(0, MAX_LABEL_VALUES);
}

/**
 * Build a Semantic Lens index (format version 1) from the link index and the active memories.
 *
 * Roles per community: representatives are the best connected members (then
 * most important); bridges are members with neighbours in other communities;
 * faded candidates are the oldest non-representative members by `createdAt`
 * (the scan carries no retrieval history, so "faded" means old, not unrecalled).
 *
 * @param {{linkIndex: {entries?: object}, records: Array<object>, workspaceId?: string, now?: Date, options?: object}} input
 * @returns {object} Index object as read by loadSemanticLensIndex, plus `stats`.
 */
export function buildSemanticLensIndex({ linkIndex, records, workspaceId = "", now = new Date(), options = {} }) {
  const cfg = { ...SEMANTIC_LENS_WRITER_DEFAULTS, ...options };
  const active = new Map();
  for (const record of records || []) {
    if (record?.id) active.set(String(record.id), record);
  }
  const adjacency = buildAdjacency(linkIndex?.entries, active);
  const label = detectCommunities(adjacency);

  const members = new Map();
  for (const [id, l] of label) {
    if (!members.has(l)) members.set(l, []);
    members.get(l).push(id);
  }

  const communities = {};
  const memoryToCommunity = {};
  let edgeCount = 0;
  for (const set of adjacency.values()) edgeCount += set.size;

  for (const ids of members.values()) {
    if (ids.length < cfg.minCommunitySize) continue;
    ids.sort();
    // The smallest member id names the community, so the id survives nights
    // in which the rest of the membership changes.
    const communityId = `lens-${ids[0]}`;
    const inside = new Set(ids);
    const internalDegree = new Map();
    const externalDegree = new Map();
    for (const id of ids) {
      let internal = 0;
      let external = 0;
      for (const neighbour of adjacency.get(id)) {
        if (inside.has(neighbour)) internal++;
        else external++;
      }
      internalDegree.set(id, internal);
      externalDegree.set(id, external);
      memoryToCommunity[id] = communityId;
    }
    const representatives = [...ids]
      .sort((a, b) => internalDegree.get(b) - internalDegree.get(a)
        || importanceOf(active.get(b)) - importanceOf(active.get(a))
        || (a < b ? -1 : 1))
      .slice(0, cfg.maxRepresentatives);
    const representativeSet = new Set(representatives);
    const bridges = ids
      .filter((id) => externalDegree.get(id) > 0)
      .sort((a, b) => externalDegree.get(b) - externalDegree.get(a) || (a < b ? -1 : 1))
      .slice(0, cfg.maxBridges);
    const faded = ids
      .filter((id) => !representativeSet.has(id))
      .sort((a, b) => createdAtMs(active.get(a)) - createdAtMs(active.get(b))
        || importanceOf(active.get(a)) - importanceOf(active.get(b))
        || (a < b ? -1 : 1))
      .slice(0, cfg.maxFaded);
    const rows = ids.map((id) => active.get(id));
    communities[communityId] = {
      id: communityId,
      size: ids.length,
      representativeMemoryIds: representatives,
      bridgeMemoryIds: bridges,
      fadedCandidateMemoryIds: faded,
      labels: {
        category: distinctValues(rows.map((r) => r.category)),
        scope: distinctValues(rows.map((r) => r.scope || "agent-private")),
        agent: distinctValues(rows.map(ownerOf)),
      },
    };
  }

  return {
    version: 1,
    generatedAt: now.toISOString(),
    workspaceId: String(workspaceId || ""),
    memoryToCommunity,
    communities,
    stats: {
      memories: active.size,
      linkedMemories: adjacency.size,
      edges: edgeCount / 2,
      communities: Object.keys(communities).length,
      members: Object.keys(memoryToCommunity).length,
    },
  };
}

/**
 * Write the Lens index under the same gates as the link index.
 *
 * @param {string} vaultPath Workspace (vault) root; the reader resolves `<workspaceDir>/.plur1bus/`.
 * @param {object} index Result of buildSemanticLensIndex.
 * @param {{mutationPolicy?: object}} [options]
 * @returns {{written: boolean, path?: string, reason?: string}}
 */
export function saveSemanticLensIndex(vaultPath, index, options = {}) {
  if (!mutationAllowed(options.mutationPolicy, "semantic_index_write")
    || !mutationAllowed(options.mutationPolicy, "vault_write")) {
    return { written: false, reason: "mutation_policy_denied" };
  }
  const indexPath = join(vaultPath, INDEX_PATH_REL);
  atomicWriteText(indexPath, JSON.stringify(index));
  return { written: true, path: indexPath };
}
