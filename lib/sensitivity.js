/**
 * lib/sensitivity.js — how private a memory is (7.21.2).
 *
 * Three levels: "banal" (anything that may be mentioned in another chat),
 * "personal" (about a person's life, still harmless: "hat dein Abendessen
 * gestern geschmeckt"), "confidential" (health, money, relationship and
 * intimacy, family conflicts, addresses and credentials, legal matters).
 * Confidential memories never leave their own chat in the automatic recall
 * (lib/recall-context.js); inside their chat nothing changes.
 *
 * This module is the rule classifier: regular expressions over the text, no
 * model, no network, deterministic. It runs at capture for every row and for
 * every Neo candidate. An LLM classification (lib/sensitivity-queue.js, the
 * emotion refine, Jev) may later replace it; the source says which one
 * decided. Pure functions, never throw.
 */

/** Sensitivity levels, least to most private. */
export const SENSITIVITY_LEVELS = Object.freeze(["banal", "personal", "confidential"]);
/** Who decided: the rules here, or an LLM. "" = not classified. */
export const SENSITIVITY_SOURCES = Object.freeze(["rules", "llm"]);

// Je Kategorie deutsche und englische Muster. Bewusst eher weit: ein falsch
// als vertraulich eingestufter Eintrag bleibt nur in seinem Chat, ein falsch
// als harmlos eingestufter wandert in fremde Chats.
const CONFIDENTIAL_PATTERNS = Object.freeze({
  health: [
    /\b(?:krankheit\w*|krankenhaus\w*|krankschreibung\w*|krankgeschrieben|diagnose\w*|diagnostiziert|therapie\w*|therapeut\w*|psychiat\w*|psycholog\w*|depression\w*|depressiv\w*|angststörung\w*|panikattacke\w*|burn-?out|medikament\w*|antidepressiv\w*|arzttermin\w*|ärztin|hausarzt|hausärzt\w*|facharzt|op-termin|krebs|tumor\w*|chemo\w*|schwanger\w*|fehlgeburt|abtreibung|suchtkrank\w*|abhängigkeit|alkoholiker\w*|entzugsklinik|blutdruck|diabetes|diabetiker\w*|schmerzmittel|befund\w*|reha-?klinik|psychose|suizid\w*|selbstmord\w*)\b/iu,
    /\b(?:illness|diagnos(?:is|ed)|therapist|therapy|psychiatr\w*|depression|depressed|anxiety disorder|panic attack|medication|prescription|hospitali[sz]ed|surgery|cancer|tumou?r|chemotherapy|pregnan\w*|miscarriage|abortion|addiction|rehab|suicid\w*|self-harm)\b/iu,
  ],
  finance: [
    /\b(?:gehalt|einkommen|kontostand|schulden|kredit|kredite|darlehen|hypothek|insolvenz|pleite|steuererklärung|steuernachzahlung|steuerschulden|steuerbescheid|finanzamt|mahnung\w*|inkasso|pfändung\w*|bafög|bürgergeld|hartz|unterhalt|unterhaltszahlung\w*|erbschaft|kontonummer)\b/iu,
    /\b(?:salary|bank balance|debts?|loan|mortgage|bankrupt\w*|tax return|tax debt|collection agency|alimony|inheritance|account number)\b/iu,
    /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/u, // IBAN
    /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b/u, // Kartennummer mit Trennern
  ],
  relationship: [
    /\b(?:affäre|fremdgegangen|fremdgehen|betrogen|trennung|scheidung|geschieden|liebeskummer|sex|sexuell\w*|intim\w*|beziehungskrise|eifersucht|eifersüchtig|ehekrise|seitensprung|schluss gemacht)\b/iu,
    /\b(?:affair|cheated|cheating|breakup|break-up|divorce[ds]?|sexual\w*|sex life|intimate|jealous\w*|marriage crisis)\b/iu,
  ],
  family: [
    /\bstreit mit (?:meine[mnr]?|der|dem|den) (?:mutter|vater|eltern|bruder|schwester|sohn|tochter|familie|mann|frau|ex)\b/iu,
    /\b(?:familienstreit|kontaktabbruch|sorgerecht|jugendamt|enterbt|häusliche gewalt|misshandl\w*|missbrauch\w*)\b/iu,
    /\b(?:custody battle|child protective|domestic violence|abused|estranged from)\b/iu,
  ],
  credentials: [
    /\b(?:passwort|kennwort|password|passcode|pin|geheimzahl|zugangsdaten|login|api[- ]?key|token|secret)\s*(?:ist|lautet|is|:|=)\s*\S{4,}/iu,
    /\b(?:sk|pk|ghp|gho|xox[bp])[-_][A-Za-z0-9]{16,}\b/u,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /\b(?:seed phrase|recovery code|wiederherstellungscode)\b/iu,
  ],
  address: [
    /\b[\p{Lu}][\p{L}.-]+(?:straße|strasse|str\.|weg|gasse|allee|platz|ring|damm)\s+\d+[a-z]?\b/u,
    /\b(?:wohnadresse|meine adresse|ich wohne in der|home address)\b/iu,
    /\b(?:geburtsdatum|ausweisnummer|personalausweisnummer|reisepassnummer|sozialversicherungsnummer|steuer-?id|social security number|passport number)\b/iu,
  ],
  legal: [
    /\b(?:anwalt|anwältin|rechtsanwalt|rechtsanwältin|klage|klagen|verklagt|verklagen|vor gericht|gerichtstermin|amtsgericht|landgericht|arbeitsgericht|familiengericht|strafanzeige|anzeige erstattet|vorstrafe\w*|bewährung|staatsanwalt\w*|abmahnung\w*|kündigungsschutz\w*|aufhebungsvertrag)\b/iu,
    /\b(?:lawyer|attorney|lawsuit|sued|court hearing|criminal record|probation|prosecutor|police report)\b/iu,
  ],
});

// Persönlich, aber harmlos: Ich-Aussagen über Alltag, Gefühle, Vorlieben,
// Familie ohne Konflikt, Wohnung, Essen, Urlaub.
const PERSONAL_PATTERNS = Object.freeze([
  /\b(?:ich|mein(?:e[mnrs]?)?|mir|mich|wir|unser(?:e[mnrs]?)?)\b/iu,
  /\b(?:i|my|me|we|our)\b/iu,
  /\b(?:mama|papa|mutter|vater|bruder|schwester|kinder?|sohn|tochter|freundin|freund|frau|mann|oma|opa|familie|mother|father|brother|sister|kids?|son|daughter|girlfriend|boyfriend|wife|husband|family)\b/iu,
  /\b(?:gefühl\w*|müde|traurig|glücklich|gestresst|urlaub|abendessen|frühstück|geburtstag|hobby|zuhause|wohnung|feeling|tired|sad|happy|stressed|vacation|dinner|breakfast|birthday|at home)\b/iu,
]);

/**
 * Classify a text by the rules.
 *
 * @param {string} text Memory text (or summary).
 * @returns {{sensitivity: "banal"|"personal"|"confidential", source: "rules", categories: string[]}}
 */
export function classifySensitivityByRules(text) {
  const source = String(text ?? "").normalize("NFC");
  const categories = [];
  if (source.trim()) {
    for (const [category, patterns] of Object.entries(CONFIDENTIAL_PATTERNS)) {
      if (patterns.some((re) => re.test(source))) categories.push(category);
    }
  }
  if (categories.length > 0) return { sensitivity: "confidential", source: "rules", categories };
  const personal = PERSONAL_PATTERNS.filter((re) => re.test(source)).length >= 2;
  return { sensitivity: personal ? "personal" : "banal", source: "rules", categories };
}

/**
 * Normalize a stored value; anything unknown is "" (not classified).
 *
 * @param {unknown} value
 * @returns {""|"banal"|"personal"|"confidential"}
 */
export function normalizeSensitivity(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return SENSITIVITY_LEVELS.includes(v) ? v : "";
}

/**
 * @param {unknown} value
 * @returns {""|"rules"|"llm"}
 */
export function normalizeSensitivitySource(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return SENSITIVITY_SOURCES.includes(v) ? v : "";
}
