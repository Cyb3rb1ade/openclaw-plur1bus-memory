/**
 * lib/episodes.js — Episoden-Engine für PLUR1BUS.
 *
 * Gruppiert Turns zu Episoden (Geschichten statt isolierter Fakten).
 * Jede Episode hat eine narrative Struktur: Setup → Wendepunkt → Auflösung.
 *
 * Abhängigkeiten: Phase 1 (Emotionale Valenz), Phase 2 (Light Dreaming)
 */

import { randomUUID } from "node:crypto";
import {
  LLM_RESULT_CACHE_PURPOSES,
  withLlmCallContext,
  withLlmResultCacheContext,
} from "./llm-result-cache.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { throwIfAborted } from "./abort.js";

const DEFAULT_MAX_GAP_MINUTES = 30;
// 7.12.40: 2 statt 5. Jeder agent_end liefert nur die neuen Turns seit dem
// Watermark (meist 2-4), die Anreicherung feuerte also nie — jede Karte
// hiess "Gespraech vom …" mit "2 Turns, 0 Min" (Bernd, 10.09.2026 21:07).
const MIN_TURNS_FOR_LLM_NARRATIVE = 2;
const MAX_EPISODE_TURNS = 50;
const EMOTION_DIMS = ["joy", "trust", "anticipation", "sadness", "anger", "fear", "surprise"];
const LLM_EMOTIONS = new Set([...EMOTION_DIMS, "disgust", "neutral"]);
const ENRICH_TURN_CHARS = 600;
const ENRICH_TOTAL_CHARS = 6000;
const MAX_TOPICS = 5;
const MAX_PEOPLE = 5;

/**
 * Gruppiert Turns in Episoden basierend auf zeitlicher Nähe.
 *
 * @param {Array} turns — Turn-Events (mit createdAt als ISO-String)
 * @param {Object} opts — { maxGapMinutes, maxEpisodeTurns }
 * @returns {Array<Array>} — Gruppen von Turns
 */
export function groupTurnsIntoEpisodes(turns, opts = {}) {
  if (!turns || turns.length === 0) return [];

  const maxGapMs = (opts.maxGapMinutes || DEFAULT_MAX_GAP_MINUTES) * 60 * 1000;
  const maxEpisodeTurns = Number.isFinite(opts.maxEpisodeTurns)
    ? Math.max(1, Math.floor(opts.maxEpisodeTurns))
    : MAX_EPISODE_TURNS;

  // Sortiere nach Zeit
  const sorted = [...turns].sort((a, b) => {
    const ta = new Date(a.createdAt || 0).getTime();
    const tb = new Date(b.createdAt || 0).getTime();
    return ta - tb;
  });

  const episodes = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const prevTime = new Date(prev.createdAt || 0).getTime();
    const currTime = new Date(curr.createdAt || 0).getTime();

    if (currTime - prevTime > maxGapMs || current.length >= maxEpisodeTurns) {
      // Neue Episode
      episodes.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }

  if (current.length > 0) episodes.push(current);
  return episodes;
}

const participantNameCache = new Map(); // workspaceDir → { key, names }

function readNameFromFile(path) {
  try {
    const text = readFileSync(path, "utf8").slice(0, 4000);
    const m = /\*\*Name:\*\*\s*([^\n]+)/.exec(text);
    if (!m) return null;
    const name = m[1].replace(/[*_`]/g, "").trim();
    return name && name !== "—" && name !== "-" ? name.slice(0, 60) : null;
  } catch (_) {
    return null;
  }
}

/**
 * 7.12.40: Teilnehmer heissen wie die Menschen und Agenten, nicht wie
 * grossgeschriebene Woerter. Quelle: `USER.md` (`**Name:** Christian`) und
 * `IDENTITY.md` (`**Name:** Bernd dasBot`) im Workspace, gecacht nach mtime.
 * Rueckfall: "Nutzer" und die Agent-ID.
 */
export function resolveParticipantNames(workspaceDir, { agentId = "agent" } = {}) {
  const fallback = { user: "Nutzer", assistant: agentId || "agent" };
  if (!workspaceDir) return fallback;
  try {
    const userPath = join(workspaceDir, "USER.md");
    const identityPath = join(workspaceDir, "IDENTITY.md");
    const stamp = (path) => { try { return String(statSync(path).mtimeMs); } catch (_) { return "-"; } };
    const key = `${agentId}|${stamp(userPath)}|${stamp(identityPath)}`;
    const cached = participantNameCache.get(workspaceDir);
    if (cached && cached.key === key) return cached.names;
    const names = {
      user: readNameFromFile(userPath) || fallback.user,
      assistant: readNameFromFile(identityPath) || fallback.assistant,
    };
    participantNameCache.set(workspaceDir, { key, names });
    return names;
  } catch (_) {
    return fallback;
  }
}

/**
 * Teilnehmer aus den Sprecherrollen der Turns (plus Personen, die das
 * Modell im Gespraech erkannt hat). Der fruehere Regex auf grossgeschriebene
 * Woerter lieferte Satzanfaenge und Nomen ("Endlich, Aber, Test, Kumpel").
 */
// 7.12.42: participants = wer gesprochen hat; Personen, ueber die gesprochen
// wurde, stehen getrennt in `mentioned` (Bernd 10.09.2026 22:1x: „Erwaehnung
// ≠ Anwesenheit", sonst falsch-positive Treffer bei „wann war X dabei?").
function extractParticipants(turns, { names = null } = {}) {
  const labels = names || { user: "Nutzer", assistant: "agent" };
  const out = [];
  const push = (value) => {
    const v = String(value || "").trim();
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  };
  if (turns.some((t) => t.role === "user")) push(labels.user);
  if (turns.some((t) => t.role === "assistant")) push(labels.assistant);
  return out;
}

const TOPIC_NOISE = new Set([
  "visible", "thinking", "transcript", "audio", "media", "attached", "caption",
  "nicht", "morgen", "reden", "wieder", "soweit", "brauche", "haben", "hatte",
  "hattest", "werden", "wurde", "wurden", "worden", "koennen", "können", "konnte",
  "machen", "gemacht", "sagen", "gesagt", "gehen", "kommen", "geben", "sehen",
  "wissen", "denke", "glaube", "einfach", "eigentlich", "gerade", "heute",
  "gestern", "jetzt", "dieser", "diese", "dieses", "jener", "keine", "keinen",
  "meine", "meinen", "deine", "deinen", "seine", "seinen", "ihre", "ihren",
  "unsere", "eure", "etwas", "nichts", "alles", "wirklich", "natürlich",
  "vielleicht", "sowieso", "irgendwie", "irgendwas", "okay", "danke", "bitte",
  "hallo", "moin", "servus", "genau", "gerne", "super", "prima", "sicher",
  "wollen", "wollte", "sollen", "sollte", "müssen", "muessen", "musste",
  "dürfen", "duerfen", "würde", "wuerde", "wären", "waere", "wäre", "waren",
  "damit", "dabei", "dafür", "dafuer", "davon", "dazu", "darauf", "darin",
  "welche", "welcher", "welches", "diesem", "diesen", "einem", "einen", "einer",
  "eines", "unter", "ueber", "zwischen", "weiter", "weitere", "anderen",
  "user", "assistant", "agent", "system", "reply", "message", "nachricht",
]);

function cleanTopicText(text) {
  return String(text || "")
    .replace(/\[(?:audio transcript|media attached|user sent media|voice message)[^\]]*\]/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/<[^>]{1,80}>/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/[\p{Extended_Pictographic}]/gu, " ");
}

/**
 * Themen ohne Modell: bevorzugt im Original grossgeschriebene, nicht
 * satzinitiale Woerter (deutsche Nomen), streicht Platzhalter, URLs, Markup,
 * Zahlen und Rauschwoerter. Mit Modell ersetzt `enrichEpisodeNarratively`
 * das Ergebnis durch dessen `topics`.
 */
function extractTopics(turns) {
  const score = new Map();
  const bump = (word, weight) => score.set(word, (score.get(word) || 0) + weight);
  for (const turn of turns) {
    if (turn.role === "tool") continue;
    const text = cleanTopicText(turn.content);
    const sentences = text.split(/[.!?\n]+/);
    for (const sentence of sentences) {
      const tokens = sentence.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);
      tokens.forEach((token, index) => {
        if (/\d/.test(token) || token.length < 5 || token.length > 30) return;
        const lower = token.toLowerCase();
        if (isStopWord(lower) || TOPIC_NOISE.has(lower)) return;
        const capitalized = /^\p{Lu}\p{Ll}+/u.test(token);
        // Satzanfang zaehlt nicht als Nomen-Indiz.
        bump(lower, capitalized && index > 0 ? 3 : 1);
      });
    }
  }
  return [...score.entries()]
    .filter(([, weight]) => weight >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TOPICS)
    .map(([w]) => w);
}

function isStopWord(w) {
  const stops = new Set([
    "dass", "weil", "wenn", "dann", "aber", "oder", "und", "mit", "für", "von", "auf",
    "nach", "bei", "über", "unter", "vor", "hinter", "zwischen", "durch", "gegen",
    "ohne", "um", "bis", "seit", "während", "trotz", "wegen", "statt", "trotzdem",
    "jedoch", "dennoch", "also", "somit", "deshalb", "deswegen", "daher", "darum",
    "this", "that", "with", "from", "have", "been", "were", "they", "their", "what",
    "when", "where", "which", "while", "about", "would", "could", "should", "there",
    "here", "than", "then", "them", "these", "those", "very", "just", "only", "also",
    "well", "like", "know", "think", "make", "want", "come", "take", "see", "look",
    "find", "give", "tell", "work", "call", "try", "ask", "need", "feel", "become",
    "leave", "put", "mean", "keep", "let", "begin", "seem", "help", "show", "hear",
    "play", "run", "move", "live", "believe", "bring", "happen", "write", "provide",
    "sit", "stand", "lose", "pay", "meet", "include", "continue", "set", "learn",
    "change", "lead", "understand", "watch", "follow", "stop", "create", "speak",
    "read", "allow", "add", "spend", "grow", "open", "walk", "offer", "remember",
    "love", "consider", "appear", "buy", "wait", "serve", "die", "send", "expect",
    "build", "stay", "fall", "cut", "reach", "kill", "remain", "suggest", "raise",
    "pass", "sell", "require", "report", "decide", "pull", "auch", "noch", "schon",
    "immer", "schon", "mal", "ganz", "sehr", "viel", "mehr", "mich", "dich", "sich",
    "euch", "uns", "mein", "dein", "sein", "ihr", "unser", "euer", "kein", "jeder",
    "alle", "manche", "viele", "wenige", "meiste", "andere", "solche", "welche",
  ]);
  return stops.has(w);
}

/**
 * Emotionaler Ton einer Episode.
 *
 * 7.12.40: Turn-Events tragen keine Valenz (createTurnEvent setzt keine),
 * die Mittelung ueber Turns lieferte deshalb immer Null — und die aelteren
 * Karten mit "fear 0,14" stammten aus winzigen Restwerten. Quelle ist jetzt
 * der Stimmungs-Snapshot der EmotionEngine zum Zeitpunkt des agent_end
 * (`describeMood()`: label, dominant, intensity hoch/mittel/niedrig, details).
 * Dominant nur bei mittel/hoch, sonst neutral; Intensitaet = staerkste
 * Dimension statt Mittel ueber sieben.
 */
function computeEpisodeEmotion(turns, mood = null) {
  const tone = {};
  for (const d of EMOTION_DIMS) tone[d] = 0;
  if (mood && typeof mood === "object" && mood.details && typeof mood.details === "object") {
    for (const d of EMOTION_DIMS) {
      const v = Number(mood.details[d]);
      tone[d] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    }
    const strong = mood.intensity === "hoch" || mood.intensity === "mittel";
    const dominant = strong && EMOTION_DIMS.includes(mood.dominant) ? mood.dominant : "neutral";
    return { tone, dominant, intensity: Math.max(...EMOTION_DIMS.map((d) => tone[d])) };
  }
  // Rueckfall: Valenzen an den Turns (aeltere Aufrufer/Tests).
  let count = 0;
  for (const turn of turns) {
    if (!turn.emotionalValence) continue;
    const valence = typeof turn.emotionalValence === "string"
      ? parseSimpleValence(turn.emotionalValence)
      : turn.emotionalValence;
    if (!valence) continue;
    for (const d of EMOTION_DIMS) tone[d] += valence[d] || 0;
    count++;
  }
  if (count > 0) for (const d of EMOTION_DIMS) tone[d] /= count;
  const [topDim, topVal] = Object.entries(tone).reduce((a, b) => (a[1] >= b[1] ? a : b), ["neutral", 0]);
  return { tone, dominant: topVal >= 0.25 ? topDim : "neutral", intensity: topVal };
}

export function locationFromSessionKey(sessionKey) {
  const key = String(sessionKey || "");
  if (/:direct:/.test(key)) return "dm";
  if (/:group:/.test(key)) return "group";
  if (/:heartbeat/.test(key)) return "heartbeat";
  if (/:cron/.test(key)) return "cron";
  return "session";
}

function parseSimpleValence(str) {
  if (!str || typeof str !== "string") return null;
  const out = {};
  for (const part of str.split(",")) {
    const [k, v] = part.split(":");
    if (k && v) out[k.trim()] = parseFloat(v.trim()) || 0;
  }
  return out;
}

/**
 * Berechnet die Vividness (Erinnerungs-Stärke) einer Episode.
 */
export function calculateVividness(episode) {
  const intensity = episode.emotionalTone?.emotionalIntensity ||
    Object.values(episode.emotionalTone || {}).reduce((a, b) => a + b, 0) / 7 || 0;

  // Use startTime, then createdAt, then epoch (very old) — never Date.now()
  // because that would make missing-timestamp episodes appear fresh forever.
  const timeAnchor = episode.startTime || episode.createdAt || 0;
  const ageDays = (Date.now() - new Date(timeAnchor).getTime()) / 86400000;
  const recencyBoost = Math.max(0, 1 - ageDays / 30); // 1.0 bei heute, 0 bei 30 Tagen

  const replayCount = episode.replayCount || 0;
  const replayBoost = Math.min(replayCount / 10, 1); // Max +1.0 bei 10 Replays

  const durationMinutes = episode.durationMinutes || 0;
  const durationFactor = Math.min(durationMinutes / 60, 1); // Max +1.0 bei 60 Min

  return intensity * 0.3 + recencyBoost * 0.3 + replayBoost * 0.2 + durationFactor * 0.2;
}

/**
 * Erstellt eine Episode aus einer Gruppe von Turns.
 */
export function createEpisode(turns, opts = {}) {
  if (!turns || turns.length === 0) return null;

  const startTime = new Date(turns[0].createdAt || Date.now());
  const endTime = new Date(turns[turns.length - 1].createdAt || Date.now());
  const durationMs = endTime.getTime() - startTime.getTime();
  const durationMinutes = Math.round(durationMs / 60000);

  const participants = extractParticipants(turns, { names: opts.participantNames || null });
  const topics = extractTopics(turns);
  const emotion = computeEpisodeEmotion(turns, opts.mood || null);
  const emotionalTone = emotion.tone;

  return {
    id: randomUUID(),
    mentioned: [],
    workspaceKey: opts.workspaceKey || turns[0]?.workspaceKey || "default",
    agentId: opts.agentId || turns[0]?.agentId || "default",
    title: opts.title || `Gespräch vom ${startTime.toISOString().slice(0, 10)}`,
    summary: opts.summary || `${turns.length} Turns, ${durationMinutes} Min`,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    durationMinutes,
    participants,
    topics,
    memoryIds: opts.memoryIds || turns.map(t => t.id).filter(Boolean),
    emotionalTone,
    emotionalDominant: emotion.dominant,
    emotionalIntensity: emotion.intensity,
    location: opts.location || locationFromSessionKey(opts.sessionKey),
    importance: opts.importance || 0.6,
    narrativeArc: opts.narrativeArc || "exploration",
    turningPoint: opts.turningPoint || "",
    vividness: 0, // Wird nach der Berechnung gesetzt
    replayCount: opts.replayCount || 0,
    lastReplayed: opts.lastReplayed || null,
    createdAt: new Date().toISOString(),
    turnCount: turns.length,
    visibility: opts.visibility || {
      scope: "agent_private",
      agentId: opts.agentId || turns[0]?.agentId || "default",
      workspaceIdentity: opts.workspaceKey || turns[0]?.workspaceKey || "",
      ownerUserId: opts.ownerUserId || "",
    },
  };
}

/**
 * Erzeugt narrative Metadaten (Titel, Arc, Wendepunkt) via LLM.
 * Nur für Episoden mit >= MIN_TURNS_FOR_LLM_NARRATIVE Turns.
 * @param {object} episode
 * @param {Array<object>} turns
 * @param {object} llmCfg
 * @param {Function} callLlm
 * @param {object} [opts]
 * @param {string} [opts.agentId]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>}
 */
export async function enrichEpisodeNarratively(episode, turns, llmCfg, callLlm, opts = {}) {
  throwIfAborted(opts.signal, "episode extraction aborted");
  if (!turns || turns.length < MIN_TURNS_FOR_LLM_NARRATIVE) {
    return { ...episode, narrativeArc: episode.narrativeArc || "exploration" };
  }

  const names = opts.participantNames || { user: "Nutzer", assistant: episode.agentId || "Agent" };
  // Budget von hinten fuellen: bei einer fortgeschriebenen Episode zaehlen
  // die neuesten Turns, der Anfang darf abgeschnitten sein.
  let budget = ENRICH_TOTAL_CHARS;
  const lines = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === "tool") continue;
    const speaker = t.role === "user" ? names.user : names.assistant;
    const text = cleanTopicText(t.content).replace(/\s+/g, " ").trim().slice(0, ENRICH_TURN_CHARS);
    if (!text) continue;
    const line = `[${speaker}] ${text}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.unshift(line);
  }
  if (lines.length === 0) return episode;
  const sessionText = lines.join("\n");

  const prompt = `Analysiere das folgende Gespräch zwischen ${names.user} (Mensch) und ${names.assistant} (Agent) und beschreibe es als Geschichte.

Gespräch:
${sessionText}

Antworte NUR mit diesem JSON-Format (keine Code-Zäune, kein Text davor oder danach):
{
  "title": "Kurzer, konkreter Titel (max 60 Zeichen, nennt das Thema)",
  "summary": "2-3 Sätze Zusammenfassung: worum ging es, was kam heraus",
  "narrativeArc": "setup-conflict-resolution|exploration|decision|emotional",
  "turningPoint": "Der Wendepunkt oder leer",
  "topics": ["3-5 Themen als deutsche Nomen oder kurze Nominalphrasen, z. B. Schulterschmerzen, Milchsuppe, Gateway-Neustart"],
  "people": ["Personen, ÜBER die gesprochen wurde (abwesend) — ohne ${names.user} und ${names.assistant}; sonst leer"],
  "emotion": "Grundstimmung des Gesprächs: joy|trust|anticipation|sadness|anger|fear|surprise|disgust|neutral",
  "emotionIntensity": "niedrig|mittel|hoch — wie stark diese Stimmung das Gespräch prägt; sachliche Gespräche: neutral + niedrig"
}

Wenn kein klarer Wendepunkt existiert, setze narrativeArc auf "exploration" und turningPoint auf "".`;

  try {
    const agentId = opts.agentId || episode.agentId || "default";
    const callContext = llmCfg?.callContext || {};
    const response = await callLlm(
      [{ role: "user", content: prompt }],
      withLlmCallContext(
        withLlmResultCacheContext(
          { ...llmCfg, maxTokens: 500, temperature: 0 },
          agentId,
          LLM_RESULT_CACHE_PURPOSES.EPISODE_ANALYSIS,
        ),
        callContext.agentId || (typeof callContext.runtimeLlm?.complete === "function" ? undefined : agentId),
        LLM_RESULT_CACHE_PURPOSES.EPISODE_ANALYSIS,
        { runtimeLlm: callContext.runtimeLlm, signal: callContext.signal },
      )
    );
    throwIfAborted(opts.signal, "episode extraction aborted");

    const parsed = parseEpisodeJson(response);
    if (!parsed) return episode;
    return applyEnrichment(episode, parsed, { turns, names });
  } catch (err) {
    throwIfAborted(opts.signal, "episode extraction aborted");
    return episode;
  }
}

/**
 * Nimmt die Modellantwort auch mit Code-Zaun oder Vorspann an — Kimi liefert
 * gern ```json … ```; bis 7.12.39 scheiterte daran jede Anreicherung still.
 */
export function parseEpisodeJson(response) {
  if (typeof response !== "string" || !response.trim()) return null;
  let text = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) { /* weiter unten */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

const NARRATIVE_ARCS = new Set(["setup-conflict-resolution", "exploration", "decision", "emotional"]);

function cleanStringList(value, { max, minLen = 2, maxLen = 60, exclude = [] } = {}) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const lowerExclude = exclude.map((x) => String(x).toLowerCase());
  for (const item of value) {
    if (typeof item !== "string") continue;
    const v = item.replace(/\s+/g, " ").trim();
    if (v.length < minLen || v.length > maxLen || /^[\d\s.,-]+$/.test(v)) continue;
    if (lowerExclude.includes(v.toLowerCase())) continue;
    if (out.some((x) => x.toLowerCase() === v.toLowerCase())) continue;
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

const EMOTION_INTENSITY_VALUE = { niedrig: 0.3, mittel: 0.55, hoch: 0.8 };

/**
 * Uebernimmt nur valide Felder: Titel/Summary/Arc/Wendepunkt wie bisher,
 * dazu topics (bis 5), mentioned (bis 5, ohne die beiden Sprecher) und die
 * Gespraechs-Emotion samt Staerke.
 *
 * 7.12.42: Das Modell hat das Gespraech gelesen, die EmotionEngine kennt
 * nur den inneren Zustand des Agenten (Bernds Karte trug „sadness 0,76"
 * fuer einen sachlichen Testabend). Deshalb gilt die Modell-Emotion; die
 * Engine bleibt Rueckfall ohne Modell.
 */
export function applyEnrichment(episode, parsed, { turns = [], names = null } = {}) {
  const title = typeof parsed.title === "string" ? parsed.title.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 600) : "";
  const arc = NARRATIVE_ARCS.has(parsed.narrativeArc) ? parsed.narrativeArc : "exploration";
  const turningPoint = typeof parsed.turningPoint === "string" ? parsed.turningPoint.trim().slice(0, 300) : "";
  const topics = cleanStringList(parsed.topics, { max: MAX_TOPICS, maxLen: 40 });
  const speakerNames = names ? [names.user, names.assistant] : [];
  const mentioned = cleanStringList(parsed.people, { max: MAX_PEOPLE, maxLen: 60, exclude: speakerNames });
  const llmEmotion = typeof parsed.emotion === "string" && LLM_EMOTIONS.has(parsed.emotion.trim().toLowerCase())
    ? parsed.emotion.trim().toLowerCase()
    : null;
  const rawIntensity = typeof parsed.emotionIntensity === "string" ? parsed.emotionIntensity.trim().toLowerCase() : parsed.emotionIntensity;
  let intensity = Number.isFinite(Number(rawIntensity)) ? Math.max(0, Math.min(1, Number(rawIntensity))) : EMOTION_INTENSITY_VALUE[rawIntensity];
  const out = {
    ...episode,
    title: title || episode.title,
    summary: summary || episode.summary,
    narrativeArc: arc,
    turningPoint,
    topics: topics.length > 0 ? topics : episode.topics,
    participants: extractParticipants(turns, { names }),
    mentioned,
  };
  if (llmEmotion) {
    if (llmEmotion === "neutral") {
      out.emotionalDominant = "neutral";
      out.emotionalIntensity = Number.isFinite(intensity) ? Math.min(intensity, 0.3) : 0.1;
    } else {
      if (!Number.isFinite(intensity)) intensity = EMOTION_INTENSITY_VALUE.mittel;
      out.emotionalDominant = llmEmotion;
      out.emotionalIntensity = intensity;
      if (EMOTION_DIMS.includes(llmEmotion)) {
        out.emotionalTone = { ...episode.emotionalTone, [llmEmotion]: Math.max(episode.emotionalTone?.[llmEmotion] || 0, intensity) };
      }
    }
  }
  return out;
}

/**
 * Haupt-Funktion: Extrahiert Episoden aus Turns.
 *
 * @param {Array} turns — Turn-Events
 * @param {Object} opts — { maxGapMinutes, llmCfg, callLlm, workspaceKey, agentId, signal }
 * @param {string} [opts.agentId]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Array>} — Episoden
 */
export async function extractEpisodesFromTurns(turns, opts = {}) {
  const { episodes } = await extractEpisodesWithState(turns, opts);
  return episodes;
}

function turnSnapshot(turn) {
  return {
    id: turn.id,
    role: turn.role,
    content: String(turn.content || "").slice(0, ENRICH_TURN_CHARS),
    createdAt: turn.createdAt,
  };
}

/**
 * 7.12.40: Episoden werden ueber Turn-Abschluesse hinweg FORTGESCHRIEBEN.
 * Jeder agent_end liefert nur die neuen Turns; bisher wurde daraus jedes Mal
 * eine eigene Zwei-Turn-Episode (Bernd: "Folge-Turns landen nicht in der
 * Karte"). Jetzt haengen neue Turns an der zuletzt geschriebenen Episode,
 * solange die Pause zu ihr unter maxGapMinutes liegt und die Episode nicht
 * voll ist — dieselbe Karte (gleiche id) wird mit allen Turns neu gebaut.
 *
 * @param {Array} turns — neue Turn-Events
 * @param {Object} opts — wie extractEpisodesFromTurns, dazu
 *   `openEpisode` ({ id, endTime, createdAt, vaultPath, turns: [Snapshots] }) aus dem Hook-Zustand
 * @returns {Promise<{episodes: Array, openEpisode: object|null, continuedId: string|null}>}
 */
export async function extractEpisodesWithState(turns, opts = {}) {
  throwIfAborted(opts.signal, "episode extraction aborted");
  const fresh = Array.isArray(turns) ? turns.filter((t) => t && typeof t === "object") : [];
  if (fresh.length === 0) return { episodes: [], openEpisode: opts.openEpisode || null, continuedId: null };
  const maxGapMs = (opts.maxGapMinutes || DEFAULT_MAX_GAP_MINUTES) * 60 * 1000;
  const maxEpisodeTurns = Number.isFinite(opts.maxEpisodeTurns) ? Math.max(1, Math.floor(opts.maxEpisodeTurns)) : MAX_EPISODE_TURNS;

  const open = opts.openEpisode && typeof opts.openEpisode === "object" && Array.isArray(opts.openEpisode.turns) && opts.openEpisode.turns.length > 0
    ? opts.openEpisode
    : null;
  const firstNewAt = Math.min(...fresh.map((t) => new Date(t.createdAt || 0).getTime()));
  const openEndAt = open ? new Date(open.endTime || 0).getTime() : NaN;
  const knownIds = new Set(open ? open.turns.map((t) => t.id) : []);
  const novel = open ? fresh.filter((t) => !knownIds.has(t.id)) : fresh;
  const continueOpen = Boolean(open)
    && novel.length > 0
    && Number.isFinite(openEndAt)
    && firstNewAt - openEndAt <= maxGapMs
    && open.turns.length < maxEpisodeTurns;

  const combined = continueOpen ? [...open.turns, ...novel] : fresh;
  const groups = groupTurnsIntoEpisodes(combined, { ...opts, maxEpisodeTurns });
  const episodes = [];
  const participantNames = opts.participantNames
    || resolveParticipantNames(opts.workspaceDir, { agentId: opts.agentId || "agent" });
  let continuedId = null;
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const continuing = continueOpen && index === 0;
    let episode = createEpisode(group, {
      workspaceKey: opts.workspaceKey,
      agentId: opts.agentId,
      participantNames,
      mood: opts.mood || null,
      sessionKey: opts.sessionKey,
    });
    if (continuing) {
      episode = { ...episode, id: open.id, createdAt: open.createdAt || episode.createdAt, continued: true, revision: (Number(open.revision) || 0) + 1 };
      continuedId = open.id;
    }

    // LLM-basierte narrative Anreicherung
    if (group.length >= MIN_TURNS_FOR_LLM_NARRATIVE && opts.llmCfg && opts.callLlm) {
      episode = await enrichEpisodeNarratively(episode, group, opts.llmCfg, opts.callLlm, { ...opts, participantNames });
      throwIfAborted(opts.signal, "episode extraction aborted");
    }

    episode.vividness = calculateVividness(episode);
    throwIfAborted(opts.signal, "episode extraction aborted");
    episodes.push(episode);
  }

  const lastGroup = groups[groups.length - 1];
  const lastEpisode = episodes[episodes.length - 1];
  const openEpisode = lastEpisode
    ? {
      id: lastEpisode.id,
      endTime: lastEpisode.endTime,
      createdAt: lastEpisode.createdAt,
      revision: lastEpisode.revision || 0,
      vaultPath: continuedId === lastEpisode.id && open ? open.vaultPath || null : null,
      turns: lastGroup.slice(-maxEpisodeTurns).map(turnSnapshot),
    }
    : (opts.openEpisode || null);
  return { episodes, openEpisode, continuedId };
}

/**
 * Schreibt eine Episode in den Obsidian-Vault.
 */
export function writeEpisodeToVault(episode, workspaceDir, { replacePath = null } = {}) {
  try {
    const date = new Date(episode.startTime).toISOString().slice(0, 10);
    const year = date.slice(0, 4);
    const month = date.slice(5, 7);
    const dir = join(workspaceDir, "memory", "episodes", year, month);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const slug = episode.title
      .toLowerCase()
      .replace(/[^\wäöüß\s-]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 60);
    const path = join(dir, `${date}-${slug}.md`);

    const lines = [];
    lines.push("---");
    lines.push(`episode_id: ${episode.id}`);
    lines.push(`date: ${date}`);
    lines.push(`duration: ${episode.durationMinutes}min`);
    lines.push(`turn_count: ${episode.turnCount}`);
    if (episode.participants?.length > 0) {
      lines.push(`participants: [${episode.participants.join(", ")}]`);
    }
    if (episode.mentioned?.length > 0) {
      lines.push(`mentioned: [${episode.mentioned.join(", ")}]`);
    }
    if (episode.topics?.length > 0) {
      lines.push(`topics: [${episode.topics.join(", ")}]`);
    }
    lines.push(`narrative_arc: ${episode.narrativeArc}`);
    if (episode.turningPoint) {
      lines.push(`turning_point: ${episode.turningPoint}`);
    }
    lines.push(`vividness: ${episode.vividness.toFixed(2)}`);
    lines.push(`emotional_dominant: ${episode.emotionalDominant}`);
    lines.push(`emotional_intensity: ${episode.emotionalIntensity.toFixed(2)}`);
    lines.push(`importance: ${episode.importance}`);
    lines.push(`created_at: ${episode.createdAt}`);
    lines.push("---");
    lines.push("");
    lines.push(`# ${episode.title}`);
    lines.push("");

    if (episode.summary) {
      lines.push(episode.summary);
      lines.push("");
    }

    // Narrative Sections
    if (episode.narrativeArc === "setup-conflict-resolution") {
      lines.push("## Setup");
      lines.push("*Kontext und Ausgangssituation des Gesprächs.*");
      lines.push("");
      lines.push("## Wendepunkt");
      lines.push(episode.turningPoint || "*Kein klarer Wendepunkt erkannt.*");
      lines.push("");
      lines.push("## Auflösung");
      lines.push("*Ergebnis oder nächste Schritte.*");
      lines.push("");
    } else if (episode.narrativeArc === "decision") {
      lines.push("## Entscheidung");
      lines.push("*Was wurde beschlossen?*");
      lines.push("");
      lines.push("## Begründung");
      lines.push("*Warum wurde diese Entscheidung getroffen?*");
      lines.push("");
    } else if (episode.narrativeArc === "emotional") {
      lines.push("## Emotionale Dynamik");
      lines.push("*Wie entwickelte sich die Stimmung im Gespräch?*");
      lines.push("");
    } else if (!episode.summary || /^\d+ Turns, \d+ Min$/.test(episode.summary)) {
      lines.push("## Verlauf");
      lines.push("*Exploratives Gespräch ohne klaren Arc.*");
      lines.push("");
    }

    // Enthaltene Turns / Memory-Links
    if (episode.memoryIds?.length > 0) {
      lines.push("## Enthaltene Erinnerungen");
      for (const mid of episode.memoryIds.slice(0, 20)) {
        lines.push(`- ${mid}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push(`_Episode generiert am ${new Date().toISOString()}${episode.revision ? ` (Fassung ${episode.revision + 1})` : ""}_`);
    const body = lines.join("\n") + "\n";

    // 7.12.40: fortgeschriebene Episode ersetzt ihre bisherige Karte — aber
    // nur, wenn die Datei genau diese eine Episode enthaelt (Sammeldateien
    // aus aelteren Versionen bleiben unangetastet, dann wird angehaengt).
    if (replacePath && existsSync(replacePath)) {
      const previous = readFileSync(replacePath, "utf8");
      const ids = previous.match(/^episode_id: .+$/gm) || [];
      if (ids.length === 1 && ids[0] === `episode_id: ${episode.id}`) {
        writeFileSync(path, body, "utf8");
        if (path !== replacePath) { try { unlinkSync(replacePath); } catch (_) { /* egal */ } }
        return { path, written: true, replaced: true };
      }
    }
    appendFileSync(path, body, "utf8");
    return { path, written: true, replaced: false };
  } catch (err) {
    return { written: false, error: err.message };
  }
}

/**
 * Episodischer Recall: Sucht nach passenden Episoden und liefert
 * die darin enthaltenen Memories.
 *
 * Vorbereitet für Phase 4 (Memory-Graph).
 */
export async function recallEpisodically(query, db, episodes, opts = {}) {
  if (!episodes || episodes.length === 0) return [];

  // Einfache Text-Suche auf Episode-Titeln und Summaries
  const queryLower = query.toLowerCase();
  const scored = episodes.map(ep => {
    const text = `${ep.title} ${ep.summary} ${ep.topics.join(" ")}`.toLowerCase();
    let score = 0;
    if (text.includes(queryLower)) score += 0.5;
    // Topic-Match
    for (const topic of ep.topics) {
      if (queryLower.includes(topic.toLowerCase())) score += 0.3;
    }
    // Participant-Match (Sprecher) und Erwaehnte (schwaecher)
    for (const p of ep.participants || []) {
      if (queryLower.includes(p.toLowerCase())) score += 0.2;
    }
    for (const p of ep.mentioned || []) {
      if (queryLower.includes(p.toLowerCase())) score += 0.1;
    }
    // Vividness-Boost
    score += (ep.vividness || 0) * 0.2;
    return { episode: ep, score: Math.min(score, 1.0) };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, opts.limit || 3).filter(s => s.score > (opts.minScore || 0.2));

  // Für jede Episode: hole verknüpfte Memories
  const enriched = [];
  for (const { episode, score } of top) {
    const memories = [];
    if (db && episode.memoryIds?.length > 0) {
      for (const mid of episode.memoryIds.slice(0, 10)) {
        try {
          // MemoryDB hat keine getById Methode direkt — wir nutzen search mit leerem Vektor
          // oder überspringen für jetzt. In Phase 4 wird das über den Graph gelöst.
          memories.push({ id: mid, placeholder: true });
        } catch (_) {}
      }
    }
    enriched.push({ episode, score, memories });
  }

  return enriched;
}
