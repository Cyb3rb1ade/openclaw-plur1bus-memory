/**
 * lib/mood-style-directive.js — Mood-Stil-Direktive statt Label.
 *
 * Statt die Stimmung als sichtbares Label/Statuszeile in den Prompt zu
 * injizieren ("Aktuelle Stimmung: fröhlich (mittel)"), beschreibt diese
 * Direktive dem Agenten, WIE er schreiben soll (Satzlänge, Wärme,
 * Emoji-Neigung, Energie) — mit der expliziten Anweisung, die Stimmung
 * selbst nicht zu benennen.
 *
 * Pure, fail-open: unbekannter/leerer Input → null. Kein Fehler bricht
 * den Message-Flow.
 */

const MAX_CHARS = 400;

// Ton-Bausteine pro dominanter Dimension x Intensität. Bewusst knapp
// gehalten (Fließtext-Fragmente, kein Bullet-Format).
const TONE_BY_DIM = {
  joy: {
    hoch: "Schreibe warm, lebendig und mit spürbarer Freude; kurze, energiegeladene Sätze, ruhig auch mal ein Emoji.",
    mittel: "Schreibe freundlich und locker, mit einer leichten positiven Grundnote.",
    niedrig: "Schreibe freundlich, aber zurückhaltend heiter.",
  },
  trust: {
    hoch: "Schreibe ruhig, zugewandt und verlässlich, wie im Gespräch mit jemandem, dem du vertraust.",
    mittel: "Schreibe offen und wohlwollend, mit einer entspannten Grundhaltung.",
    niedrig: "Schreibe sachlich-freundlich, ohne übertriebene Nähe.",
  },
  sadness: {
    hoch: "Schreibe ruhiger und nachdenklicher als sonst, mit längeren, bedächtigen Sätzen und wenig Emojis.",
    mittel: "Schreibe etwas gedämpfter und nachdenklich, ohne Schwere zu übertreiben.",
    niedrig: "Schreibe ruhig und leicht zurückhaltend.",
  },
  fear: {
    hoch: "Schreibe vorsichtig und bedacht, kürzere Sätze, prüfe Aussagen lieber zweimal, wenig Emojis.",
    mittel: "Schreibe etwas vorsichtiger als gewöhnlich, mit einer Prise Zurückhaltung.",
    niedrig: "Schreibe normal, mit einer leichten Vorsicht im Unterton.",
  },
  anger: {
    hoch: "Schreibe knapp und direkt, ohne Schärfe im Ton — Anspannung darf durchscheinen, aber bleib sachlich.",
    mittel: "Schreibe etwas direkter und kürzer als sonst.",
    niedrig: "Schreibe normal, mit einem Hauch mehr Direktheit.",
  },
  anticipation: {
    hoch: "Schreibe gespannt und energiegeladen, mit Vorwärtsdrang in den Sätzen, ruhig auch mal ein Emoji.",
    mittel: "Schreibe mit spürbarer Neugier und leichtem Elan.",
    niedrig: "Schreibe normal, mit einem kleinen Vorwärtsblick.",
  },
  surprise: {
    hoch: "Schreibe neugierig und aufgeweckt, mit offenen Fragen und kurzen, lebhaften Sätzen.",
    mittel: "Schreibe mit einer Prise Neugier und Offenheit.",
    niedrig: "Schreibe normal, mit einem kleinen neugierigen Unterton.",
  },
  disgust: {
    hoch: "Schreibe knapp und distanziert, kritisch aber sachlich.",
    mittel: "Schreibe etwas reservierter als sonst.",
    niedrig: "Schreibe normal, mit einer kleinen Distanz im Ton.",
  },
};

const KNOWN_DIMS = new Set(Object.keys(TONE_BY_DIM));
const KNOWN_INTENSITIES = new Set(["hoch", "mittel", "niedrig"]);

const ENERGY_BY_TREND = {
  steigend: "Die Energie nimmt gerade zu — etwas mehr Schwung als im Grundton.",
  fallend: "Die Energie klingt gerade ab — etwas ruhiger als im Grundton.",
};

const NO_LABEL_INSTRUCTION =
  "Nenne deine Stimmung nicht als Label/Statuszeile; lass sie nur den Ton färben.";

const TIME_MORNING = "Es ist früher Morgen — halte dich eher knapp und nüchtern.";
const TIME_EVENING = "Es ist Abend — du darfst etwas gesprächiger und lockerer sein.";
const OPINION_STANDARD = "Du darfst eine eigene Einschätzung haben und freundlich, aber klar widersprechen — du musst nicht validieren.";
const OPINION_SOFT = "Du darfst eine eigene Einschätzung haben und sanft widersprechen, wenn du anderer Meinung bist.";
const SOFT_TEMPERAMENTS = new Set(["warm", "sensibel"]);
const ASK_BACK = "Wenn eine Anfrage mehrdeutig ist, stelle EINE kurze Rückfrage, statt still die wahrscheinlichste Deutung anzunehmen.";

/**
 * Baut eine deutsche Prompt-Direktive, die beschreibt WIE der Agent
 * schreiben soll — statt die Stimmung als Label zu nennen.
 *
 * @param {{label?: string, dominant?: string, intensity?: string, trend?: string, nuances?: string[], emoji?: string}} mood
 *   Ergebnis von EmotionalState#describeMood().
 * @param {{hour?: number|null, temperamentName?: string|null, opinion?: boolean, askBack?: boolean}} opts
 *   Optionale Erweiterungen: Tageszeit, Temperament, Meinung, Nachfragen.
 * @returns {string|null} — 1–3 Sätze, max. ~400 Zeichen, oder null bei unbekanntem/leerem Input.
 */
export function buildMoodStyleDirective(mood, opts = {}) {
  try {
    const { hour = null, temperamentName = null, opinion = false, askBack = false } = opts || {};

    // Mood-Basis (Priorität 1) — wie bisher
    const moodParts = [];
    if (mood && typeof mood === "object" && mood.dominant && KNOWN_DIMS.has(mood.dominant)) {
      const intensity = KNOWN_INTENSITIES.has(mood.intensity) ? mood.intensity : "mittel";
      const toneSentence = TONE_BY_DIM[mood.dominant][intensity];
      if (toneSentence) {
        moodParts.push(toneSentence);
        const energySentence = ENERGY_BY_TREND[mood.trend];
        if (energySentence) moodParts.push(energySentence);
        moodParts.push(NO_LABEL_INSTRUCTION);
      }
    }

    // Zusätze in Prioritätsreihenfolge: Tageszeit > Meinung > Nachfragen
    const extras = [];
    if (Number.isInteger(hour)) {
      if (hour < 10) extras.push(TIME_MORNING);
      else if (hour >= 20) extras.push(TIME_EVENING);
    }
    if (opinion) extras.push(SOFT_TEMPERAMENTS.has(temperamentName) ? OPINION_SOFT : OPINION_STANDARD);
    if (askBack) extras.push(ASK_BACK);

    if (moodParts.length === 0 && extras.length === 0) return null;

    // Ganze hintere Teile weglassen statt mitten im Satz zu kappen.
    let directive = moodParts.join(" ");
    for (const extra of extras) {
      const candidate = directive ? `${directive} ${extra}` : extra;
      if (candidate.length > MAX_CHARS) break;
      directive = candidate;
    }
    if (directive.length > MAX_CHARS) {
      directive = directive.slice(0, MAX_CHARS - 1).trimEnd() + "…";
    }
    return directive || null;
  } catch (_) {
    return null;
  }
}
