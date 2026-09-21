// Phase 7 - Memory Dynamics: pure helpers for strength decay, reinforcement,
// flashbulb encoding, and privacy-preserving retrieval ledger entries.

import { createHash, randomUUID } from "node:crypto";

export const CORE_MEMORY_THRESHOLD = 0.95;
export const CORE_MEMORY_HALF_LIFE_DAYS = 36500;

/** Untergrenze des Bandes, das der Agent für eigene Entscheidungen hält. */
export const AGENT_BAND_MIN = 0.95;

/** Halbwertszeit in Tagen für eine Blitzlicht-Kodierung — zehn Jahre. */
export const FLASHBULB_HALF_LIFE_DAYS = 3650;

/**
 * Ab welchem Blitzlicht-Wert eine Erinnerung einbrennt.
 *
 * Phase 3, Pilotlauf 21.09.2026 über 24.509 aktive Zeilen aller Agenten: Die
 * bisherigen 0,70 hätten **10,3 %** des Bestands und **6,4 %** der Zeilen der
 * letzten 30 Tage eingebrannt — die Zielgröße in scripts/importance-metrics.mjs
 * lautet „unter 2 % der neuen Erinnerungen". Gemessen an den neuen Zeilen:
 *
 *   Schwelle   Bestand   letzte 30 Tage
 *     0,70     10,3 %        6,4 %
 *     0,80      5,2 %        1,8 %   <- gewählt
 *     0,90      1,8 %        0,3 %
 *
 * Maßstab sind die neuen Zeilen, nicht der Bestand: Der enthält Altlasten aus
 * vier Jahren und drei Bewertungsregeln. 0,90 träfe davon so wenig, dass das
 * Merkmal praktisch nie feuert.
 *
 * Die 0,70 stammten aus einer Zeit, als `novelty` und `userCorrection` noch
 * 30 % zum Wert beitragen sollten; als die Gewichte auf die zwei tatsächlich
 * vorhandenen Merkmale normiert wurden, blieb die Schwelle stehen.
 */
export const FLASHBULB_THRESHOLD = 0.80;

/**
 * Blitzlicht-Boden vor diesem Branch (90 Tage). Greift, solange das
 * Konfigurationsflag `memoryDynamics.flashbulbEncoding` aus ist (Default) —
 * siehe Ruling R16 im Abschluss-Review: die Zehnjahres-Dauer ist erst für
 * Phase 3 vorgesehen, nach einem Pilotlauf, der die 0,70-Schwelle an einer
 * echten Importance-Verteilung kalibriert. Bis dahin bleibt der Capture-Pfad
 * (applyDynamicsDefaults) exakt auf seinem Verhalten von vor diesem Branch.
 */
export const FLASHBULB_HALF_LIFE_LEGACY_DAYS = 90;

/**
 * `importance = 1.0` ist dem Agenten vorbehalten: er markiert damit im Gespräch
 * eine Erinnerung, die er subjektiv nicht vergessen will. Der automatische
 * Scorer erreicht den Wert nicht — `computeMemoryImportance` startet ohne
 * expliziten Wert bei 0.5, hebt über Floors auf höchstens 0.7 und deckelt
 * Triviales auf 0.45/0.2. 1.0 entsteht also ausschließlich durch eine bewusste
 * Setzung und wird deshalb ohne weitere Bedingung als Core anerkannt.
 *
 * Insbesondere ohne das emotionale Tor: `emotionalIntensity` stammt aus der
 * automatischen Tonanalyse des Textes und ist für den Agenten gar nicht
 * setzbar. Eine ruhig formulierte Sicherheitsnotiz — genau der Fall, für den
 * die Markierung gedacht ist — hat emotionale Intensität 0.
 */
/**
 * Task 10 (19.09.2026): von 1.0 auf AGENT_BAND_MIN gesenkt. Bis dahin war das
 * Band 0.95–1.00 eine Verabredung ohne Wirkung — nur der exakte Wert 1.0
 * loeste den Schutz aus, alles darunter zerfiel wie eine beliebige Zeile.
 * Live gemessen bei bernhardine: 51 Zeilen im Band, alle origin=dm, davon 43
 * auf genau 0.95 und mit einer Halbwertszeit von 30 Tagen; ein im Gespraech
 * ausdruecklich als wichtig markierter Wendepunkt stand bei Gedaechtnisstaerke
 * 0.023.
 *
 * Reihenfolge-Bedingung: Diese Senkung war erst zulaessig, NACHDEM Phase 1
 * (scripts/importance-phase1-reset.mjs) die 320 Altlasten aus der
 * MEMORY.md-Migration vom Band heruntergedrueckt hat. Vorher haette sie einen
 * Stapel Blutzucker-Statusberichte unsterblich gemacht.
 *
 * Bestehende Zeilen bekommen den Schutz dadurch NICHT von selbst:
 * applyDynamicsDefaults kodiert nur bei neuen Eintraegen (`isNew`). Dafuer
 * gibt es scripts/backfill-manual-core-markers.mjs, das dieselbe Konstante als
 * Schwelle benutzt und nach dem Deploy einmal laufen muss.
 */
export const MANUAL_CORE_IMPORTANCE = AGENT_BAND_MIN;

/**
 * Ist diese Zeile ein lebendiger Gedaechtniseintrag?
 *
 * Gemeinsamer Begriff fuer alle Wartungswerkzeuge. Am 19.09.2026 hatten drei
 * Skripte drei Auslegungen: Phase 1 und dedupe-memory-ids verlangten
 * `status === "active"`, backfill-manual-core-markers schloss dagegen nur
 * `deleted` und `archived` aus — `review` fiel in die Luecke. Folge: zwei
 * Altlasten aus der MEMORY.md-Migration standen als Kandidaten fuer
 * dauerhaften Kern-Schutz in der Liste, obwohl Phase 1 sie aus genau diesem
 * Grund haette raeumen sollen und wegen desselben Begriffsunterschieds nicht
 * gesehen hatte.
 *
 * Eine fehlende Statusspalte gilt als aktiv (alte Zeilen ohne das Feld); ein
 * leerer String tut das NICHT — `??` faengt nur null und undefined, und die
 * beiden bestehenden Aufrufer verhalten sich seit jeher so.
 */
export function isLiveRow(row = {}) {
  return String(row?.status ?? "active") === "active";
}

export function isManualCoreMarker(row = {}) {
  return Number(row.importance) >= MANUAL_CORE_IMPORTANCE;
}

/**
 * Computes decayed memory strength using an exponential forgetting curve:
 * S = S0 * (1/2)^(elapsed / halfLife).
 */
export function computeDecayedStrength(row = {}, now = Date.now()) {
  if (isCoreMemory(row)) return 1.0;

  const s0 = clamp(row.memoryStrength ?? 1.0, 0.01, 1.0);
  const rawHalfLifeDays = Number(row.halfLifeDays ?? 30);
  const halfLifeDays = Number.isFinite(rawHalfLifeDays) ? Math.max(1, rawHalfLifeDays) : 30;
  const halfLifeMs = halfLifeDays * 86400000;
  const lastDynamics = firstValidTimestamp(
    row.lastDynamicsAt,
    row.lastStrengthenedAt,
    row.createdAt,
  );
  const elapsed = Number(now) - lastDynamics;

  if (!Number.isFinite(elapsed) || elapsed <= 0) return s0;

  const decayed = s0 * Math.pow(0.5, elapsed / halfLifeMs);
  return clamp(decayed, 0.01, 1.0);
}

/**
 * Applies retrieval reinforcement after first decaying the current strength.
 */
/**
 * Verteilte Wiederholung dehnt die Behaltensdauer — nicht nur die momentane
 * Verfuegbarkeit. Bis 19.09.2026 hob ein Abruf allein die Staerke, und die
 * Erinnerung zerfiel danach exakt so schnell wie zuvor: eine Tatsache mit
 * 30 Tagen Halbwertszeit, alle drei Tage abgerufen, stand nach einem Jahr bei
 * 0,395 — schwaecher als eine intensiv kodierte Erinnerung, an die nie wieder
 * jemand dachte (0,886).
 *
 * Der Deckel liegt beim obersten automatischen Band (600 Tage), analog zu
 * AUTOMATIC_IMPORTANCE_MAX: blosse Wiederholung erreicht nie, was der
 * Intensitaet (Blitzlicht, 3650) oder der ausdruecklichen Entscheidung des
 * Agenten (36.500) vorbehalten ist.
 *
 * Der Mindestabstand verhindert, dass eine Salve im selben Augenblick die
 * Dauer aufblaest — zwanzig Abrufe in einer Sekunde sind ein Lernmoment, keine
 * Wiederholung.
 */
export const RETRIEVAL_HALF_LIFE_MAX_DAYS = 600;
/**
 * Was ein Abruf zur momentanen Staerke beitraegt. Frueher
 * `0.15 / (1 + log1p(retrievalCount))` — der Zuschlag schrumpfte damit mit der
 * Zahl der bisherigen Abrufe (erster +0,089, hundertster +0,027), je oefter man
 * sich also erinnerte, desto weniger trug jedes Erinnern bei. Die Saettigung
 * braucht diesen Term nicht: die Staerke ist bei 0.99 gedeckelt, und zwischen
 * zwei Abrufen zerfaellt sie ohnehin.
 */
export const RETRIEVAL_STRENGTH_BOOST = 0.15;
export const RETRIEVAL_HALF_LIFE_FACTOR = 1.15;
export const RETRIEVAL_MIN_SPACING_MS = 86400000;

export function applyRetrievalReinforcement(row = {}, now = Date.now()) {
  if (isCoreMemory(row)) {
    return {
      retrievalCount: (Number(row.retrievalCount) || 0) + 1,
      lastRetrievedAt: now,
      memoryStrength: 1.0,
      lastStrengthenedAt: now,
      lastDynamicsAt: now,
    };
  }

  const decayed = computeDecayedStrength(row, now);
  const count = (Number(row.retrievalCount) || 0) + 1;
  const boost = RETRIEVAL_STRENGTH_BOOST;
  const strength = clamp(decayed + boost, 0.01, 0.99);

  // Nur ein zeitlich abgesetzter Abruf dehnt die Behaltensdauer, und nur nach
  // oben: eine Blitzlicht-Zeile (3650 Tage) darf der Deckel von 600 nie auf
  // den Boden stutzen — dieselbe Math.max-Regel wie in
  // applyFlashbulbEncoding.
  const rawHalfLife = Number(row.halfLifeDays);
  const currentHalfLife = Number.isFinite(rawHalfLife) && rawHalfLife > 0 ? rawHalfLife : 30;
  const seitLetzterStaerkung = Number(now) - firstValidTimestamp(
    row.lastStrengthenedAt,
    row.lastDynamicsAt,
    row.createdAt,
  );
  const abgesetzt = Number.isFinite(seitLetzterStaerkung) && seitLetzterStaerkung >= RETRIEVAL_MIN_SPACING_MS;
  const gedehnt = abgesetzt
    ? Math.min(RETRIEVAL_HALF_LIFE_MAX_DAYS, currentHalfLife * RETRIEVAL_HALF_LIFE_FACTOR)
    : currentHalfLife;

  return {
    retrievalCount: count,
    lastRetrievedAt: now,
    memoryStrength: strength,
    halfLifeDays: Math.max(currentHalfLife, gedehnt),
    lastStrengthenedAt: now,
    lastDynamicsAt: now,
  };
}

/**
 * Computes whether a memory is a candidate for promotion to a higher class.
 * @param {object} row — memory row
 * @param {number} sessionCount — how many distinct sessions it has been retrieved in
 * @returns {{ isCandidate: boolean, score: number, reasons: string[] }}
 */
export function computePromotionCandidate(row = {}, sessionCount = 1) {
  const reasons = [];
  const retrievalCount = Number(row.retrievalCount) || 0;
  const importance = Number(row.importance ?? 0.5);
  const category = String(row.category || "").toLowerCase();
  const memoryClass = String(row.memoryClass || "").toLowerCase();

  if (memoryClass === "core") {
    reasons.push("memoryClass is core — already highest class");
    return { isCandidate: false, score: 0, reasons };
  }

  if (retrievalCount < 3) {
    reasons.push(`retrievalCount ${retrievalCount} < 3`);
  }
  if (importance < 0.7) {
    reasons.push(`importance ${importance} < 0.7`);
  }
  if (sessionCount < 2) {
    reasons.push(`sessionCount ${sessionCount} < 2`);
  }
  if (category === "fact" || category === "general") {
    reasons.push(`category '${category}' is transient — not eligible`);
  }

  const isCandidate =
    retrievalCount >= 3 &&
    importance >= 0.7 &&
    sessionCount >= 2 &&
    category !== "fact" &&
    category !== "general";

  const score = isCandidate
    ? importance * 0.4 + (retrievalCount / 10) * 0.3 + (sessionCount / 5) * 0.3
    : 0;

  if (isCandidate) {
    reasons.push("meets all promotion criteria");
  }

  return { isCandidate, score, reasons };
}

/**
 * Applies daily decay without strengthening.
 */
export function applyDailyDecay(row = {}, now = Date.now()) {
  return {
    memoryStrength: computeDecayedStrength(row, now),
    lastDynamicsAt: now,
  };
}

/**
 * Computes a flashbulb score from emotional and semantic features.
 */
export function computeFlashbulbScore(row = {}) {
  const emotionalIntensity = Number(row.emotionalIntensity ?? 0);
  const importance = Number(row.importance ?? 0.5);

  // `novelty` und `userCorrection` trugen früher 15 % + 15 %, sind aber keine
  // Spalten der Tabelle und werden von keiner Stelle geschrieben (über die
  // gesamte Historie nie). Der Score konnte damit höchstens 0.70 erreichen —
  // exakt die Schwelle — und feuerte nur im singulären Punkt 1.0/1.0. Die
  // Gewichte sind deshalb auf die tatsächlich vorhandenen Merkmale normiert.
  return clamp(emotionalIntensity * 0.5 + importance * 0.5, 0, 1);
}

/**
 * Skaliert eine Basis-Halbwertszeit mit der emotionalen Intensität:
 * je intensiver die Erinnerung, desto langsamer das Vergessen.
 * halfLife' = halfLife × (1 + intensity × factor)
 */
export function modulateHalfLifeDays(baseDays, emotionalIntensity, factor = 1.0) {
  const base = Number(baseDays);
  if (!Number.isFinite(base) || base <= 0) return baseDays;
  const intensity = clamp(emotionalIntensity ?? 0, 0, 1);
  const f = Number.isFinite(Number(factor)) ? Math.max(0, Number(factor)) : 1.0;
  return Math.round(base * (1 + intensity * f));
}

/**
 * Applies flashbulb encoding when the score crosses the threshold.
 *
 * `floorDays` ist die Mindest-Halbwertszeit, auf die eine feuernde
 * Blitzlicht-Kodierung anhebt. Default bleibt die volle Zehnjahres-Dauer —
 * Rückwärtskompatibilität für Aufrufer, die diese Funktion direkt (ohne das
 * Konfigurationsflag) nutzen. Aufrufer hinter dem Flag (applyDynamicsDefaults,
 * buildRefinePatch) reichen den jeweils gültigen Boden explizit durch.
 */
export function applyFlashbulbEncoding(row = {}, now = Date.now(), threshold = FLASHBULB_THRESHOLD, baseHalfLifeDays = 0, floorDays = FLASHBULB_HALF_LIFE_DAYS) {
  const score = computeFlashbulbScore(row);
  if (score < threshold) return null;

  const floor = Number(floorDays);

  return {
    memoryStrength: 0.95,
    // Flashbulb darf die Halbwertszeit nur verlängern, nie verkürzen —
    // sonst würde z.B. eine Core-Memory (36500d) auf den Boden gestutzt.
    halfLifeDays: Math.max(Number(baseHalfLifeDays) || 0, Number.isFinite(floor) ? floor : FLASHBULB_HALF_LIFE_DAYS),
    lastStrengthenedAt: now,
    lastDynamicsAt: now,
  };
}

/**
 * Core memories are intentionally rare: they require both emotional depth and
 * high importance, then must still clear the flashbulb-style aggregate score.
 */
export function computeCoreMemoryScore(row = {}) {
  if (isCoreMemory(row)) return 1.0;
  if (isManualCoreMarker(row)) return 1.0;

  const emotionalIntensity = Number(row.emotionalIntensity ?? 0);
  const importance = Number(row.importance ?? 0.5);
  if (emotionalIntensity < CORE_MEMORY_THRESHOLD || importance < CORE_MEMORY_THRESHOLD) {
    return 0;
  }

  // Siehe computeFlashbulbScore: `novelty` trug 10 %, existiert aber nicht.
  // Der Score kam dadurch nie über 0.90 und blieb dauerhaft unter der Schwelle
  // von 0.95 — Core war rechnerisch unerreichbar. Gewichte normiert.
  return clamp(emotionalIntensity * 0.5 + importance * 0.5, 0, 1);
}

export function applyCoreMemoryEncoding(row = {}, now = Date.now(), threshold = CORE_MEMORY_THRESHOLD) {
  const score = computeCoreMemoryScore(row);
  if (score < threshold) return null;

  return {
    memoryClass: "core",
    neverForget: 1,
    coreMemoryScore: score,
    coreMemoryReason: row.coreMemoryReason
      || (isManualCoreMarker(row) ? "manual_importance_marker" : "deep_flashbulb_threshold"),
    memoryStrength: 1.0,
    halfLifeDays: CORE_MEMORY_HALF_LIFE_DAYS,
    expiresAt: 0,
    lastStrengthenedAt: now,
    lastDynamicsAt: now,
  };
}

export function isCoreMemory(row = {}) {
  return row.memoryClass === "core" || row.neverForget === true || row.neverForget === 1;
}

/**
 * Default half-life mapping by memory category.
 * Groups: transient (60d), episodic (180d), longContext/project (365d).
 * Core memories bypass this entirely (see CORE_MEMORY_HALF_LIFE_DAYS).
 */
const DEFAULT_HALF_LIFE_MAP = {
  transient: 60,   // fact, general
  episodic: 180,   // other (catch-all)
  longContext: 600,// person, work
  project: 600,    // project, decision
};

const CATEGORY_TO_GROUP = {
  fact: "transient",
  general: "transient",
  other: "episodic",
  person: "longContext",
  work: "longContext",
  project: "project",
  decision: "project",
};

/**
 * Resolve halfLifeDays from category and memoryClass.
 * @param {string} category — memory category
 * @param {string|null} memoryClass — optional memoryClass (core bypasses mapping)
 * @param {object} overrides — optional config overrides per group
 * @returns {number} halfLifeDays
 */
export function resolveHalfLifeDays(category, memoryClass = null, overrides = {}) {
  if (memoryClass === "core" || isCoreMemory({ memoryClass })) {
    return CORE_MEMORY_HALF_LIFE_DAYS;
  }
  // Träume verblassen schnell, wie beim Menschen — intensive Träume
  // überleben länger über den normalen Strength-Mechanismus.
  if (memoryClass === "dream") {
    return overrides.dream ?? 30;
  }
  const group = CATEGORY_TO_GROUP[String(category || "").toLowerCase()] || "episodic";
  return overrides[group] ?? DEFAULT_HALF_LIFE_MAP[group];
}

/**
 * Halbwertszeit aus dem Kodierungsurteil statt aus der Kategorie.
 *
 * Bänder (freigegeben 19.09.2026): < 0.4 beiläufig, 0.4–0.7 normal,
 * 0.7–0.94 bedeutsam, ab 0.95 Agentenband. Blitzlicht sticht die Bänder,
 * bleibt aber unter dem Agentenband — "eingebrannt" und "behalten wollen"
 * sind zwei verschiedene Vorgänge.
 */
export function resolveHalfLifeFromEncoding(importance, { flashbulb = false } = {}) {
  const value = Number(importance);
  const normalized = Number.isFinite(value) ? value : 0.5;
  if (normalized >= AGENT_BAND_MIN) return CORE_MEMORY_HALF_LIFE_DAYS;
  if (flashbulb) return FLASHBULB_HALF_LIFE_DAYS;
  if (normalized < 0.4) return 30;
  if (normalized < 0.7) return 180;
  return 600;
}

/**
 * Applies dynamics and versioning defaults before storing an entry.
 */
export function applyDynamicsDefaults(entry = {}, now = Date.now(), halfLifeOverrides = {}, opts = {}) {
  const isNew = !entry.lastDynamicsAt;
  const out = { ...entry };

  if (isNew) {
    const baseHalfLifeDays = entry.halfLifeDays ?? modulateHalfLifeDays(
      resolveHalfLifeDays(entry.category, entry.memoryClass, halfLifeOverrides),
      entry.emotionalIntensity,
      opts.intensityHalfLifeFactor ?? 1.0,
    );
    // R16 (Abschluss-Review, Critical 1): Flag aus (Default) hält den Boden
    // bei den historischen 90 Tagen; erst mit explizitem Opt-in greift die
    // Zehnjahres-Dauer aus Phase 3.
    const flashbulbFloorDays = opts.flashbulbEncodingEnabled === true
      ? FLASHBULB_HALF_LIFE_DAYS
      : FLASHBULB_HALF_LIFE_LEGACY_DAYS;
    const core = applyCoreMemoryEncoding(out, now);
    const flashbulb = core ? null : applyFlashbulbEncoding(out, now, FLASHBULB_THRESHOLD, baseHalfLifeDays, flashbulbFloorDays);
    if (core) {
      Object.assign(out, core);
    } else if (flashbulb) {
      Object.assign(out, flashbulb);
      out.memoryClass = entry.memoryClass || "flashbulb";
      out.neverForget = entry.neverForget ? 1 : 0;
      out.coreMemoryScore = entry.coreMemoryScore ?? computeCoreMemoryScore(out);
      out.coreMemoryReason = entry.coreMemoryReason || "";
    } else {
      out.memoryStrength = entry.memoryStrength ?? 1.0;
      out.halfLifeDays = baseHalfLifeDays;
      out.lastDynamicsAt = now;
      out.memoryClass = entry.memoryClass || "standard";
      out.neverForget = entry.neverForget ? 1 : 0;
      out.coreMemoryScore = entry.coreMemoryScore ?? computeCoreMemoryScore(out);
      out.coreMemoryReason = entry.coreMemoryReason || "";
    }
    out.retrievalCount = entry.retrievalCount ?? 0;
    out.lastRetrievedAt = entry.lastRetrievedAt ?? 0;
    out.replayCount = entry.replayCount ?? 0;
    out.lastReplayed = entry.lastReplayed ?? 0;
    out.lastStrengthenedAt = out.lastStrengthenedAt ?? entry.lastStrengthenedAt ?? 0;
    out.versionNumber = entry.versionNumber ?? 1;
    out.previousVersion = entry.previousVersion || "";
    out.supersededBy = entry.supersededBy || "";
    out.updateSource = entry.updateSource || "";
    out.updateEvidence = entry.updateEvidence || "";
    out.reconsolidationConfidence = entry.reconsolidationConfidence ?? 0.0;
    out.status = entry.status || "active";
    out.versionCreatedAt = entry.versionCreatedAt || now;
    out.updatedAt = entry.updatedAt || now;
  } else {
    Object.assign(out, applyDailyDecay(out, now));
    out.replayCount = entry.replayCount ?? 0;
    out.lastReplayed = entry.lastReplayed ?? 0;
  }

  return out;
}

/**
 * Creates a retrieval ledger entry without persisting the raw query text.
 */
export function createRetrievalLedgerEntry({
  agentId,
  workspaceKey,
  query,
  queryHash,
  resultsCount,
  selectedIds,
  timestamp = Date.now(),
} = {}) {
  const hash = queryHash || (query ? createHash("sha256").update(String(query)).digest("hex") : null);

  return {
    id: randomUUID(),
    agentId: agentId || null,
    workspaceKey: workspaceKey || null,
    queryHash: hash,
    resultsCount: resultsCount ?? 0,
    selectedIds: Array.isArray(selectedIds) ? selectedIds : [],
    timestamp,
  };
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function firstValidTimestamp(...candidates) {
  for (const t of candidates) {
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}
