/**
 * Pure helpers for resolving contradictions between factual memory texts.
 */

const AUTHORITATIVE_SOURCES = new Set(["user_correction", "telegram:/correct"]);

function isActive(m) {
  return m.status === "active" ? 1 : 0;
}

function isAuthoritative(m) {
  return AUTHORITATIVE_SOURCES.has(m.updateSource) ? 1 : 0;
}

function getVersionTime(m) {
  return m.versionCreatedAt ?? m.createdAt ?? 0;
}

/**
 * Compare two memory versions using strict lexicographic ordering.
 * Returns a positive number if a is preferred over b, negative if b is
 * preferred over a, and 0 if they are equivalent under the ranking rules.
 *
 * Ordering (descending):
 * 1. Higher versionNumber wins.
 * 2. If equal, active status wins.
 * 3. If equal, authoritative updateSource wins.
 * 4. If equal, more recent versionCreatedAt (fallback createdAt) wins.
 * 5. Otherwise equivalent.
 */
export function compareMemoryVersions(a, b) {
  const versionA = a.versionNumber ?? 1;
  const versionB = b.versionNumber ?? 1;
  if (versionA !== versionB) return versionA - versionB;

  const activeA = isActive(a);
  const activeB = isActive(b);
  if (activeA !== activeB) return activeA - activeB;

  const authA = isAuthoritative(a);
  const authB = isAuthoritative(b);
  if (authA !== authB) return authA - authB;

  const timeA = getVersionTime(a);
  const timeB = getVersionTime(b);
  if (timeA !== timeB) return timeA - timeB;

  return 0;
}

export function resolveContradictionWinner(a, b) {
  const cmp = compareMemoryVersions(a, b);
  if (cmp > 0) return a;
  if (cmp < 0) return b;
  return a;
}

export function rankMemoryVersions(memories) {
  return [...memories].sort((a, b) => compareMemoryVersions(b, a));
}
