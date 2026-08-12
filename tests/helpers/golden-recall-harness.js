/**
 * tests/helpers/golden-recall-harness.js
 *
 * Deterministic helpers for recall golden-set / behavioral regression tests.
 * No live LLM, no live DB, no randomness.
 */

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VECTOR_DIM = 4;

const MS_PER_DAY = 86400000;

/**
 * Deterministic string hash → unit vector.
 * Stable across runs and platforms because it uses only integer arithmetic.
 */
export function vectorFor(text, dim = VECTOR_DIM) {
  const str = String(text ?? "");
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const vec = [];
  for (let i = 0; i < dim; i++) {
    let h = hash;
    h ^= i;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = h ^ (h >>> 16);
    vec.push((h >>> 0) / 0xffffffff);
  }
  return normalizeVector(vec);
}

export function normalizeVector(v) {
  const len = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  if (len === 0) return Array(v.length).fill(0);
  return v.map(x => x / len);
}

export function cosineBetween(a, b) {
  return a.reduce((sum, x, i) => sum + x * b[i], 0);
}

/**
 * Deterministic embedding provider.
 * Pass `cache: { "some text": [0.1, 0.2, ...] }` to override vectors for
 * specific inputs (useful for canonical search score fixtures).
 */
export function makeEmbeddings(overrides = {}) {
  const dim = overrides.dim ?? VECTOR_DIM;
  const cache = overrides.cache ?? {};
  async function embed(text) {
    const key = String(text ?? "");
    if (cache[key]) return cache[key];
    return vectorFor(key, dim);
  }
  return {
    dim,
    embed,
    embedQuery: embed,
  };
}

/**
 * Row factory. Matches the shape expected by `runRecallPipeline` mocks.
 */
export function makeRow(opts) {
  return {
    id: opts.id,
    text: opts.text ?? "",
    summary: opts.summary ?? "",
    category: opts.category ?? "fact",
    origin: opts.origin ?? "dm",
    status: opts.status ?? "active",
    importance: opts.importance ?? 0.5,
    memoryStrength: opts.memoryStrength ?? 1.0,
    memoryClass: opts.memoryClass ?? null,
    emotionalIntensity: opts.emotionalIntensity ?? 0,
    _distance: opts.distance ?? opts._distance ?? 0,
    coreMemoryScore: opts.coreMemoryScore ?? 0,
    versionNumber: opts.versionNumber ?? 1,
    versionCreatedAt: opts.versionCreatedAt ?? null,
    updateSource: opts.updateSource ?? null,
    supersededBy: opts.supersededBy ?? null,
    createdAt: opts.createdAt ?? Date.now(),
    agentId: opts.agentId ?? opts.agent_id ?? null,
    agent_id: opts.agent_id ?? opts.agentId ?? null,
    workspaceId: opts.workspaceId ?? opts.workspace_id ?? null,
    workspace_id: opts.workspace_id ?? opts.workspaceId ?? null,
    epistemicStatus: opts.epistemicStatus ?? "",
  };
}

/**
 * Mock LanceDB table.
 * `vectorSearch().limit().toArray()` returns `vectorRows`.
 * `query().where().limit().toArray()` filters `queryRows` (defaults to
 * `vectorRows`) by `id = 'x'` or `id IN ('a','b')`.
 */
export function mockTable(vectorRows = [], queryRows = null) {
  const lookupRows = queryRows ?? vectorRows;
  function matchRows(whereClause) {
    if (typeof whereClause !== "string") return lookupRows;
    const eqMatch = whereClause.match(/^id\s*=\s*['"]([^'"]+)['"]$/i);
    if (eqMatch) return lookupRows.filter(r => r.id === eqMatch[1]);
    const inMatch = whereClause.match(/^id\s+IN\s*\((.+)\)$/i);
    if (inMatch) {
      const ids = new Set(inMatch[1].match(/'([^']*)'/g)?.map(s => s.slice(1, -1)) ?? []);
      return lookupRows.filter(r => ids.has(r.id));
    }
    return lookupRows;
  }
  return {
    vectorSearch() {
      return {
        limit() {
          return { async toArray() { return vectorRows; } };
        },
      };
    },
    query() {
      return {
        where(whereClause) {
          return {
            limit() {
              return { async toArray() { return matchRows(whereClause); } };
            },
          };
        },
      };
    },
  };
}

/**
 * Create a temporary workspace directory containing `memory/KNOWLEDGE.md`.
 * `sections` is an array of `{ heading, text }` objects.
 * Returns the workspace directory path. Caller must clean up with
 * `rmSync(dir, { recursive: true })`.
 */
export function makeKnowledgeDirSync(sections) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "golden-knowledge-"));
  const memoryDir = join(workspaceDir, "memory");
  mkdirSync(memoryDir, { recursive: true });
  const lines = [];
  for (const sec of sections) {
    lines.push(`# ${sec.heading}`);
    lines.push("");
    lines.push(sec.text);
    lines.push("");
  }
  writeFileSync(join(memoryDir, "KNOWLEDGE.md"), lines.join("\n"), "utf8");
  return workspaceDir;
}

/**
 * Assert that `results` (pipeline output) contains exactly `ids` in order.
 */
export function expectOrderedIds(results, ids) {
  const actual = results.map(r => r.entry?.id ?? r.id);
  if (actual.length !== ids.length) {
    throw new Error(`expected ${ids.length} results [${ids.join(", ")}], got ${actual.length} [${actual.join(", ")}]`);
  }
  for (let i = 0; i < ids.length; i++) {
    if (actual[i] !== ids[i]) {
      throw new Error(`expected id #${i} to be "${ids[i]}", got "${actual[i]}"; full order: [${actual.join(", ")}]`);
    }
  }
}

/**
 * Assert that trace summary counters match `expected`.
 */
export function expectTraceSummary(trace, expected) {
  const summary = trace?.summary ?? {};
  for (const key of Object.keys(expected)) {
    const actual = summary[key] ?? 0;
    if (actual !== expected[key]) {
      throw new Error(`expected trace.summary.${key}=${expected[key]}, got ${actual}`);
    }
  }
}

/**
 * Assert score is within epsilon.
 */
export function expectScore(actual, expected, epsilon = 1e-9) {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`expected score ${expected} ±${epsilon}, got ${actual}`);
  }
}

/**
 * Clean up a temp directory created by `makeKnowledgeDirSync`.
 */
export function cleanupDir(dir) {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

export { MS_PER_DAY };
