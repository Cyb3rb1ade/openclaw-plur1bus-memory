// 7.21.4: Existence index of graph edges for the dedupe in the capture path.
//
// The capture path used to read the last 10 000 lines of memory-graph.jsonl
// and build the bound adjacency on every agent_end (bernhardine: 27 433
// lines, 0.3-0.5 s synchronous on the main thread). This index keeps the same
// window of lines per journal and reads only appended lines; a rewritten
// journal (retention, rename, truncation) is read again in full.
import { existsSync } from "node:fs";

import { isBoundGraphEdge } from "./memory-graph.js";
import { journalIdentity, journalOnlyGrew, readJsonlRange } from "./neo-arch.js";

const indexes = new Map();

/**
 * Keys under which readBoundGraph's adjacency would list an edge: bound edges
 * only, undirected ones in both directions.
 *
 * @param {object} edge
 * @returns {string[]}
 */
export function graphEdgeDedupeKeys(edge) {
  if (!edge || edge.__parseError || !edge.source || !edge.target || !isBoundGraphEdge(edge)) return [];
  const keys = [`${edge.source}\u0000${edge.target}\u0000${edge.type}`];
  if (!edge.directed) keys.push(`${edge.target}\u0000${edge.source}\u0000${edge.type}`);
  return keys;
}

function emptyIndex(limit) {
  return { identity: { dev: 0, ino: 0, size: 0, head: "" }, limit, lines: [], start: 0, counts: new Map() };
}

function addLine(index, keys) {
  index.lines.push(keys);
  for (const key of keys) index.counts.set(key, (index.counts.get(key) || 0) + 1);
  while (index.lines.length - index.start > index.limit) {
    for (const key of index.lines[index.start]) {
      const left = (index.counts.get(key) || 0) - 1;
      if (left > 0) index.counts.set(key, left);
      else index.counts.delete(key);
    }
    index.lines[index.start] = null;
    index.start++;
  }
  if (index.start > 4096 && index.start * 2 > index.lines.length) {
    index.lines = index.lines.slice(index.start);
    index.start = 0;
  }
}

/**
 * Edge existence over the last `limit` lines of the store's graph journal, or
 * null when the store still has a legacy graph file (the caller then uses
 * readGraphEdges + readBoundGraph as before).
 *
 * @param {{paths?: object, legacyPaths?: object}} neoStore createNeoStore result
 * @param {number} [limit] lines in the window, default 10 000
 * @returns {{has: (source: string, target: string, type: string) => boolean, lines: number}|null}
 */
export function graphEdgeExistenceIndex(neoStore, limit = 10_000) {
  const path = neoStore?.paths?.graph;
  if (!path) return null;
  const legacy = neoStore?.legacyPaths?.graph;
  if (legacy && legacy !== path && existsSync(legacy)) return null;
  const identity = journalIdentity(path);
  let index = indexes.get(path);
  if (!identity) {
    index = emptyIndex(limit);
    indexes.delete(path);
  } else {
    if (!index || index.limit !== limit || !journalOnlyGrew(index.identity, identity)) index = emptyIndex(limit);
    if (identity.size > index.identity.size) {
      const { records, nextOffset } = readJsonlRange(path, index.identity.size, identity.size);
      for (const record of records) addLine(index, graphEdgeDedupeKeys(record));
      // A half-written last line is read again next time.
      index.identity = { ...identity, size: nextOffset };
    } else {
      index.identity = identity;
    }
    indexes.set(path, index);
  }
  const counts = index.counts;
  return {
    has: (source, target, type) => counts.has(`${source}\u0000${target}\u0000${type}`),
    lines: index.lines.length - index.start,
  };
}

/** Test hook: forget every cached index. */
export function resetGraphEdgeIndexes() {
  indexes.clear();
}
