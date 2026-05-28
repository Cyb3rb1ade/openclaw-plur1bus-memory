/**
 * lib/score.js — Distance→Score-Konvertierung für LanceDB-Vektorsuche.
 *
 * Eine Quelle der Wahrheit für Plugin und alle Cron-Scripts. Vorher gab es
 * 5 unterschiedliche Implementierungen mit teilweise falschen Formeln
 * (1 - distance gibt für L2 > 1 negative Scores).
 */

/**
 * Konvertiert eine LanceDB-Distanz in einen Similarity-Score in [0, 1].
 * Für L2-Distanz: distance=0 → score=1.0, distance=1 → score=0.5,
 * distance=∞ → score→0. Begrenzt nach unten auf 0.
 */
export function distanceToScore(distance) {
  return 1 / (1 + (distance ?? 0));
}
