export function scoreEvidence(item = {}) {
  const trust = String(item.trustLevel || item.sourceTrust || item.origin?.trustLevel || item.origin || "").toLowerCase();
  const evidenceCount = Array.isArray(item.evidence) ? item.evidence.length : Array.isArray(item.sourceRefs) ? item.sourceRefs.length : 0;
  let score = 0.3 + Math.min(evidenceCount, 3) * 0.15;
  if (/user|tool|system|curated/.test(trust)) score += 0.25;
  if (/assistant|obsidian_untrusted|unknown/.test(trust)) score -= 0.2;
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

export function evidenceRisk(item = {}) {
  const score = scoreEvidence(item);
  if (score < 0.35) return "high";
  if (score < 0.6) return "medium";
  return "low";
}

