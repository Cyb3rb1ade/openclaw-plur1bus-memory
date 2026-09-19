/**
 * Capture-Ingest: schreibt die Gespraechsturns nicht roh, sondern durch die
 * deterministische Capture-Kette des Plugins — Kategorisierung, Importance,
 * Summary, Emotion (Tier 1), epistemischer Status, Dynamics-Defaults und der
 * Dedup-Check bei duplicateThreshold 0.95.
 *
 * Nicht enthalten: Graph-Kanten/Neo-Store (eigenes Subsystem), Merging per LLM
 * und die Emotions-Stufen t2/t3 (t2 ist im Release ein ONNX-Stub, t3 haengt an
 * einem Anthropic-Provider und ist auf onlyWhenProviderAvailable gestellt).
 *
 * Usage: node ingest-capture.mjs locomo|lme [--limit N]
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { BENCH, RELEASE, lancedb, loadEnv, makeEmbeddings, memoryRow, pMap, parseLocomoDate, parseLmeDate } from "./lib/common.mjs";
const { planChunks } = await import(`${RELEASE}/lib/memory-chunking.js`);

loadEnv();
const { categorizeMemoryWithReason } = await import(`${RELEASE}/lib/categorize.js`);
const { computeMemoryImportance } = await import(`${RELEASE}/lib/memory-fact-quality.js`);
const { applyDynamicsDefaults } = await import(`${RELEASE}/lib/memory-dynamics.js`);
const { decideEpistemicStatusForCapture } = await import(`${RELEASE}/lib/epistemic-capture.js`);
const { inferEmotionalValence, serializeEmotionalValence } = await import(`${RELEASE}/lib/emotion.js`);
const { distanceToScore } = await import(`${RELEASE}/lib/score.js`);

const which = process.argv[2];
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
const EMBED_BATCH = 96;
const SUMMARY_MAX_WORDS = 150;      // openclaw.json: summaryMaxWords
const DUPLICATE_THRESHOLD = 0.95;   // openclaw.json: duplicateThreshold

/** Wortweise Kuerzung — identisch zu generateSummary() im Capture-Skript. */
function generateSummary(text, maxWords) {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  return words.slice(0, maxWords).join(" ") + (words.length > maxWords ? "..." : "");
}

function squaredL2(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return sum;
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** Mit --chunked landen mehrteilige Nachrichten als mehrere Vektoren im
 *  Store, in einem eigenen Verzeichnis — die bestehende Datenbank bleibt
 *  unangetastet und vergleichbar. */
const CHUNKED = process.argv.includes("--chunked");
const DB_SUFFIX = CHUNKED ? "-chunked" : "";

/** Eine Zeile so bauen, wie der Capture-Hook sie baut (index.js:10560 ff.). */
function captureRow({ id, text, vector, createdAt, agentId, role, origin, sourceTurnId }) {
  const { category, reason } = categorizeMemoryWithReason(text);
  const importance = computeMemoryImportance({ text, category, categoryReason: reason, origin }).importance;
  const emotion = inferEmotionalValence(text, category);
  const base = memoryRow({ id, text, vector, createdAt, agentId, category, importance });
  return applyDynamicsDefaults({
    ...base,
    summary: generateSummary(text, SUMMARY_MAX_WORDS),
    origin,
    sourceMessageRole: role,
    ...(sourceTurnId ? { sourceTurnId } : {}),
    evidenceQuote: text.slice(0, 200),
    emotionalValence: serializeEmotionalValence(emotion),
    emotionalIntensity: emotion.emotionalIntensity,
    emotionalDominant: emotion.emotionalDominant,
    epistemicStatus: decideEpistemicStatusForCapture({ text, sourceMessageRole: role, origin, cutoffFailed: false }),
  }, createdAt);
}

async function writeStore(dir, rows) {
  await rm(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const db = await lancedb.connect(dir);
  const table = await db.createTable("memories", rows.slice(0, 1));
  for (let i = 1; i < rows.length; i += 500) await table.add(rows.slice(i, i + 500));
}

async function embedAll(embeddings, texts) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    vectors.push(...await embeddings.embedBatch(texts.slice(i, i + EMBED_BATCH)));
  }
  return vectors;
}

/** Dedup wie im Capture-Hook: Score 1/(1+d) gegen den naechsten Nachbarn. */
function dedup(units, vectors) {
  const kept = [];
  const keptVectors = [];
  let skipped = 0;
  for (let i = 0; i < units.length; i++) {
    let duplicate = false;
    for (const existing of keptVectors) {
      if (distanceToScore(squaredL2(vectors[i], existing)) >= DUPLICATE_THRESHOLD) { duplicate = true; break; }
    }
    if (duplicate) { skipped++; continue; }
    kept.push({ unit: units[i], vector: vectors[i] });
    keptVectors.push(vectors[i]);
  }
  return { kept, skipped };
}

function locomoUnits(sample) {
  const conv = sample.conversation;
  const units = [];
  for (const key of Object.keys(conv).filter((k) => /^session_\d+$/.test(k))) {
    const when = parseLocomoDate(conv[`${key}_date_time`]);
    for (const turn of conv[key]) {
      const caption = turn.blip_caption ? ` [shared an image: ${turn.blip_caption}]` : "";
      units.push({
        id: `${sample.sample_id}:${turn.dia_id}`,
        createdAt: when,
        role: turn.speaker === conv.speaker_a ? "user" : "assistant",
        text: `[${iso(when)}] ${turn.speaker}: ${turn.text || ""}${caption}`,
      });
    }
  }
  return units;
}

function lmeUnits(item) {
  const dates = Array.isArray(item.haystack_dates) ? item.haystack_dates : JSON.parse(String(item.haystack_dates).replace(/'/g, '"'));
  const units = [];
  item.haystack_sessions.forEach((session, si) => {
    const when = parseLmeDate(dates[si]);
    session.forEach((turn, ti) => {
      const speaker = turn.role === "user" ? "User" : "Assistant";
      units.push({
        id: `${item.question_id}:s${si}:t${ti}`,
        createdAt: when,
        role: turn.role,
        text: `[${iso(when)}] ${speaker}: ${turn.content || ""}`,
      });
    });
  });
  return units;
}

const embeddings = await makeEmbeddings();
const manifest = [];
let totalRows = 0;
let totalSkipped = 0;

/**
 * Teilt mehrteilige Nachrichten in je einen Vektor je Aussage auf.
 *
 * Die Teilstuecke behalten die Herkunft in `sourceTurnId` — genau der
 * Schluessel, auf den chunkGroupKey() in der Recall-Pipeline zurueckfaellt.
 * Ein Schemawechsel ist dafuer nicht noetig; die Spalte gibt es laengst.
 *
 * Die Kennung des Teilstuecks haengt ein `#k` an die urspruengliche an, damit
 * der Belegabgleich des Benchmarks sie weiterhin der Originalzeile zuordnen
 * kann.
 */
function chunkUnits(units) {
  const out = [];
  for (const unit of units) {
    const plan = planChunks(String(unit.text || ""));
    if (plan.mode !== "structural" || plan.parts.length < 2) {
      out.push({ ...unit, sourceTurnId: unit.id });
      continue;
    }
    plan.parts.forEach((teil, k) => {
      out.push({ ...unit, id: `${unit.id}#${k}`, text: teil, sourceTurnId: unit.id });
    });
  }
  return out;
}

async function ingestOne(storeName, rohUnits, agentId, dbSub) {
  const units = CHUNKED ? chunkUnits(rohUnits) : rohUnits;
  const vectors = await embedAll(embeddings, units.map((u) => u.text));
  const { kept, skipped } = dedup(units, vectors);
  const rows = kept.map(({ unit, vector }) => captureRow({ ...unit, vector, agentId, origin: "dm" }));
  await writeStore(join(BENCH, dbSub, storeName), rows);
  totalRows += rows.length;
  totalSkipped += skipped;
  manifest.push({ store: storeName, rows: rows.length, deduped: skipped });
  return rows.length;
}

if (which === "locomo") {
  const data = JSON.parse(readFileSync(join(BENCH, "data/locomo10.json"), "utf8")).slice(0, LIMIT);
  for (const sample of data) {
    const n = await ingestOne(sample.sample_id, locomoUnits(sample), "bench-locomo", `db-capture${DB_SUFFIX}/locomo`);
    console.log(`locomo ${sample.sample_id}: ${n} rows`);
  }
} else if (which === "lme") {
  const data = JSON.parse(readFileSync(join(BENCH, "data/longmemeval_oracle.json"), "utf8")).slice(0, LIMIT);
  let done = 0;
  await pMap(data, 4, async (item) => {
    await ingestOne(item.question_id, lmeUnits(item), "bench-lme", `db-capture${DB_SUFFIX}/lme`);
    if (++done % 25 === 0) console.log(`lme ${done}/${data.length}`);
  });
} else {
  console.error("Usage: node ingest-capture.mjs locomo|lme [--limit N]");
  process.exit(2);
}

writeFileSync(join(BENCH, `results/ingest-capture${DB_SUFFIX}-${which}.json`), JSON.stringify({ when: new Date().toISOString(), stores: manifest.length, rows: totalRows, deduped: totalSkipped, manifest }, null, 2));
console.log(`done: ${manifest.length} stores, ${totalRows} rows, ${totalSkipped} als Duplikat verworfen`);
await embeddings.shutdown?.();
