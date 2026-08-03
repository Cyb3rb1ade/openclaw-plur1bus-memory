/**
 * lib/episode-watermark.js — Entscheidungslogik für das agent_end-Watermark.
 *
 * Hintergrund: Light-Dream und Episoden-Extraktion laufen fire-and-forget,
 * das High-Watermark (`lastProcessedMessageCount`) wurde aber synchron
 * hochgezählt. Schlug ein Pfad fehl, lagen dessen Turns anschließend
 * unterhalb des Watermarks und wurden nie wieder betrachtet — dauerhafter
 * Episodenverlust. Im Feld hat das zusammen mit blockierten Write-Locks die
 * Episoden zweier Agenten tagelang stillgelegt.
 *
 * Die beiden Funktionen hier sind bewusst rein: sie treffen die Entscheidung,
 * führen sie aber nicht aus. Damit sind genau die Randfälle testbar, die im
 * Fehlerfall zählen.
 */

/**
 * Entscheidet, ob das Watermark nach der Nachverarbeitung vorrücken darf.
 *
 * @param {Object} params
 * @param {Array<boolean>} params.results — je ein Ergebnis pro Nachverarbeitungspfad
 * @param {number} [params.failures] — bisherige aufeinanderfolgende Fehlversuche
 * @param {number} [params.maxRetries] — ab wann aufgegeben wird
 * @returns {{advance: boolean, nextFailures: number, gaveUp: boolean}}
 */
export function resolveWatermarkAdvance({ results = [], failures = 0, maxRetries = 5 } = {}) {
  const previous = Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0;
  const limit = Number.isFinite(maxRetries) && maxRetries > 0 ? Math.floor(maxRetries) : 1;

  // Kein Pfad gelaufen → nichts kann verloren gehen, Watermark darf vor.
  if (results.length === 0) return { advance: true, nextFailures: 0, gaveUp: false };

  if (results.every(Boolean)) return { advance: true, nextFailures: 0, gaveUp: false };

  const attempt = previous + 1;
  // Sicherheitsventil: Bleibt das Watermark stehen, wird die nächste Slice
  // breiter — ein dauerhaft kaputter Pfad (tote LLM-Route, defekter Store)
  // würde die Kosten sonst unbegrenzt hochtreiben. Irgendwann geben wir den
  // Bereich auf, aber laut und nachvollziehbar statt stillschweigend.
  if (attempt >= limit) return { advance: true, nextFailures: 0, gaveUp: true };

  return { advance: false, nextFailures: attempt, gaveUp: false };
}

/**
 * Verwirft Episoden, deren Turns bereits vollständig episodiert wurden.
 *
 * Dedup läuft über Turn-IDs, NICHT über den Batch-Digest: Bleibt das
 * Watermark nach einem Fehlschlag stehen, ist die nächste Slice breiter und
 * der Digest damit ein anderer — die Turn-IDs bleiben dagegen stabil, solange
 * der Slice-Start gleich bleibt, und genau das garantiert das hängende
 * Watermark.
 *
 * Teilüberlappung bleibt erhalten: eine Episode, die auch nur einen neuen
 * Turn enthält, ist keine Wiederholung.
 *
 * @param {Array<Object>} episodes
 * @param {Set<string>|Array<string>} episodedTurnIds
 * @returns {{fresh: Array<Object>, skipped: number}}
 */
export function filterAlreadyEpisoded(episodes = [], episodedTurnIds = new Set()) {
  const seen = episodedTurnIds instanceof Set ? episodedTurnIds : new Set(episodedTurnIds || []);
  const list = Array.isArray(episodes) ? episodes : [];
  if (seen.size === 0) return { fresh: list, skipped: 0 };

  const fresh = list.filter((episode) => {
    const ids = Array.isArray(episode?.memoryIds) ? episode.memoryIds : [];
    // Ohne Turn-Bezug lässt sich nichts ausschließen — im Zweifel behalten.
    if (ids.length === 0) return true;
    return !ids.every((id) => seen.has(id));
  });
  return { fresh, skipped: list.length - fresh.length };
}

/**
 * Führt die neu episodierten Turn-IDs mit dem bisherigen Gedächtnis zusammen
 * und begrenzt es auf `limit` Einträge (jüngste gewinnen).
 */
export function mergeEpisodedTurnIds(previous = [], episodes = [], limit = 2000) {
  const merged = new Set(previous || []);
  for (const episode of Array.isArray(episodes) ? episodes : []) {
    for (const id of (Array.isArray(episode?.memoryIds) ? episode.memoryIds : [])) merged.add(id);
  }
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 2000;
  return [...merged].slice(-cap);
}
