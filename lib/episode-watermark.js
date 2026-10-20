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

// ---------------------------------------------------------------------------
// Watermark je Session (Audit capture-dedupe F2/F3)
//
// `agent_end.lastProcessedMessageCount` zaehlte die Laenge des Nachrichten-
// verlaufs EINER Session, lag aber im Store des ganzen Workspaces. Sessions
// ueberschrieben sich den Zaehler (Verlust bei laengerer, Doppelverarbeitung
// bei kuerzerer Session). Jetzt fuehrt `agent_end.sessionWatermarks` je stabilem
// Sitzungsschluessel einen eigenen Eintrag { count, failures, at }.
//
// Die plan*-Funktionen sind rein und laufen als Patch-Funktion von
// `neoStore.recordHook("agent_end", (prev) => plan…)` unter dem Store-Lock:
// Lesen und Schreiben sind damit eine Einheit (Compare-and-set).
// ---------------------------------------------------------------------------

/** Obergrenze der Session-Eintraege je Store; darueber faellt der aelteste weg. */
export const SESSION_WATERMARK_CAP = 500;

const count = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** Schluessel im Eintrags-Objekt; das Praefix haelt `__proto__` & Co. harmlos. */
export function watermarkSessionKey(sessionKey) {
  return `s:${String(sessionKey ?? "")}`;
}

function entryOf(agentEnd, key) {
  const sessions = agentEnd?.sessionWatermarks;
  if (!sessions || typeof sessions !== "object" || !Object.hasOwn(sessions, key)) return null;
  const entry = sessions[key];
  return entry && typeof entry === "object" ? entry : null;
}

function withEntry(agentEnd, key, entry) {
  const sessions = { ...(agentEnd?.sessionWatermarks && typeof agentEnd.sessionWatermarks === "object" ? agentEnd.sessionWatermarks : {}) };
  sessions[key] = entry;
  const keys = Object.keys(sessions);
  if (keys.length > SESSION_WATERMARK_CAP) {
    const oldestFirst = keys
      .filter((k) => k !== key)
      .sort((a, b) => String(sessions[a]?.at || "").localeCompare(String(sessions[b]?.at || "")));
    for (const k of oldestFirst.slice(0, keys.length - SESSION_WATERMARK_CAP)) delete sessions[k];
  }
  return sessions;
}

/**
 * Stand einer Session. `known` ist false, solange sie keinen eigenen Eintrag hat.
 *
 * @param {object} [agentEnd] `hooks.agent_end`
 * @param {string} sessionKey stabiler Sitzungsschluessel
 * @returns {{key: string, known: boolean, count: number, failures: number}}
 */
export function readSessionWatermark(agentEnd, sessionKey) {
  const key = watermarkSessionKey(sessionKey);
  const entry = entryOf(agentEnd, key);
  return { key, known: Boolean(entry), count: count(entry?.count), failures: count(entry?.failures) };
}

/**
 * Migration des alten Workspace-Zaehlers: Solange noch gar keine Session einen
 * Eintrag hat (`sessionWatermarks` fehlt), uebernimmt die ERSTE Session, die
 * danach erfasst, den alten Wert unveraendert, also genau das bisherige
 * Verhalten. Danach existiert die Map, und jede weitere Session beginnt bei 0;
 * ein neuer Wert wird nie an eine Session vererbt, die ihn nicht verdient.
 * Die Turn-IDs (episodedTurnIds) und die Dream-Digests fangen eine einmalige
 * Wiederholung des Verlaufs der uebrigen Sessions ab.
 *
 * @param {object} [agentEnd] frischer Stand unter dem Lock
 * @param {string} sessionKey
 * @returns {object|null} Patch fuer recordHook oder null (nichts zu migrieren)
 */
export function planLegacyWatermarkClaim(agentEnd, sessionKey) {
  if (agentEnd?.sessionWatermarks !== undefined) return null;
  const legacy = count(agentEnd?.lastProcessedMessageCount);
  if (legacy === 0) return null;
  const key = watermarkSessionKey(sessionKey);
  return {
    sessionWatermarks: withEntry(agentEnd, key, {
      count: legacy,
      failures: count(agentEnd?.postProcessingFailures),
      at: new Date().toISOString(),
    }),
  };
}

/**
 * Compare-and-set: das Watermark rueckt nur vor, wenn seit dem Lesen niemand
 * anderes es bewegt hat (`stored === baseline`, deckt auch den Reset nach
 * einer Kompaktierung ab) oder wenn der neue Wert hoeher liegt. Ein
 * verspaetet fertig werdender aelterer Lauf (fire-and-forget) schreibt damit
 * nie rueckwaerts.
 *
 * @param {object} [agentEnd] frischer Stand unter dem Lock
 * @param {string} sessionKey
 * @param {{baseline: number, to: number}} change `baseline`: Stand, den der Turn gelesen hat
 * @returns {object|null} Patch fuer recordHook oder null (veraltet)
 */
export function planWatermarkAdvance(agentEnd, sessionKey, { baseline, to }) {
  const key = watermarkSessionKey(sessionKey);
  const stored = count(entryOf(agentEnd, key)?.count);
  const target = count(to);
  if (!(stored === count(baseline) || target > stored)) return null;
  return {
    sessionWatermarks: withEntry(agentEnd, key, { count: target, failures: 0, at: new Date().toISOString() }),
    // Spiegel fuer aeltere Versionen; massgeblich ist sessionWatermarks.
    lastProcessedMessageCount: target,
    postProcessingFailures: 0,
  };
}

/**
 * Zaehlt einen Fehlversuch der Nachverarbeitung fuer die Session mit, aber
 * nur, solange ihr Watermark noch dort steht, wo der Turn es gelesen hat.
 *
 * @param {object} [agentEnd] frischer Stand unter dem Lock
 * @param {string} sessionKey
 * @param {{baseline: number, failures: number}} change
 * @returns {object|null} Patch fuer recordHook oder null (veraltet)
 */
export function planWatermarkFailure(agentEnd, sessionKey, { baseline, failures }) {
  const key = watermarkSessionKey(sessionKey);
  const entry = entryOf(agentEnd, key);
  if (count(entry?.count) !== count(baseline)) return null;
  return {
    sessionWatermarks: withEntry(agentEnd, key, { count: count(entry?.count), failures: count(failures), at: new Date().toISOString() }),
  };
}
