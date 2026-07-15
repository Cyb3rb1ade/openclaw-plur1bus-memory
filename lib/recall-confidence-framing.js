/**
 * lib/recall-confidence-framing.js — Unsicherheits-Hedging nach Recall-Score.
 *
 * Markiert die relativ schwächsten Recall-Treffer (unteres Drittel der
 * Score-Verteilung, max. 2 pro Antwort) mit `recallUncertain: true`.
 * Die Textdarstellung übernimmt lib/relevant-memory-context.js
 * (uncertain="true"-Attribut + globale Instruktion, analog faded).
 *
 * Pure, fail-open, mutiert nie die Original-Items. Relative Schwelle statt
 * absoluter Zahl — robust gegenüber Provider-/Score-Skalen-Unterschieden.
 *
 * opts.minSpread (default 0.1): Mindestabstand zwischen top- und cut-Score,
 * damit überhaupt gehedgt wird. Verhindert Phantom-Hedging, wenn alle
 * Treffer eng beieinander und durchweg stark sind (z.B. 0.95/0.93/0.90 —
 * rein relativ wäre das untere Drittel "unsicher", obwohl alle drei stark
 * sind). minSpread: 0 stellt das rein relative Alt-Verhalten wieder her.
 *
 * opts.absoluteFloor (default 0.4): Escape-Hatch für den minSpread-Gate.
 * Der Graph-Recall-Pfad liefert routinemäßig eng gebündelte Score-Sets
 * (z.B. 0.95/0.94/0.93/0.92), bei denen minSpread jedes Hedging
 * unterdrückt — auch wenn die Treffer absolut betrachtet schwach sind
 * (z.B. 0.38/0.36/0.35, alle < absoluteFloor). Items mit
 * relevanceScore < absoluteFloor bleiben hedge-eligible, selbst wenn der
 * Spread unter minSpread liegt — schwache Treffer in absoluten Zahlen sind
 * genau der Fall, für den Hedging gedacht ist. Die minSpread-Schranke
 * bleibt für uniform starke Sets in Kraft; bottom-third/maxHedged-Cap
 * bestimmt weiterhin, WELCHE der eligible Items markiert werden.
 * absoluteFloor: 0 deaktiviert den Escape-Hatch (reines minSpread-Verhalten).
 */

export function frameRecallConfidence(memories, opts = {}) {
  const passthrough = { items: Array.isArray(memories) ? memories : [], hedgedIds: [] };
  try {
    const { minItems = 3, bottomFraction = 1 / 3, maxHedged = 2, minSpread = 0.1, absoluteFloor = 0.4 } = opts;
    if (!Array.isArray(memories) || memories.length < minItems) return passthrough;

    const scored = memories.filter((m) => Number.isFinite(m?.relevanceScore));
    if (scored.length < minItems) return passthrough;

    const scores = scored.map((m) => m.relevanceScore).sort((a, b) => a - b);
    const cut = scores[Math.max(0, Math.ceil(scores.length * bottomFraction) - 1)];
    const top = scores[scores.length - 1];
    if (!(top > cut)) return passthrough; // kein Spread → nichts hedgen

    const bottomThird = scored.filter((m) => m.relevanceScore <= cut);
    const spreadOk = top - cut >= minSpread;
    // Spread zu klein: nur absolut schwache Items (< absoluteFloor) bleiben
    // hedge-eligible (Escape-Hatch); sonst nichts hedgen.
    const eligible = spreadOk
      ? bottomThird
      : bottomThird.filter((m) => m.relevanceScore < absoluteFloor);
    if (eligible.length === 0) return passthrough;

    const hedgedIds = eligible
      .sort((a, b) => a.relevanceScore - b.relevanceScore)
      .slice(0, maxHedged)
      .map((m) => m.id);
    const hedgedSet = new Set(hedgedIds);

    const items = memories.map((m) => (hedgedSet.has(m?.id) ? { ...m, recallUncertain: true } : m));
    return { items, hedgedIds };
  } catch (_) {
    return passthrough;
  }
}
