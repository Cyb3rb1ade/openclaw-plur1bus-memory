/**
 * sample.mjs — zieht eine feste, nach Textlänge geschichtete Stichprobe echter
 * Erinnerungen aus den Produktions-Stores. Nur lesend; schreibt ausschließlich
 * die JSONL-Stichprobe, damit beide Prompt-Varianten exakt dieselben Texte sehen.
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const BASE = "/root/.openclaw/memory/lancedb-namespaced";
const AGENTS = ["main", "bernhardine"];
const N = Number(process.env.SAMPLE_N || 60);
const OUT = new URL("./sample.jsonl", import.meta.url).pathname;

// Deterministischer PRNG (mulberry32) — dieselbe Stichprobe bei jedem Lauf.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lancedb = await import("/root/.openclaw/plur1bus-release/node_modules/@lancedb/lancedb/dist/index.js");

const rows = [];
for (const agentId of AGENTS) {
  const db = await lancedb.connect(join(BASE, agentId));
  const table = await db.openTable("memories");
  const all = await table.query().limit(100000).toArray();
  for (const r of all) {
    const text = String(r.text || r.content || "").trim();
    if (text.length < 20) continue;
    rows.push({
      agentId,
      id: String(r.id),
      text,
      importanceLive: typeof r.importance === "number" ? r.importance : null,
      emotionalValenceLive: r.emotionalValence ?? null,
      emotionalDominantLive: r.emotionalDominant ?? null,
    });
  }
}

// Drei Längenbänder: kurz, mittel, über der 2000-Zeichen-Kappung des Prompts.
const bands = { short: [], medium: [], long: [] };
for (const r of rows) {
  if (r.text.length < 200) bands.short.push(r);
  else if (r.text.length <= 2000) bands.medium.push(r);
  else bands.long.push(r);
}

const rand = rng(20260919);
const pick = (arr, k) => {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, k);
};

const per = Math.floor(N / 3);
const sample = [
  ...pick(bands.short, per),
  ...pick(bands.medium, per),
  ...pick(bands.long, N - 2 * per),
];

writeFileSync(OUT, sample.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`Gesamt ${rows.length} Zeilen | kurz ${bands.short.length} mittel ${bands.medium.length} lang ${bands.long.length}`);
console.log(`Stichprobe ${sample.length} -> ${OUT}`);
