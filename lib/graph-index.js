/**
 * In-memory Index für Memory-Graph-Edges.
 *
 * @param {Array<{id, type, source, target, weight, ...}>} edges
 * @returns {Object} Index-Objekt mit byType, byTarget, bySource, byTypeAndTarget
 */
export function buildGraphIndex(edges) {
  const byType = new Map();
  const byTarget = new Map();
  const bySource = new Map();
  const byTypeAndTarget = new Map();

  for (const edge of edges) {
    // byType
    const typeList = byType.get(edge.type);
    if (typeList) {
      typeList.push(edge);
    } else {
      byType.set(edge.type, [edge]);
    }

    // byTarget
    const targetList = byTarget.get(edge.target);
    if (targetList) {
      targetList.push(edge);
    } else {
      byTarget.set(edge.target, [edge]);
    }

    // bySource
    const sourceList = bySource.get(edge.source);
    if (sourceList) {
      sourceList.push(edge);
    } else {
      bySource.set(edge.source, [edge]);
    }

    // byTypeAndTarget
    const typeAndTargetKey = `${edge.type}:${edge.target}`;
    const typeAndTargetList = byTypeAndTarget.get(typeAndTargetKey);
    if (typeAndTargetList) {
      typeAndTargetList.push(edge);
    } else {
      byTypeAndTarget.set(typeAndTargetKey, [edge]);
    }
  }

  return {
    byType,
    byTarget,
    bySource,
    byTypeAndTarget,
    _all: edges,
  };
}

/**
 * Query den Graph-Index.
 *
 * @param {Object} index – Rückgabe von buildGraphIndex
 * @param {Object} filters – { type?, target?, source? }
 * @returns {Array} Array von Edges
 */
export function queryGraphIndex(index, { type, target, source } = {}) {
  if (type !== undefined && target !== undefined) {
    return index.byTypeAndTarget.get(`${type}:${target}`) ?? [];
  }
  if (type !== undefined) {
    return index.byType.get(type) ?? [];
  }
  if (target !== undefined) {
    return index.byTarget.get(target) ?? [];
  }
  if (source !== undefined) {
    return index.bySource.get(source) ?? [];
  }
  return index._all ?? [];
}
