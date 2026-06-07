/**
 * lib/emotion.js — Heuristische Emotions-Inferenz für PLUR1BUS Memories.
 *
 * Ordnet Texten eine emotionale Valenz zu — rein deterministisch, ohne
 * LLM-Call. Nutzt Pattern-Matching, Kategorie-Mapping und Neo-Reactions.
 *
 * Basis: Plutchiks Rad der Emotionen (8 Primäremotionen),
 * vereinfacht auf 7 Dimensionen + neutral.
 */

export const EMOTION_DIMENSIONS = [
  "joy",
  "trust",
  "anticipation",
  "sadness",
  "anger",
  "fear",
  "surprise",
];

/**
 * Pattern-basierte Emotions-Inferenz.
 *
 * @param {string} text — Der zu analysierende Text
 * @param {string} category — Memory-Kategorie (optional)
 * @param {Array} reactionSignals — Neo Reaction-Signale (optional)
 * @returns {{joy:number, trust:number, anticipation:number, sadness:number, anger:number, fear:number, surprise:number, emotionalIntensity:number, emotionalDominant:string}}
 */
export function inferEmotionalValence(text, category = "", reactionSignals = []) {
  const valence = {
    joy: 0,
    trust: 0,
    anticipation: 0,
    sadness: 0,
    anger: 0,
    fear: 0,
    surprise: 0,
  };

  const lower = String(text || "").toLowerCase();

  // ─── 1. Text-Pattern-Matching ─────────────────────────────────────────────

  // Freude / Begeisterung
  if (/\b(toll|super|geil|fantastisch|perfekt|hervorragend|großartig|wunderbar|genial|exzellent|👍|❤️|😊|🎉|💪|\:-\)|\:\)|\;\))\b/.test(lower)) {
    valence.joy = 0.75;
  }
  if (/\b(lol|haha|lustig|witzig|lach|hihi|😂|🤣|😄|😁)\b/.test(lower)) {
    valence.joy = Math.max(valence.joy, 0.6);
  }
  if (/\b(danke|vielen dank|danke schön|appreciated|freue mich|freuen|glücklich|happy|zufrieden|stolz)\b/.test(lower)) {
    valence.joy = Math.max(valence.joy, 0.5);
    valence.trust = Math.max(valence.trust, 0.4);
  }

  // Vertrauen / Nähe
  if (/\b(vertraue|vertrauen|verlässlich|zuverlässig|loyal|treu|ehrlich|offen|nah|vertraut|gemeinsam|wir|team)\b/.test(lower)) {
    valence.trust = 0.6;
  }
  if (/\b(partner|freund|freundin|familie|bruder|schwester|mutter|vater|kind|liebe|lieben)\b/.test(lower)) {
    valence.trust = Math.max(valence.trust, 0.5);
    valence.joy = Math.max(valence.joy, 0.3);
  }

  // Erwartung / Vorfreude
  if (/\b(aufregend|spannend|neugierig|neugier|gespannt|hoffe|hoffnung|erwarte|erwartung|bald|demnächst|soon|plan|geplant|vorbereiten)\b/.test(lower)) {
    valence.anticipation = 0.55;
  }
  if (/\b(start|beginn|anfang|launch|release|q[1-4]|202[6-9]|nächste woche|nächsten monat)\b/.test(lower)) {
    valence.anticipation = Math.max(valence.anticipation, 0.4);
  }

  // Traurigkeit / Enttäuschung
  if (/\b(schade|traurig|enttäuscht|enttäuschung|bedauerlich|leider|misserfolg|fail|verloren|loss|weg|tot|gestorben|krank)\b/.test(lower)) {
    valence.sadness = 0.65;
  }
  if (/\b(nein|nicht|verweigert|abgelehnt|rejected|declined|nicht möglich|unmöglich)\b/.test(lower)) {
    valence.sadness = Math.max(valence.sadness, 0.35);
  }

  // Wut / Frustration
  if (/\b(verdammt|scheiße|ärgerlich|frust|frustriert|wütend|wut|aggressiv|hass|hassen|idiot|blöd|dumm|mist|verdammt|fuck|shit|😤|😠|😡|🤬)\b/.test(lower)) {
    valence.anger = 0.7;
  }
  if (/\b(nervt|nervig|lästig|unverschämt|unfair|betrug|betrüger|lüge|lügner|false|falsch|wrong)\b/.test(lower)) {
    valence.anger = Math.max(valence.anger, 0.55);
  }
  if (/\b(korrigier|korrektur|falsch|nicht richtig|aber|however|stimmt nicht|doesn'?t work|broken|kaputt)\b/.test(lower)) {
    valence.anger = Math.max(valence.anger, 0.3);
  }

  // Angst / Sorge
  if (/\b(angst|sorgen|besorgt|unsicher|unsicherheit|risiko|gefahr|warnung|vorsicht|alarm|problem|schwerwiegend|kritisch|critical|urgent|dringend)\b/.test(lower)) {
    valence.fear = 0.6;
  }
  if (/\b(passwort|password|token|key|hack|gehackt|leak|datenpanne|datenschutz|gdpr|dsvgo)\b/.test(lower)) {
    valence.fear = Math.max(valence.fear, 0.5);
  }
  if (/\b(fehler|error|exception|bug|crash|down|offline|nicht erreichbar|timeout)\b/.test(lower)) {
    valence.fear = Math.max(valence.fear, 0.4);
  }

  // Überraschung
  if (/\b(überraschung|überrascht|wow|omg|oh mein gott|unglaublich|unerwartet|plötzlich|plot twist|wtf|what the|😲|😮|😯|🤯)\b/.test(lower)) {
    valence.surprise = 0.7;
  }
  if (/\b(tatsächlich|wirklich|echt|seriously|actually|really|never expected)\b/.test(lower)) {
    valence.surprise = Math.max(valence.surprise, 0.4);
  }

  // ─── 2. Kategorie-basiertes Mapping ───────────────────────────────────────

  const categoryLower = String(category || "").toLowerCase();
  switch (categoryLower) {
    case "preference":
      valence.joy = Math.max(valence.joy, 0.3);
      valence.trust = Math.max(valence.trust, 0.25);
      break;
    case "decision":
      valence.anticipation = Math.max(valence.anticipation, 0.35);
      valence.trust = Math.max(valence.trust, 0.2);
      break;
    case "fact":
      // Fakten sind meist neutral, leichter Trust-Boost wenn verifiziert
      valence.trust = Math.max(valence.trust, 0.15);
      break;
    case "entity":
      valence.trust = Math.max(valence.trust, 0.2);
      break;
    case "debug":
      valence.anger = Math.max(valence.anger, 0.25);
      valence.fear = Math.max(valence.fear, 0.2);
      break;
    case "config":
      valence.anticipation = Math.max(valence.anticipation, 0.15);
      break;
    case "reference":
      valence.anticipation = Math.max(valence.anticipation, 0.2);
      break;
    case "conversation":
      // Default — keine zusätzliche Prägung
      break;
  }

  // ─── 3. Reaction-Signal-Integration ───────────────────────────────────────

  for (const signal of reactionSignals || []) {
    if (!signal || typeof signal !== "object") continue;

    const polarity = Number(signal.polarity ?? 0);
    const intensity = clamp01(Number(signal.intensity ?? 0.5));
    const explicitness = String(signal.explicitness || "");

    if (polarity > 0) {
      // Positive Reaktion → Freude + Vertrauen
      valence.joy = Math.max(valence.joy, intensity * 0.8);
      valence.trust = Math.max(valence.trust, intensity * 0.5);
    }
    if (polarity < 0) {
      // Negative Reaktion → Traurigkeit + Ärger
      valence.sadness = Math.max(valence.sadness, intensity * 0.6);
      valence.anger = Math.max(valence.anger, intensity * 0.5);
    }
    if (explicitness === "explicit_correction") {
      valence.anger = Math.max(valence.anger, 0.4);
      valence.surprise = Math.max(valence.surprise, 0.2);
    }
    if (explicitness === "explicit_instruction") {
      valence.anticipation = Math.max(valence.anticipation, 0.3);
    }
    if (explicitness === "ambiguous") {
      valence.surprise = Math.max(valence.surprise, 0.15);
    }
  }

  // ─── 4. Aggregation ───────────────────────────────────────────────────────

  // Berechne Dominante Emotion
  const entries = Object.entries(valence);
  const dominant = entries.reduce((a, b) => (a[1] > b[1] ? a : b));

  // Intensität = Durchschnitt aller Dimensionen
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  const emotionalIntensity = total / entries.length;

  return {
    ...valence,
    emotionalIntensity: clamp01(emotionalIntensity),
    emotionalDominant: dominant[1] > 0.15 ? dominant[0] : "neutral",
  };
}

/**
 * Serialisiert eine Valenz zu einem LanceDB-kompatiblen String.
 * LanceDB unterstützt keine verschachtelten Structs in allen Versionen.
 */
export function serializeEmotionalValence(valence) {
  const parts = [];
  for (const dim of EMOTION_DIMENSIONS) {
    const v = valence?.[dim] ?? 0;
    if (v > 0) parts.push(`${dim}:${v.toFixed(2)}`);
  }
  return parts.join(",");
}

/**
 * Deserialisiert einen Valenz-String zurück zu einem Objekt.
 */
export function deserializeEmotionalValence(str) {
  const valence = {};
  for (const dim of EMOTION_DIMENSIONS) valence[dim] = 0;
  if (!str || typeof str !== "string") return valence;

  for (const part of str.split(",")) {
    const [key, val] = part.split(":");
    if (key && val && EMOTION_DIMENSIONS.includes(key)) {
      const n = Number.parseFloat(val);
      if (Number.isFinite(n)) valence[key] = clamp01(n);
    }
  }
  return valence;
}

/**
 * Berechnet die Cosine-Similarity zwischen zwei Valenz-Vektoren.
 * Rückgabe in [-1, 1].
 */
export function valenceCosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const dim of EMOTION_DIMENSIONS) {
    const av = a?.[dim] ?? 0;
    const bv = b?.[dim] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Gibt ein Emoji für eine dominante Emotion zurück.
 */
export function emotionEmoji(dominant) {
  const map = {
    joy: "😊",
    trust: "🤝",
    anticipation: "👀",
    sadness: "😔",
    anger: "😤",
    fear: "😰",
    surprise: "😲",
    neutral: "😐",
  };
  return map[dominant] || "😐";
}


