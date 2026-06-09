/**
 * mai/tier1-lexicon.js — Tier-1 lexicon-based emotion classifier.
 *
 * Fast, deterministic emotion detection using a curated word-level lexicon.
 * Falls back to Tier 2 when no matches or confidence is too low.
 */

import { EmotionScore } from "./emotion-score.js";

/**
 * VAD mapping for base emotions (Warriner et al. inspired).
 * @type {Record<string, {v: number, a: number, d: number}>}
 */
const EMOTION_VAD = {
  anger:        { v: -0.60, a: 0.60, d: 0.40 },
  disgust:      { v: -0.60, a: 0.20, d: 0.10 },
  fear:         { v: -0.64, a: 0.60, d: -0.30 },
  joy:          { v: 0.80, a: 0.40, d: 0.30 },
  sadness:      { v: -0.70, a: -0.20, d: -0.40 },
  surprise:     { v: 0.20, a: 0.80, d: 0.10 },
  trust:        { v: 0.50, a: 0.10, d: 0.30 },
  anticipation: { v: 0.30, a: 0.40, d: 0.20 },
  neutral:      { v: 0.00, a: 0.00, d: 0.00 },
};

/**
 * Curated English lexicon. Each word maps to an emotion label.
 * @type {Record<string, string>}
 */
const LEXICON_EN = {
  // joy
  happy: "joy", happiness: "joy", joyful: "joy", delighted: "joy", glad: "joy",
  pleased: "joy", cheerful: "joy", elated: "joy", ecstatic: "joy", blissful: "joy",
  overjoyed: "joy", jubilant: "joy", euphoric: "joy", thrilled: "joy", content: "joy",
  satisfied: "joy", gratified: "joy", blessed: "joy", wonderful: "joy", amazing: "joy",
  fantastic: "joy", awesome: "joy", excellent: "joy", great: "joy", lovely: "joy",
  beautiful: "joy", perfect: "joy", brilliant: "joy", fabulous: "joy", terrific: "joy",
  marvelous: "joy", splendid: "joy", superb: "joy", outstanding: "joy", incredible: "joy",
  phenomenal: "joy", magnificent: "joy", spectacular: "joy", radiant: "joy", sunny: "joy",
  upbeat: "joy", optimistic: "joy", hopeful: "joy", enthusiastic: "joy", excited: "joy",
  eager: "joy", keen: "joy", lively: "joy", vibrant: "joy", sparkling: "joy",
  // trust
  trust: "trust", trusting: "trust", trusted: "trust", trustworthy: "trust", reliable: "trust",
  dependable: "trust", loyal: "trust", faithful: "trust", honest: "trust", sincere: "trust",
  genuine: "trust", authentic: "trust", secure: "trust", safe: "trust", confident: "trust",
  assured: "trust", certain: "trust", sure: "trust", convinced: "trust", believe: "trust",
  belief: "trust", respect: "trust", admire: "trust", esteem: "trust", regard: "trust",
  // anticipation
  anticipate: "anticipation", expecting: "anticipation", expect: "anticipation", hopeful: "anticipation",
  eager: "anticipation", curious: "anticipation", interested: "anticipation", intrigued: "anticipation",
  looking: "anticipation", forward: "anticipation", await: "anticipation", awaiting: "anticipation",
  prepare: "anticipation", ready: "anticipation", excited: "anticipation", motivated: "anticipation",
  ambitious: "anticipation", determined: "anticipation", focused: "anticipation", patient: "anticipation",
  // surprise
  surprise: "surprise", surprised: "surprise", astonishing: "surprise", amazed: "surprise",
  stunned: "surprise", shocked: "surprise", startled: "surprise", astounded: "surprise",
  bewildered: "surprise", unexpected: "surprise", sudden: "surprise", abrupt: "surprise",
  wow: "surprise", whoa: "surprise", unbelievable: "surprise", incredible: "surprise",
  // anger
  angry: "anger", anger: "anger", furious: "anger", mad: "anger", rage: "anger",
  enraged: "anger", irate: "anger", livid: "anger", incensed: "anger", outraged: "anger",
  annoyed: "anger", irritated: "anger", frustrated: "anger", aggravated: "anger", hostile: "anger",
  bitter: "anger", resentful: "anger", indignant: "anger", exasperated: "anger", infuriated: "anger",
  pissed: "anger", wrath: "anger", fury: "anger", hateful: "anger", spiteful: "anger",
  venomous: "anger", vicious: "anger", cruel: "anger", brutal: "anger", harsh: "anger",
  // disgust
  disgust: "disgust", disgusted: "disgust", revulsion: "disgust", repulsed: "disgust",
  nauseated: "disgust", sick: "disgust", gross: "disgust", nasty: "disgust", vile: "disgust",
  foul: "disgust", rotten: "disgust", filthy: "disgust", dirty: "disgust", obscene: "disgust",
  offensive: "disgust", distasteful: "disgust", aversion: "disgust", loathing: "disgust",
  contempt: "disgust", scorn: "disgust", disdain: "disgust", detest: "disgust", abhor: "disgust",
  // fear
  fear: "fear", afraid: "fear", scared: "fear", frightened: "fear", terrified: "fear",
  petrified: "fear", horrified: "fear", panicked: "fear", anxious: "fear", worried: "fear",
  nervous: "fear", uneasy: "fear", tense: "fear", dread: "fear", alarmed: "fear",
  startled: "fear", threatened: "fear", insecure: "fear", vulnerable: "fear", helpless: "fear",
  paranoid: "fear", suspicious: "fear", cautious: "fear", wary: "fear", timid: "fear",
  shy: "fear", cowardly: "fear", weak: "fear", fragile: "fear", exposed: "fear",
  // sadness
  sad: "sadness", sadness: "sadness", unhappy: "sadness", miserable: "sadness", depressed: "sadness",
  dejected: "sadness", despondent: "sadness", despair: "sadness", hopeless: "sadness", gloomy: "sadness",
  melancholy: "sadness", sorrow: "sadness", sorrowful: "sadness", grief: "sadness", grieving: "sadness",
  mournful: "sadness", heartbroken: "sadness", devastated: "sadness", crushed: "sadness", broken: "sadness",
  lonely: "sadness", isolated: "sadness", abandoned: "sadness", rejected: "sadness", hurt: "sadness",
  wounded: "sadness", disappointed: "sadness", disillusioned: "sadness", defeated: "sadness", helpless: "sadness",
  powerless: "sadness", empty: "sadness", numb: "sadness", tearful: "sadness", crying: "sadness",
  weeping: "sadness", blue: "sadness", down: "sadness", low: "sadness", upset: "sadness",
  // positive polarity markers
  good: "joy", best: "joy", better: "joy", love: "joy", loved: "joy", loving: "joy",
  like: "joy", liked: "joy", enjoy: "joy", enjoyed: "joy", fun: "joy", funny: "joy",
  nice: "joy", kind: "trust", gentle: "trust", warm: "trust", friendly: "trust",
  // negative polarity markers
  bad: "anger", worst: "anger", worse: "anger", hate: "anger", hated: "anger", hating: "anger",
  dislike: "disgust", evil: "disgust", wicked: "disgust", wrong: "disgust", fail: "sadness",
  failed: "sadness", failure: "sadness", loss: "sadness", lose: "sadness", lost: "sadness",
  pain: "sadness", painful: "sadness", suffer: "sadness", suffering: "sadness", struggle: "sadness",
  // neutral / filler
  okay: "neutral", ok: "neutral", fine: "neutral", alright: "neutral", normal: "neutral",
  average: "neutral", standard: "neutral", usual: "neutral", regular: "neutral", typical: "neutral",
};

/**
 * Curated German lexicon. Each word maps to an emotion label.
 * @type {Record<string, string>}
 */
const LEXICON_DE = {
  // freude (joy)
  glücklich: "joy", glück: "joy", froh: "joy", freudig: "joy", erfreut: "joy",
  zufrieden: "joy", zufriedenheit: "joy", begeistert: "joy", enthusiastisch: "joy", euphorisch: "joy",
  ekstatisch: "joy", entzückt: "joy", erfreulich: "joy", wunderbar: "joy", wundervoll: "joy",
  toll: "joy", super: "joy", klasse: "joy", spitze: "joy", prima: "joy",
  ausgezeichnet: "joy", hervorragend: "joy", großartig: "joy", fantastisch: "joy", phänomenal: "joy",
  perfekt: "joy", schön: "joy", wunderschön: "joy", herrlich: "joy", strahlend: "joy",
  lebendig: "joy", lebhaft: "joy", heiter: "joy", optimistisch: "joy", hoffnungsvoll: "joy",
  positiv: "joy", gut: "joy", besser: "joy", beste: "joy", liebe: "joy", geliebt: "joy",
  lieben: "joy", mögen: "joy", gemocht: "joy", genießen: "joy", genossen: "joy",
  spaß: "joy", lustig: "joy", nett: "joy", freundlich: "trust", warm: "trust", sanft: "trust",
  // vertrauen (trust)
  vertrauen: "trust", vertrauensvoll: "trust", verlässlich: "trust", zuverlässig: "trust", treu: "trust",
  loyal: "trust", ehrlich: "trust", aufrichtig: "trust", echt: "trust", authentisch: "trust",
  sicher: "trust", geschützt: "trust", gewiss: "trust", überzeugt: "trust", glauben: "trust",
  glaube: "trust", respekt: "trust", respektieren: "trust", bewundern: "trust", achten: "trust",
  achtung: "trust", anerkennen: "trust", anerkennung: "trust", geborgen: "trust", fest: "trust",
  // vorfreude (anticipation)
  erwarten: "anticipation", erwartung: "anticipation", erwarten: "anticipation", hoffen: "anticipation",
  hoffnung: "anticipation", gespannt: "anticipation", neugierig: "anticipation", interessiert: "anticipation",
  fasziniert: "anticipation", gierig: "anticipation", hungrig: "anticipation", bereit: "anticipation",
  vorbereitet: "anticipation", motiviert: "anticipation", ehrgeizig: "anticipation", entschlossen: "anticipation",
  fokussiert: "anticipation", geduldig: "anticipation", geduld: "anticipation", gespannt: "anticipation",
  // überraschung (surprise)
  überraschung: "surprise", überrascht: "surprise", erstaunt: "surprise", verblüfft: "surprise",
  geschockt: "surprise", schockiert: "surprise", bestürzt: "surprise", plötzlich: "surprise",
  unerwartet: "surprise", überraschend: "surprise", wow: "surprise", unglaublich: "surprise",
  unglaublich: "surprise", erstaunlich: "surprise", verwundert: "surprise", sprachlos: "surprise",
  // wut (anger)
  wütend: "anger", wut: "anger", zorn: "anger", zornig: "anger", böse: "anger",
  ärger: "anger", verärgert: "anger", wütend: "anger", rasend: "anger", furios: "anger",
  wutschnaubend: "anger", empört: "anger", entrüstet: "anger", genervt: "anger", irritiert: "anger",
  frustriert: "anger", aggressiv: "anger", feindselig: "anger", gehässig: "anger", bitter: "anger",
  verbittert: "anger", nachtragend: "anger", hass: "anger", hassen: "anger", gehassig: "anger",
  gemein: "anger", grausam: "anger", brutal: "anger", hart: "anger", streng: "anger",
  // ekel (disgust)
  ekel: "disgust", ekelhaft: "disgust", ekelerregend: "disgust", abscheu: "disgust", abscheulich: "disgust",
  widerlich: "disgust", widerwärtig: "disgust", übel: "disgust", übelkeit: "disgust", schmutzig: "disgust",
  dreckig: "disgust", faul: "disgust", verdorben: "disgust", obszön: "disgust", anstößig: "disgust",
  geschmacklos: "disgust", abneigung: "disgust", verachtung: "disgust", verachten: "disgust", geringschätzung: "disgust",
  verabscheuen: "disgust", hassen: "disgust", // angst (fear)
  angst: "fear", ängstlich: "fear", ängstlich: "fear", furcht: "fear", fürchten: "fear",
  erschrocken: "fear", entsetzt: "fear", panik: "fear", panisch: "fear", besorgt: "fear",
  besorgnis: "fear", nervös: "fear", unruhig: "fear", beunruhigt: "fear", gespannt: "fear",
  bedroht: "fear", bedrohung: "fear", unsicher: "fear", verletzlich: "fear", hilflos: "fear",
  paranoid: "fear", misstrauisch: "fear", vorsichtig: "fear", achtsam: "fear", ängstlich: "fear",
  schüchtern: "fear", feige: "fear", schwach: "fear", zerbrechlich: "fear", offen: "fear",
  // trauer (sadness)
  traurig: "sadness", trauer: "sadness", unglücklich: "sadness", elend: "sadness", deprimiert: "sadness",
  niedergeschlagen: "sadness", mutlos: "sadness", verzweifelt: "sadness", hoffnungslos: "sadness", düster: "sadness",
  melancholisch: "sadness", schwermütig: "sadness", kummer: "sadness", betrübt: "sadness", leid: "sadness",
  leidend: "sadness", herzzerreißend: "sadness", zerstört: "sadness", gebrochen: "sadness",
  einsam: "sadness", isoliert: "sadness", verlassen: "sadness", zurückgewiesen: "sadness", verletzt: "sadness",
  verwundet: "sadness", enttäuscht: "sadness", desillusioniert: "sadness", geschlagen: "sadness", ohnmächtig: "sadness",
  machtlos: "sadness", leer: "sadness", gefühllos: "sadness", tränenreich: "sadness", weinend: "sadness",
  weinen: "sadness", tränen: "sadness", niedergeschlagen: "sadness", bedrückt: "sadness", untröstlich: "sadness",
  // negative polarity
  schlecht: "anger", schlimm: "anger", schlimmer: "anger", schlimmste: "anger", hass: "anger",
  hassen: "anger", abneigung: "disgust", böse: "disgust", falsch: "disgust", scheitern: "sadness",
  gescheitert: "sadness", scheitern: "sadness", versagen: "sadness", verlust: "sadness", verlieren: "sadness",
  verloren: "sadness", schmerz: "sadness", schmerzhaft: "sadness", leiden: "sadness", leidend: "sadness",
  kämpfen: "sadness", kampf: "sadness", kämpfend: "sadness",
  // neutral
  okay: "neutral", ok: "neutral", normal: "neutral", durchschnittlich: "neutral",
  standard: "neutral", üblich: "neutral", gewöhnlich: "neutral", typisch: "neutral", mittel: "neutral",
};

/**
 * Tier-1 lexicon-based emotion classifier.
 */
export class Tier1LexiconClassifier {
  /**
   * @param {object} [options]
   * @param {Record<string, string>} [options.customEn] — additional English lexicon entries
   * @param {Record<string, string>} [options.customDe] — additional German lexicon entries
   */
  constructor(options = {}) {
    this.lexiconEn = { ...LEXICON_EN, ...(options.customEn || {}) };
    this.lexiconDe = { ...LEXICON_DE, ...(options.customDe || {}) };
  }

  /**
   * Detect whether the text is primarily German or English by counting
   * marker words present in each lexicon.
   *
   * @param {string} text
   * @returns {"en" | "de" | "mixed"}
   */
  _detectLanguage(text) {
    const words = text.toLowerCase().match(/\b\w+\b/g) || [];
    let deHits = 0;
    let enHits = 0;
    for (const w of words) {
      if (this.lexiconDe[w]) deHits++;
      if (this.lexiconEn[w]) enHits++;
    }
    if (deHits > enHits * 1.5) return "de";
    if (enHits > deHits * 1.5) return "en";
    return "mixed";
  }

  /**
   * Classify emotion from raw text using the built-in lexicon.
   *
   * @param {string} text
   * @param {"user" | "assistant"} [source]
   * @returns {EmotionScore | null} — null when no lexicon matches or max score < 0.1
   */
  classify(text, source = "user") {
    const words = text.toLowerCase().match(/\b\w+\b/g) || [];
    if (words.length === 0) return null;

    const lang = this._detectLanguage(text);
    const primaryLex = lang === "de" ? this.lexiconDe : this.lexiconEn;
    const fallbackLex = lang === "de" ? this.lexiconEn : this.lexiconDe;

    const emotionCounts = {};
    let matchedWords = 0;
    let positiveWords = 0;
    let negativeWords = 0;

    for (const w of words) {
      let emotion = primaryLex[w] || fallbackLex[w];
      if (!emotion) continue;

      matchedWords++;
      emotionCounts[emotion] = (emotionCounts[emotion] || 0) + 1;

      // Simple polarity scoring
      const vad = EMOTION_VAD[emotion];
      if (vad && vad.v > 0) positiveWords++;
      if (vad && vad.v < 0) negativeWords++;
    }

    if (matchedWords === 0) return null;

    // Normalize counts to scores
    const emotionScores = {};
    for (const [emo, count] of Object.entries(emotionCounts)) {
      emotionScores[emo] = count / matchedWords;
    }

    // Find primary emotion (max score)
    let primary = "neutral";
    let maxScore = -Infinity;
    let secondary = null;
    for (const [emo, score] of Object.entries(emotionScores)) {
      if (score > maxScore) {
        maxScore = score;
        primary = emo;
      }
    }
    // Secondary = second highest, if within 0.15 of primary
    let secondMax = -Infinity;
    for (const [emo, score] of Object.entries(emotionScores)) {
      if (emo !== primary && score > secondMax) {
        secondMax = score;
        if (maxScore - score < 0.15) secondary = emo;
      }
    }

    if (maxScore < 0.1) return null;

    // Get VAD for primary emotion
    let vad = { ...EMOTION_VAD[primary] };

    // Polarity compound in [-1, 1]
    const totalPolarityWords = positiveWords + negativeWords;
    const compound = totalPolarityWords === 0
      ? 0
      : (positiveWords - negativeWords) / Math.max(1, totalPolarityWords);

    // Blend VAD valence with polarity
    vad.v = 0.7 * vad.v + 0.3 * compound;
    // Clamp
    vad.v = Math.max(-1, Math.min(1, vad.v));

    // Intensity = min(1.0, sqrt(v² + a² + d²) / sqrt(3))
    const intensity = Math.min(
      1.0,
      Math.sqrt(vad.v * vad.v + vad.a * vad.a + vad.d * vad.d) / Math.sqrt(3)
    );

    // Confidence = min(1.0, matched_words / max(1, total_words) * 2 + 0.3)
    const confidence = Math.min(
      1.0,
      (matchedWords / Math.max(1, words.length)) * 2 + 0.3
    );

    return new EmotionScore({
      valence: vad.v,
      arousal: vad.a,
      dominance: vad.d,
      intensity,
      primary_emotion: primary,
      secondary_emotion: secondary,
      emotion_labels: emotionScores,
      language: lang,
      source,
      tier_used: 1,
      confidence,
      timestamp: new Date(),
    });
  }
}
