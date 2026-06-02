// Phase 8A — Memory History API: Traverse version chains forward and backward.
// ESM-only.

/**
 * Traverses the version chain backward via previousVersion.
 * Returns array of versions from newest to oldest.
 *
 * @param {Object} db — MemoryDB instance with .getById()
 * @param {string} id — Start memory ID
 * @param {Object} opts — { maxDepth?, logger? }
 * @returns {Array<{ id, versionNumber, text, updateSource, updateEvidence, versionCreatedAt }>}
 */
export async function getMemoryHistory(db, id, opts = {}) {
  const maxDepth = opts.maxDepth ?? 50;
  const history = [];
  const visited = new Set();
  let currentId = id;
  let depth = 0;

  while (currentId && depth < maxDepth) {
    if (visited.has(currentId)) {
      opts.logger?.warn?.(`[memory-history] Cycle detected at ${currentId}, stopping`);
      break;
    }
    visited.add(currentId);

    const row = await db.getById(currentId);
    if (!row) {
      opts.logger?.warn?.(`[memory-history] Memory ${currentId} not found, stopping`);
      break;
    }

    history.push({
      id: row.id,
      versionNumber: row.versionNumber ?? 1,
      text: row.text || "",
      summary: row.summary || "",
      updateSource: row.updateSource || "",
      updateEvidence: row.updateEvidence || "",
      reconsolidationConfidence: row.reconsolidationConfidence ?? 0,
      status: row.status || "active",
      versionCreatedAt: row.versionCreatedAt ?? 0,
      updatedAt: row.updatedAt ?? 0,
      previousVersion: row.previousVersion || "",
    });

    currentId = row.previousVersion || "";
    depth++;
  }

  return history;
}

/**
 * Finds the current (newest active) version of a memory chain.
 * Traverses forward via supersededBy.
 *
 * @param {Object} db — MemoryDB instance with .getById()
 * @param {string} id — Start memory ID (can be any version in the chain)
 * @param {Object} opts — { maxDepth?, logger? }
 * @returns {Object|null} — The current active row, or null
 */
export async function getMemoryCurrentVersion(db, id, opts = {}) {
  const maxDepth = opts.maxDepth ?? 50;
  const visited = new Set();
  let currentId = id;
  let depth = 0;
  let currentRow = null;

  while (currentId && depth < maxDepth) {
    if (visited.has(currentId)) {
      opts.logger?.warn?.(`[memory-history] Cycle detected at ${currentId}, stopping`);
      break;
    }
    visited.add(currentId);

    const row = await db.getById(currentId);
    if (!row) {
      opts.logger?.warn?.(`[memory-history] Memory ${currentId} not found, stopping`);
      break;
    }

    currentRow = row;

    // If this row has no successor, we're at the current version
    if (!row.supersededBy) {
      break;
    }

    currentId = row.supersededBy;
    depth++;
  }

  return currentRow;
}
