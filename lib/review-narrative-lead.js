// Deterministic, fail-open prose lead for PLUR1BUS reviews (morning/evening).
// Pattern-Vorbild: lib/dreaming/dream-narrative.js — kleine pure Funktionen, kein RNG, kein LLM.

const MAX_LEAD_LENGTH = 400;

// Kleine, lokale Ton-Zuordnung (keine Abhaengigkeit von lib/dreaming/dream-narrative.js).
const DOMINANT_TONE = {
  joy: "aufgeraeumt und zuversichtlich",
  trust: "ruhig und vertrauensvoll",
  anticipation: "gespannt, was als Naechstes ansteht",
  sadness: "gedaempft, ohne Alarmstimmung",
  disgust: "kritisch-distanziert",
  anger: "angespannt, aber sachlich",
  fear: "wachsam und vorsichtig",
  surprise: "aufmerksam, weil einiges ueberraschend ist",
};

const TREND_MODIFIER = {
  steigend: "mit zunehmender Energie",
  fallend: "eher zurueckhaltend",
};

function toneFromMood(mood) {
  if (!mood || typeof mood !== "object") return null;
  const base = DOMINANT_TONE[mood.dominant];
  if (!base || mood.label === "ausgeglichen") return null;
  const modifier = TREND_MODIFIER[mood.trend];
  return modifier ? `${base}, ${modifier}` : base;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

function countText(count, singular, plural) {
  const n = Number.isFinite(count) ? count : 0;
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * buildReviewNarrativeLead(summary, mood) -> string | null
 *
 * summary: { findings?, proposals?, conflicts?, duplicates? } (numbers, all optional)
 * mood: describeMood() shape ({ label, dominant, intensity, trend }), optional.
 *
 * Returns 2-4 German prose sentences, no bullets, capped in length. Fail-open: any
 * error returns null so callers can simply skip the lead.
 */
export function buildReviewNarrativeLead(summary, mood) {
  try {
    const findings = Number(summary?.findings) || 0;
    const proposals = Number(summary?.proposals) || 0;
    const conflicts = Number(summary?.conflicts) || 0;
    const duplicates = Number(summary?.duplicates) || 0;
    const total = findings + proposals + conflicts + duplicates;

    const sentences = [];

    if (total === 0) {
      sentences.push("Dieser Durchlauf hat nichts Auffaelliges gefunden.");
      sentences.push("Der Speicher wirkt aktuell aufgeraeumt, es gibt keine offenen Punkte, die eine Entscheidung brauchen.");
    } else {
      const parts = [];
      if (findings > 0) parts.push(countText(findings, "Fund", "Funde"));
      if (proposals > 0) parts.push(countText(proposals, "Vorschlag", "Vorschlaege"));
      if (conflicts > 0) parts.push(countText(conflicts, "Widerspruch", "Widersprueche"));
      if (duplicates > 0) parts.push(countText(duplicates, "Duplikat", "Duplikate"));
      const partsText = parts.length > 1
        ? `${parts.slice(0, -1).join(", ")} und ${parts[parts.length - 1]}`
        : parts[0];
      sentences.push(`Dieser Durchlauf bringt ${partsText} mit.`);

      if (conflicts > 0) {
        sentences.push("Ein paar Widerspruechlichkeiten sind dabei, die eine kurze Entscheidung brauchen.");
      } else if (proposals > 0) {
        sentences.push("Nichts davon ist dringend, aber ein Blick lohnt sich, bevor es angewendet wird.");
      } else {
        sentences.push("Es braucht keine Eile, ein kurzer Blick reicht.");
      }
    }

    const tone = toneFromMood(mood);
    if (tone) {
      sentences.push(`Insgesamt fuehlt sich das gerade ${tone} an.`);
    }

    const text = truncate(sentences.join(" "), MAX_LEAD_LENGTH);
    return text || null;
  } catch (_) {
    return null;
  }
}

export default buildReviewNarrativeLead;
