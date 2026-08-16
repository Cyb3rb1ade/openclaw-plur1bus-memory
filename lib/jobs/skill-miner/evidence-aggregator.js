/**
 * lib/jobs/skill-miner/evidence-aggregator.js
 *
 * Extracts keywords from memory objects, clusters them by Jaccard keyword
 * overlap, and computes an evidence score per cluster.
 */

import { createHash } from "node:crypto";
import { checkAccess, validateOwnershipTuple } from "../../acl-middleware.js";
import { normalizeEpistemicStatus } from "../../epistemic-status.js";
import { isCreatedAtBeforeCutoff } from "../../epistemic-cutoff.js";
import { jaccardSimilarity } from "../../text-utils.js";

const SKILL_OWNERSHIP_SCOPES = new Set(["agent-private", "workspace", "user"]);
const EMPTY_WORKSPACE_ALIASES = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });

function partitionCandidate(bindings) {
  const workspaceIdentity = bindings?.workspaceIdentity
    || bindings?.workspaceId
    || bindings?.workspaceKey
    || "";
  return {
    scope: bindings?.scope,
    agentId: bindings?.agentId || "",
    storedBy: bindings?.storedBy || bindings?.agentId || "",
    workspaceId: workspaceIdentity,
    workspaceKey: workspaceIdentity,
    ownerUserId: bindings?.ownerUserId || "",
  };
}

/**
 * Resolve the exact canonical ownership tuple for a memory row.
 * @param {object} memory Memory row or normalized evidence item.
 * @param {object} [workspaceAliases] Trusted workspace alias snapshot.
 * @returns {{scope: string, agentId: string, workspaceIdentity: string, ownerUserId: string}|null}
 */
export function skillOwnershipTuple(memory, workspaceAliases = EMPTY_WORKSPACE_ALIASES) {
  const scope = memory?.scope || "agent-private";
  if (!SKILL_OWNERSHIP_SCOPES.has(scope)) return null;
  const candidate = memory?.workspaceIdentity && memory?.workspaceId === undefined && memory?.workspaceKey === undefined
    ? partitionCandidate(memory)
    : memory;
  const ownership = validateOwnershipTuple(candidate, workspaceAliases);
  if (!ownership.ok) return null;
  return Object.freeze({
    scope,
    agentId: ownership.bindings.agentId,
    workspaceIdentity: ownership.bindings.workspaceIdentity,
    ownerUserId: ownership.bindings.ownerUserId,
  });
}

/**
 * Compare two rows using their normalized canonical ownership tuple.
 * @param {object} left First memory row.
 * @param {object} right Second memory row or partition.
 * @param {object} [workspaceAliases] Trusted workspace alias snapshot.
 * @returns {boolean} Whether both values belong to the exact same tuple.
 */
export function sameSkillOwnershipTuple(left, right, workspaceAliases = EMPTY_WORKSPACE_ALIASES) {
  const a = skillOwnershipTuple(left, workspaceAliases);
  const b = skillOwnershipTuple(right, workspaceAliases);
  return Boolean(a && b
    && a.scope === b.scope
    && a.agentId === b.agentId
    && a.workspaceIdentity === b.workspaceIdentity
    && a.ownerUserId === b.ownerUserId);
}

/**
 * Build one authorized skill-miner partition for a canonical request context.
 * @param {object} bindings Requested canonical ownership bindings.
 * @param {object} requestContext Canonical authenticated memory context.
 * @returns {object} Normalized partition with a stable key.
 */
export function buildSkillMiningPartition(bindings, requestContext) {
  const candidate = partitionCandidate(bindings);
  if (!SKILL_OWNERSHIP_SCOPES.has(candidate.scope)) {
    throw new Error("invalid skill-miner ACL partition scope");
  }
  const workspaceAliases = requestContext?.workspaceAliases || EMPTY_WORKSPACE_ALIASES;
  const normalized = skillOwnershipTuple(candidate, workspaceAliases);
  if (!normalized || !checkAccess(requestContext, candidate).allowed) {
    throw new Error("invalid skill-miner ACL partition binding");
  }
  const key = createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 20);
  return Object.freeze({ ...normalized, key });
}

/**
 * Check whether one row belongs to an authorized skill-miner partition.
 * @param {object} memory Memory row.
 * @param {object} requestContext Canonical authenticated memory context.
 * @param {object} partition Normalized partition.
 * @returns {boolean} Whether ACL and exact tuple checks both pass.
 */
export function isSkillMemoryInPartition(memory, requestContext, partition) {
  if (!requestContext || !partition) return false;
  const aliases = requestContext.workspaceAliases || EMPTY_WORKSPACE_ALIASES;
  return checkAccess(requestContext, memory).allowed
    && sameSkillOwnershipTuple(memory, partitionCandidate(partition), aliases);
}

function rawEpistemicStatus(row) {
  return row?.epistemicStatus == null ? "" : String(row.epistemicStatus);
}

function isLegacyEmptyStatus(raw) {
  return raw === "";
}

/**
 * Whether a LanceDB memory is sufficiently reviewed to earn the trust bonus.
 * @param {object} row memory or normalized evidence row
 * @returns {boolean}
 */
export function isTrustedSkillEvidence(row) {
  return ["corroborated", "trusted"].includes(
    normalizeEpistemicStatus(row?.epistemicStatus),
  );
}

/**
 * Whether a row may enter skill-proposal clustering.
 * Uses the raw stored status so legacy "" is not collapsed to untrusted.
 * @param {object} row
 * @param {{cutoff?: number, legacyOpen?: boolean}} [opts]
 * @returns {boolean}
 */
export function isAdmissibleSkillEvidence(row, opts = {}) {
  const raw = rawEpistemicStatus(row);
  if (raw === "untrusted" || raw === "disputed" || raw === "invalidated") return false;
  if (raw === "observed" || raw === "corroborated" || raw === "trusted") return true;
  if (!isLegacyEmptyStatus(raw)) return false;
  if (opts.legacyOpen !== true) return false;
  const role = String(row?.sourceMessageRole || "");
  if (role !== "user" && role !== "") return false;
  return isCreatedAtBeforeCutoff(row?.createdAt, opts.cutoff);
}

const GRADE_RANK = Object.freeze({
  "unreviewed-legacy-norole": 0,
  "unreviewed-legacy": 1,
  observed: 2,
  corroborated: 3,
  trusted: 4,
});

/**
 * Weakest evidence grade in a cluster.
 * @param {object[]} memories
 * @returns {string}
 */
export function skillEvidenceGrade(memories = []) {
  let weakest = "trusted";
  let weakestRank = GRADE_RANK.trusted;
  for (const row of memories) {
    const raw = rawEpistemicStatus(row);
    let grade;
    if (isLegacyEmptyStatus(raw)) {
      grade = String(row?.sourceMessageRole || "") === ""
        ? "unreviewed-legacy-norole"
        : "unreviewed-legacy";
    } else if (raw === "observed") grade = "observed";
    else if (raw === "corroborated") grade = "corroborated";
    else if (raw === "trusted") grade = "trusted";
    else continue;
    const rank = GRADE_RANK[grade];
    if (rank < weakestRank) {
      weakest = grade;
      weakestRank = rank;
    }
  }
  return weakest;
}

function extractKeywords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\wäöüß\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4);
}

/**
 * Aggregate memories into evidence groups based on keyword overlap.
 *
 * @param {Array<{id, text, category, origin, epistemicStatus, retrievalCount, contradictory}>} memories
 * @param {{trustedOnly?: boolean, workspaceAliases?: object, requestContext?: object, aclPartition?: object}} [options]
 * @returns {Array<{memories, keywords, score, topics, ownership}>}
 */
export function aggregateEvidence(memories, options = {}) {
  if (!memories || memories.length === 0) return [];

  const workspaceAliases = options.workspaceAliases || EMPTY_WORKSPACE_ALIASES;
  const trustedOnly = options.trustedOnly === true;
  const authorized = (memory) => !options.requestContext
    ? true
    : Boolean(options.aclPartition && isSkillMemoryInPartition(memory, options.requestContext, options.aclPartition));

  // 1. Build keyword sets for each memory
  const items = memories.map(m => ({
    memory: m,
    keywords: extractKeywords(m.text),
    ownership: skillOwnershipTuple(m, workspaceAliases),
  })).filter(item => item.keywords.length > 0
    && item.ownership
    && authorized(item.memory)
    && (!trustedOnly || isTrustedSkillEvidence(item.memory)));

  // 2. Cluster by connected components where keyword Jaccard overlap >= 0.4
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(i) {
    if (parent[i] !== i) parent[i] = find(parent[i]);
    return parent[i];
  }

  function union(i, j) {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const setA = new Set(items[i].keywords);
      const setB = new Set(items[j].keywords);
      const intersection = items[i].keywords.filter(k => setB.has(k));
      const keywordUnion = [...new Set([...items[i].keywords, ...items[j].keywords])];
      const jaccard = intersection.length / keywordUnion.length;
      if (jaccard >= 0.4 && sameSkillOwnershipTuple(items[i].memory, items[j].memory, workspaceAliases)) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[i]);
  }

  // 3. Compute scores and build result
  const results = [];
  for (const groupItems of groups.values()) {
    const groupMemories = groupItems.map(g => g.memory);

    // Aggregate keywords by frequency
    const freq = new Map();
    for (const gi of groupItems) {
      for (const kw of gi.keywords) {
        freq.set(kw, (freq.get(kw) || 0) + 1);
      }
    }
    const sortedKeywords = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kw]) => kw);

    let score = 0;
    for (const m of groupMemories) {
      score += 1; // +1 per memory
      if (isTrustedSkillEvidence(m)) {
        score += 2;
      }
      if (["workspace_rule", "user_preference"].includes(m.category)) {
        score += 1;
      }
      if ((m.retrievalCount || 0) >= 3) {
        score += 1;
      }
      if (m.contradictory === true) {
        score -= 1;
      }
    }

    if (score < 1) continue;

    results.push({
      memories: groupMemories,
      keywords: sortedKeywords,
      score,
      topics: sortedKeywords.slice(0, 5),
      ownership: skillOwnershipTuple(groupMemories[0], workspaceAliases),
    });
  }

  return results;
}
