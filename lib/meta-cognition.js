/**
 * lib/meta-cognition.js — Meta-Kognition / Selbst-Reflexion (Feature 7).
 *
 * Heuristische Reflexion über Sessions, Recall-Qualität und
 * Behavior-Card-Updates. Keine externe Dependency.
 */

import { jaccardSimilarity } from "./text-utils.js";
import { randomUUID } from "node:crypto";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const DUPLICATE_THRESHOLD = 0.7;

const STOP_WORDS = new Set([
  "dies", "das", "ist", "ein", "eine", "der", "die", "und", "mit", "für", "von", "zu", "im", "den", "nicht",
  "als", "sich", "dem", "bei", "nach", "auch", "war", "wird", "werden", "einer", "einen", "einem", "eines",
  "was", "wenn", "dass", "aber", "oder", "wie", "so", "noch", "nur", "kann", "schon", "hier", "hat", "sein",
  "are", "the", "and", "for", "with", "this", "that", "from", "not", "but", "they", "have", "had", "what",
  "when", "where", "who", "will", "would", "there", "their", "them", "then", "than", "also", "into", "just",
  "like", "over", "been", "being", "can", "could", "should", "such", "some", "time", "way", "may", "say",
  "each", "which", "how",
]);

function extractTopics(memories) {
  const counts = new Map();
  for (const m of memories) {
    const text = String(m.statement || m.content || m.text || "");
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9äöüß\s]/gi, " ")
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
    for (const w of words) {
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word]) => word);
}

function getSessionId(session) {
  if (typeof session === "string") return session;
  return session?.id || "unknown";
}

function isOldMemory(memory, now = Date.now()) {
  const lastRetrieved = memory.lastRetrievedAt;
  if (lastRetrieved) {
    return now - new Date(lastRetrieved).getTime() > NINETY_DAYS_MS;
  }
  const created = memory.createdAt;
  if (created) {
    return now - new Date(created).getTime() > NINETY_DAYS_MS;
  }
  return false;
}

function findDuplicates(memories) {
  const duplicates = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i];
      const b = memories[j];
      const textA = a.statement || a.content || a.text || "";
      const textB = b.statement || b.content || b.text || "";
      const sim = jaccardSimilarity(textA, textB);
      if (sim >= DUPLICATE_THRESHOLD) {
        duplicates.push({ memoryA: a, memoryB: b, similarity: sim });
      }
    }
  }
  return duplicates;
}

function classifyRecall(memoryCount) {
  if (memoryCount === 0) return "total_miss";
  if (memoryCount < 3) return "under_recall";
  if (memoryCount > 10) return "over_recall";
  return "balanced";
}

export function reflectOnSession(session, retrievedMemories, idealCount = 5, explanations) {
  const sessionId = getSessionId(session);
  const memoryCount = Array.isArray(retrievedMemories) ? retrievedMemories.length : 0;
  const memories = Array.isArray(retrievedMemories) ? retrievedMemories : [];
  const now = Date.now();

  const result = {
    sessionId,
    memoryCount,
    classification: classifyRecall(memoryCount),
    duplicates: findDuplicates(memories),
    oldMemories: memories.filter(m => isOldMemory(m, now)),
    idealCount,
    timestamp: new Date().toISOString(),
    topics: extractTopics(memories),
    memories,
  };

  if (explanations !== undefined) {
    result.explanations = explanations;
  }

  return result;
}

function statementForClassification(classification) {
  switch (classification) {
    case "under_recall":
      return "Ich sollte mehr Kontext sammeln";
    case "over_recall":
      return "Ich sollte präziser filtern";
    case "total_miss":
      return "Ich sollte nachfragen wenn ich nichts finde";
    case "balanced":
      return "Recall ist ausbalanciert — weiter so";
    default:
      return "Unbekannte Reflexion";
  }
}

export function updateBehaviorCards(reflection, neoStore) {
  const statement = statementForClassification(reflection.classification);
  const existing = neoStore.readBehaviorCards(200);
  const alreadyExists = existing.some(
    c => c.statement === statement && c.sourceSessionId === reflection.sessionId
  );
  if (!alreadyExists) {
    const card = {
      id: randomUUID(),
      workspaceKey: reflection.workspaceKey || "default",
      category: "agent_strategy",
      statement,
      status: "candidate",
      confidence: 0.75,
      salience: 0.6,
      sourceSessionId: reflection.sessionId,
      embeddingStatus: "pending",
      createdAt: new Date().toISOString(),
    };
    neoStore.appendBehaviorCards([card]);
  }

  const topics = reflection.topics || [];
  const topicLabel = topics.length > 0 ? topics.join(", ") : "unbekanntes Thema";

  if (reflection.classification === "under_recall") {
    const candidates = [
      {
        id: randomUUID(),
        workspaceKey: reflection.workspaceKey || "default",
        statement: `Fehlende Fakten zu ${topicLabel}? Letzte Session hatte unteren Recall.`,
        category: "open_question",
        status: "candidate",
        confidence: 0.6,
        salience: 0.5,
        sourceSessionId: reflection.sessionId,
        embeddingStatus: "pending",
        createdAt: new Date().toISOString(),
      },
      {
        id: randomUUID(),
        workspaceKey: reflection.workspaceKey || "default",
        statement: `Fehlende Fakten zu ${topicLabel}? Letzte Session hatte unteren Recall.`,
        category: "todo",
        status: "candidate",
        confidence: 0.6,
        salience: 0.5,
        sourceSessionId: reflection.sessionId,
        embeddingStatus: "pending",
        createdAt: new Date().toISOString(),
      },
    ];
    neoStore.appendCandidates(candidates);
  } else if (reflection.classification === "over_recall") {
    const memories = reflection.memories || [];
    const codeContextCount = memories.filter(m => m.category === "code_context").length;
    const userPrefCount = memories.filter(m => m.category === "user_preference").length;

    const laneCards = [];
    if (codeContextCount > 3) {
      laneCards.push({
        id: randomUUID(),
        workspaceKey: reflection.workspaceKey || "default",
        category: "agent_strategy",
        statement: "Reduziere Priorität der code_context Recall-Lane",
        status: "candidate",
        confidence: 0.7,
        salience: 0.6,
        sourceSessionId: reflection.sessionId,
        embeddingStatus: "pending",
        createdAt: new Date().toISOString(),
      });
    }
    if (userPrefCount > 3) {
      laneCards.push({
        id: randomUUID(),
        workspaceKey: reflection.workspaceKey || "default",
        category: "agent_strategy",
        statement: "Reduziere Priorität der user_preference Recall-Lane",
        status: "candidate",
        confidence: 0.7,
        salience: 0.6,
        sourceSessionId: reflection.sessionId,
        embeddingStatus: "pending",
        createdAt: new Date().toISOString(),
      });
    }
    if (laneCards.length > 0) {
      neoStore.appendBehaviorCards(laneCards);
    }
  } else if (reflection.classification === "total_miss") {
    const candidate = {
      id: randomUUID(),
      workspaceKey: reflection.workspaceKey || "default",
      statement: "Ich sollte nachfragen wenn ich nichts finde",
      category: "agent_strategy",
      status: "candidate",
      confidence: 0.75,
      salience: 0.6,
      sourceSessionId: reflection.sessionId,
      embeddingStatus: "pending",
      createdAt: new Date().toISOString(),
    };
    neoStore.appendCandidates([candidate]);
  }
}

function aggregatePercentages(explanations) {
  if (!explanations || explanations.length === 0) return null;
  const keys = ["vectorSimilarity", "importanceBoost", "rerankScore", "temporalBoost"];
  const sums = {};
  for (const key of keys) {
    sums[key] = explanations.reduce((sum, ex) => sum + (ex?.percentages?.[key] ?? 0), 0);
  }
  const result = {};
  for (const key of keys) {
    result[key] = Math.round(sums[key] / explanations.length);
  }
  return result;
}

function formatExplanationBreakdown(percentages) {
  if (!percentages) return "";
  const labels = {
    vectorSimilarity: "Vector-Sim",
    importanceBoost: "Importance-Boost",
    rerankScore: "Reranker",
    temporalBoost: "Temporal-Boost",
  };
  const parts = [];
  for (const [key, label] of Object.entries(labels)) {
    parts.push(`${percentages[key]}% ${label}`);
  }
  return `Die Erklärbarkeit zeigt: ${parts.join(", ")}.`;
}

/**
 * Berechnet Recall-Quality-Metriken aus User-Feedback.
 *
 * @param {Array<{feedback:"positive"|"negative"|"neutral", query:string, memoryId:string}>} feedbackEntries
 * @returns {{precision:number, recall:number, f1:number, total:number, positive:number, negative:number, neutral:number}|null}
 */
export function computeRecallMetrics(feedbackEntries) {
  if (!Array.isArray(feedbackEntries) || feedbackEntries.length === 0) return null;

  const positive = feedbackEntries.filter((e) => e.feedback === "positive").length;
  const negative = feedbackEntries.filter((e) => e.feedback === "negative").length;
  const neutral = feedbackEntries.filter((e) => e.feedback === "neutral").length;
  const total = feedbackEntries.length;

  // Precision: Wie viel des zurückgegebenen Feedbacks war positiv?
  const precision = positive + negative > 0 ? positive / (positive + negative) : 0;
  // Recall-Proxy: Anteil positives Feedback am Gesamtfeedback
  const recall = total > 0 ? positive / total : 0;
  // F1-Score
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    precision: Math.round(precision * 100) / 100,
    recall: Math.round(recall * 100) / 100,
    f1: Math.round(f1 * 100) / 100,
    total,
    positive,
    negative,
    neutral,
  };
}

/**
 * Findet Coverage-Gaps: Topics mit zu wenig Memories oder niedriger Strength.
 *
 * @param {Array<{id:string, text:string, topics?:string[], memoryStrength?:number}>} memories
 * @param {object} [options]
 * @param {number} [options.minMemories=3] — Minimale Anzahl Memories pro Topic
 * @param {number} [options.minStrength=0.5] — Minimale durchschnittliche memoryStrength
 * @returns {Array<{topic:string, memoryCount:number, avgStrength:number, memoryIds:string[]}>}
 */
export function findCoverageGaps(memories, options = {}) {
  const minMemories = options.minMemories ?? 3;
  const minStrength = options.minStrength ?? 0.5;

  const topicMap = new Map();

  for (const m of memories) {
    const topics = Array.isArray(m.topics) ? m.topics : [];
    const strength = typeof m.memoryStrength === "number" ? m.memoryStrength : 1.0;
    for (const topic of topics) {
      if (!topicMap.has(topic)) {
        topicMap.set(topic, { memoryIds: [], strengths: [] });
      }
      const entry = topicMap.get(topic);
      entry.memoryIds.push(m.id);
      entry.strengths.push(strength);
    }
  }

  const gaps = [];
  for (const [topic, data] of topicMap) {
    const memoryCount = data.memoryIds.length;
    const avgStrength = data.strengths.reduce((a, b) => a + b, 0) / data.strengths.length;
    if (memoryCount < minMemories || avgStrength < minStrength) {
      gaps.push({ topic, memoryCount, avgStrength: Math.round(avgStrength * 100) / 100, memoryIds: data.memoryIds });
    }
  }

  return gaps.sort((a, b) => a.avgStrength - b.avgStrength);
}

/**
 * Prüft, ob eine Meta-Reflexion getriggert werden soll.
 *
 * @param {number} sessionCount — Sessions seit letztem Run
 * @param {number} threshold — Konfigurierter Threshold
 * @param {number} lastRunAt — Timestamp des letzten Runs
 * @param {object} [options]
 * @param {number} [options.intervalMs=604800000] — Zeit-Intervall (default 1 Woche)
 * @returns {boolean}
 */
export function shouldTriggerReflection(sessionCount, threshold, lastRunAt, options = {}) {
  const intervalMs = options.intervalMs ?? 7 * 24 * 60 * 60 * 1000;
  // Threshold-basiert
  if (sessionCount >= threshold) return true;
  // Zeit-basiert
  if (lastRunAt > 0 && Date.now() - lastRunAt >= intervalMs) return true;
  return false;
}

export function generateReflectionSummary(reflection, explanations = []) {
  const parts = [];
  const cls = reflection.classification;

  if (cls === "under_recall") {
    parts.push(`Reflexion: unterer Recall (${reflection.memoryCount}/${reflection.idealCount} Memories). ${statementForClassification(cls)}.`);
  } else if (cls === "over_recall") {
    parts.push(`Reflexion: übermäßiger Recall (${reflection.memoryCount}/${reflection.idealCount} Memories). ${statementForClassification(cls)}.`);
  } else if (cls === "total_miss") {
    parts.push(`Reflexion: totaler Miss (${reflection.memoryCount}/${reflection.idealCount} Memories). ${statementForClassification(cls)}.`);
  } else {
    parts.push(`Reflexion: ausgewogener Recall (${reflection.memoryCount}/${reflection.idealCount} Memories). ${statementForClassification(cls)}.`);
  }

  if (reflection.duplicates.length > 0) {
    parts.push(`Zudem wurden ${reflection.duplicates.length} Duplikat-Paare gefunden.`);
  }

  if (reflection.oldMemories.length > 0) {
    parts.push(`Außerdem ${reflection.oldMemories.length} alte Memories ohne aktuelles Retrieval.`);
  }

  const exps = explanations.length > 0 ? explanations : (reflection.explanations || []);
  if (exps.length > 0) {
    const agg = aggregatePercentages(exps);
    parts.push(formatExplanationBreakdown(agg));
  }

  return parts.join(" ");
}
