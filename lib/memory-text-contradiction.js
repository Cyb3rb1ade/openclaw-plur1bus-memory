/**
 * Pure helpers for resolving contradictions between factual memory texts.
 */

const AUTHORITATIVE_SOURCES = new Set(["user_correction", "telegram:/correct"]);

function correctionAuthority(m) {
  let score = 0;
  if (m.status === "active") score += 10;
  score += (m.versionNumber ?? 1) * 2;
  if (AUTHORITATIVE_SOURCES.has(m.updateSource)) score += 5;
  score += Math.max(0, Math.min(5, (m.reconsolidationConfidence ?? 0) * 5));
  return score;
}

export function resolveContradictionWinner(a, b) {
  const authA = correctionAuthority(a);
  const authB = correctionAuthority(b);
  if (authA !== authB) return authA > authB ? a : b;
  const timeA = a.versionCreatedAt ?? a.createdAt ?? 0;
  const timeB = b.versionCreatedAt ?? b.createdAt ?? 0;
  if (timeA !== timeB) return timeA > timeB ? a : b;
  return a;
}

export function rankMemoryVersions(memories) {
  return [...memories].sort((a, b) => {
    const authA = correctionAuthority(a);
    const authB = correctionAuthority(b);
    if (authA !== authB) return authB - authA;
    const timeA = a.versionCreatedAt ?? a.createdAt ?? 0;
    const timeB = b.versionCreatedAt ?? b.createdAt ?? 0;
    return timeB - timeA;
  });
}
