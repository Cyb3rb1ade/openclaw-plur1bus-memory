/**
 * lib/episodes.js — Episoden-Engine für PLUR1BUS.
 *
 * Gruppiert Turns zu Episoden (Geschichten statt isolierter Fakten).
 * Jede Episode hat eine narrative Struktur: Setup → Wendepunkt → Auflösung.
 *
 * Abhängigkeiten: Phase 1 (Emotionale Valenz), Phase 2 (Light Dreaming)
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_MAX_GAP_MINUTES = 30;
const MIN_TURNS_FOR_LLM_NARRATIVE = 5;
const MAX_EPISODE_TURNS = 50;

/**
 * Gruppiert Turns in Episoden basierend auf zeitlicher Nähe.
 *
 * @param {Array} turns — Turn-Events (mit createdAt als ISO-String)
 * @param {Object} opts — { maxGapMinutes }
 * @returns {Array<Array>} — Gruppen von Turns
 */
export function groupTurnsIntoEpisodes(turns, opts = {}) {
  if (!turns || turns.length === 0) return [];

  const maxGapMs = (opts.maxGapMinutes || DEFAULT_MAX_GAP_MINUTES) * 60 * 1000;

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

    if (currTime - prevTime > maxGapMs) {
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

/**
 * Extrahiert Teilnehmer (Entitäten) aus Turns.
 * Lightweight: Sucht nach Großbuchstaben-Wörtern (Eigennamen).
 */
function extractParticipants(turns) {
  const participants = new Set();
  for (const turn of turns) {
    const text = String(turn.content || "");
    // Eigennamen: Wörter mit Großbuchstabe am Anfang (mindestens 2 aufeinanderfolgende)
    const names = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
    for (const name of names) {
      if (name.length > 2 && !/^(Ich|Du|Er|Sie|Es|Wir|Ihr|Sie|Der|Die|Das|Ein|Eine|Der|Die|Das)$/i.test(name)) {
        participants.add(name);
      }
    }
  }
  return [...participants].slice(0, 10);
}

/**
 * Extrahiert Topics aus Turns (keywords).
 */
function extractTopics(turns) {
  const wordFreq = new Map();
  for (const turn of turns) {
    const words = String(turn.content || "").toLowerCase()
      .replace(/[^\wäöüß\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 4 && !isStopWord(w));
    for (const w of words) {
      wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
    }
  }
  return [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
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
 * Berechnet den emotionalen Ton einer Episode aus den Turns.
 */
function computeEpisodeEmotionalTone(turns) {
  const dims = ["joy", "trust", "anticipation", "sadness", "anger", "fear", "surprise"];
  const avg = {};
  for (const d of dims) avg[d] = 0;

  let count = 0;
  for (const turn of turns) {
    if (!turn.emotionalValence) continue;
    const valence = typeof turn.emotionalValence === "string"
      ? parseSimpleValence(turn.emotionalValence)
      : turn.emotionalValence;
    if (!valence) continue;
    for (const d of dims) {
      avg[d] += valence[d] || 0;
    }
    count++;
  }

  if (count === 0) return avg;
  for (const d of dims) avg[d] /= count;
  return avg;
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

  const ageDays = (Date.now() - new Date(episode.startTime || Date.now()).getTime()) / 86400000;
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

  const participants = extractParticipants(turns);
  const topics = extractTopics(turns);
  const emotionalTone = computeEpisodeEmotionalTone(turns);

  // Dominante Emotion
  const emotionEntries = Object.entries(emotionalTone);
  const dominant = emotionEntries.reduce((a, b) => (a[1] > b[1] ? a : b), ["neutral", 0]);

  return {
    id: randomUUID(),
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
    emotionalDominant: dominant[1] > 0.15 ? dominant[0] : "neutral",
    emotionalIntensity: emotionEntries.reduce((sum, [, v]) => sum + v, 0) / emotionEntries.length,
    location: opts.location || turns[0]?.origin?.scope || "dm",
    importance: opts.importance || 0.6,
    narrativeArc: opts.narrativeArc || "exploration",
    turningPoint: opts.turningPoint || "",
    vividness: 0, // Wird nach der Berechnung gesetzt
    replayCount: opts.replayCount || 0,
    lastReplayed: opts.lastReplayed || null,
    createdAt: new Date().toISOString(),
    turnCount: turns.length,
  };
}

/**
 * Erzeugt narrative Metadaten (Titel, Arc, Wendepunkt) via LLM.
 * Nur für Episoden mit >= MIN_TURNS_FOR_LLM_NARRATIVE Turns.
 */
export async function enrichEpisodeNarratively(episode, turns, llmCfg, callLlm) {
  if (!turns || turns.length < MIN_TURNS_FOR_LLM_NARRATIVE) {
    return { ...episode, narrativeArc: "exploration" };
  }

  const sessionText = turns
    .map((t) => `[${t.role}] ${String(t.content || "").slice(0, 200)}`)
    .join("\n");

  const prompt = `Analysiere das folgende Gespräch und beschreibe es als Geschichte:

Gespräch:
${sessionText}

Antworte NUR mit diesem JSON-Format:
{
  "title": "Kurzer Titel (max 60 Zeichen)",
  "narrativeArc": "setup-conflict-resolution|exploration|decision|emotional",
  "turningPoint": "Der Wendepunkt oder leer",
  "summary": "2-3 Sätze Zusammenfassung"
}

Wenn kein klarer Wendepunkt existiert, setze narrativeArc auf "exploration" und turningPoint auf "".`;

  try {
    const response = await callLlm(
      [{ role: "user", content: prompt }],
      { ...llmCfg, maxTokens: 400, temperature: 0 }
    );

    if (!response) return episode;

    let parsed;
    try {
      parsed = JSON.parse(response);
    } catch (_) {
      return episode;
    }

    return {
      ...episode,
      title: parsed.title || episode.title,
      narrativeArc: parsed.narrativeArc || "exploration",
      turningPoint: parsed.turningPoint || "",
      summary: parsed.summary || episode.summary,
    };
  } catch (err) {
    return episode;
  }
}

/**
 * Haupt-Funktion: Extrahiert Episoden aus Turns.
 *
 * @param {Array} turns — Turn-Events
 * @param {Object} opts — { maxGapMinutes, llmCfg, callLlm, workspaceKey, agentId }
 * @returns {Promise<Array>} — Episoden
 */
export async function extractEpisodesFromTurns(turns, opts = {}) {
  const groups = groupTurnsIntoEpisodes(turns, opts);
  const episodes = [];

  for (const group of groups) {
    let episode = createEpisode(group, {
      workspaceKey: opts.workspaceKey,
      agentId: opts.agentId,
    });

    // LLM-basierte narrative Anreicherung für längere Episoden
    if (group.length >= MIN_TURNS_FOR_LLM_NARRATIVE && opts.llmCfg && opts.callLlm) {
      episode = await enrichEpisodeNarratively(episode, group, opts.llmCfg, opts.callLlm);
    }

    episode.vividness = calculateVividness(episode);
    episodes.push(episode);
  }

  return episodes;
}

/**
 * Schreibt eine Episode in den Obsidian-Vault.
 */
export function writeEpisodeToVault(episode, workspaceDir) {
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
    } else {
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
    lines.push(`_Episode generiert am ${new Date().toISOString()}_`);

    appendFileSync(path, lines.join("\n") + "\n", "utf8");
    return { path, written: true };
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
    // Participant-Match
    for (const p of ep.participants) {
      if (queryLower.includes(p.toLowerCase())) score += 0.2;
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
