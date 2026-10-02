import { strict as assert } from "node:assert";
import test from "node:test";

import {
  aggregateEvidence,
  isTrustedSkillEvidence,
  sameSkillOwnershipTuple,
  skillOwnershipTuple,
} from "../lib/jobs/skill-miner/evidence-aggregator.js";

// Reference: the clustering exactly as shipped up to 7.18.1 (all pairs, two
// fresh Sets and two ownership validations per pair). The rewrite must return
// the same groups in the same order.
function extractKeywordsReference(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\wäöüß\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
}

function aggregateEvidenceReference(memories, workspaceAliases = undefined) {
  if (!memories || memories.length === 0) return [];
  const items = memories.map((m) => ({
    memory: m,
    keywords: extractKeywordsReference(m.text),
    ownership: skillOwnershipTuple(m, workspaceAliases),
  })).filter((item) => item.keywords.length > 0 && item.ownership);
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const setB = new Set(items[j].keywords);
      const intersection = items[i].keywords.filter((k) => setB.has(k));
      const keywordUnion = [...new Set([...items[i].keywords, ...items[j].keywords])];
      const jaccard = intersection.length / keywordUnion.length;
      if (jaccard >= 0.4 && sameSkillOwnershipTuple(items[i].memory, items[j].memory, workspaceAliases)) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[i]);
  }
  const results = [];
  for (const groupItems of groups.values()) {
    const groupMemories = groupItems.map((g) => g.memory);
    const freq = new Map();
    for (const gi of groupItems) for (const kw of gi.keywords) freq.set(kw, (freq.get(kw) || 0) + 1);
    const sortedKeywords = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kw]) => kw);
    let score = 0;
    for (const m of groupMemories) {
      score += 1;
      if (isTrustedSkillEvidence(m)) score += 2;
      if (["workspace_rule", "user_preference"].includes(m.category)) score += 1;
      if ((m.retrievalCount || 0) >= 3) score += 1;
      if (m.contradictory === true) score -= 1;
    }
    if (score < 1) continue;
    results.push({ memories: groupMemories, keywords: sortedKeywords, score, topics: sortedKeywords.slice(0, 5), ownership: skillOwnershipTuple(groupMemories[0], workspaceAliases) });
  }
  return results;
}

// Deterministic PRNG so failures are reproducible.
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const VOCAB = [
  "nicht", "dass", "eine", "haben", "werden", "immer", "bitte", "kalender", "termin", "erinnerung",
  "telegram", "nachricht", "antwort", "deutsch", "englisch", "kurz", "lang", "abends", "morgens",
  "kaffee", "rezept", "zucker", "glasur", "pizzastahl", "backofen", "server", "gateway", "neustart",
  "update", "patch", "cron", "skill", "memory", "dashboard", "health", "budget", "einkauf", "liste",
  "wetter", "regen", "sonne", "urlaub", "griechenland", "flug", "hotel", "bernd", "eva", "erik",
  "rat", "sitzung", "vorlage", "beschluss", "partei", "stimme", "prozent", "über", "größe", "straße",
];

function randomMemories(random, count, { agents = ["main"], dupRate = 0.2 } = {}) {
  const memories = [];
  for (let i = 0; i < count; i++) {
    const words = [];
    const length = 3 + Math.floor(random() * 14);
    for (let w = 0; w < length; w++) {
      const word = VOCAB[Math.floor(random() ** 1.6 * VOCAB.length)];
      words.push(word);
      if (random() < dupRate) words.push(word);
    }
    if (random() < 0.05) words.length = 0; // no keywords
    if (random() < 0.05) words.push("ab", "zu"); // short words only drop out
    const agentId = agents[Math.floor(random() * agents.length)];
    memories.push({
      id: `m-${i}`,
      text: `${words.join(random() < 0.5 ? " " : ", ")}${random() < 0.3 ? "!" : ""}`,
      category: ["fact", "user_preference", "workspace_rule", "conversation"][Math.floor(random() * 4)],
      retrievalCount: Math.floor(random() * 5),
      epistemicStatus: ["", "observed", "corroborated", "trusted"][Math.floor(random() * 4)],
      contradictory: random() < 0.1,
      scope: random() < 0.03 ? "bogus-scope" : "agent-private",
      agentId,
    });
  }
  return memories;
}

test("aggregateEvidence liefert exakt dasselbe wie die bisherige Paarschleife", () => {
  const random = rng(20261001);
  for (let round = 0; round < 40; round++) {
    const memories = randomMemories(random, 20 + Math.floor(random() * 220), {
      agents: round % 3 === 0 ? ["main"] : ["main", "bernhardine", "heisenberg"],
      dupRate: round % 4 === 0 ? 0.5 : 0.15,
    });
    assert.deepStrictEqual(aggregateEvidence(memories), aggregateEvidenceReference(memories), `round ${round}`);
  }
});

test("aggregateEvidence bleibt bei 2600 Erinnerungen unter zwei Sekunden", () => {
  const memories = randomMemories(rng(7), 2600, { agents: ["bernhardine"] });
  const started = performance.now();
  const groups = aggregateEvidence(memories);
  const elapsedMs = performance.now() - started;
  assert.ok(groups.length > 0);
  assert.ok(elapsedMs < 2000, `took ${Math.round(elapsedMs)} ms; on 01.10.2026 the gateway stalled 121 s on 2496 memories`);
});
