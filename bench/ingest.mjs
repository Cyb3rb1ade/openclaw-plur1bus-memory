/**
 * Ingest: schreibt LOCOMO- bzw. LongMemEval-Gespräche als PLUR1BUS-Memory-Zeilen
 * in je eine eigene LanceDB (ein Store pro Gespräch bzw. pro Frage-Haystack).
 *
 * Usage: node ingest.mjs locomo|lme [--limit N]
 */
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { BENCH, lancedb, loadEnv, makeEmbeddings, memoryRow, pMap } from "./lib/common.mjs";

loadEnv();
const which = process.argv[2];
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
const EMBED_BATCH = 96;

const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };

/** "1:56 pm on 8 May, 2023" → epoch ms (UTC) */
function parseLocomoDate(raw) {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),\s*(\d{4})$/.exec(String(raw).trim());
  if (!m) throw new Error(`unparsable LOCOMO date: ${raw}`);
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") hour += 12;
  return Date.UTC(Number(m[6]), MONTHS[m[5].toLowerCase()], Number(m[4]), hour, Number(m[2]));
}

/** "2023/04/10 (Mon) 17:50" → epoch ms (UTC) */
function parseLmeDate(raw) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})[^\d]*(\d{2}):(\d{2})$/.exec(String(raw).trim());
  if (!m) throw new Error(`unparsable LongMemEval date: ${raw}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

async function writeStore(dir, rows) {
  await rm(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const db = await lancedb.connect(dir);
  const table = await db.createTable("memories", rows.slice(0, 1));
  for (let i = 1; i < rows.length; i += 500) await table.add(rows.slice(i, i + 500));
  return rows.length;
}

async function embedAll(embeddings, texts) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    vectors.push(...await embeddings.embedBatch(texts.slice(i, i + EMBED_BATCH)));
  }
  return vectors;
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
        text: `[${iso(when)}] ${speaker}: ${turn.content || ""}`,
      });
    });
  });
  return units;
}

async function main() {
  const embeddings = await makeEmbeddings();
  const manifest = [];
  let totalRows = 0;

  if (which === "locomo") {
    const data = JSON.parse(readFileSync(join(BENCH, "data/locomo10.json"), "utf8")).slice(0, LIMIT);
    for (const sample of data) {
      const units = locomoUnits(sample);
      const vectors = await embedAll(embeddings, units.map((u) => u.text));
      const rows = units.map((u, i) => memoryRow({ ...u, vector: vectors[i], agentId: "bench-locomo" }));
      totalRows += await writeStore(join(BENCH, "db/locomo", sample.sample_id), rows);
      manifest.push({ store: sample.sample_id, rows: rows.length, questions: sample.qa.length });
      console.log(`locomo ${sample.sample_id}: ${rows.length} rows`);
    }
  } else if (which === "lme") {
    const data = JSON.parse(readFileSync(join(BENCH, "data/longmemeval_oracle.json"), "utf8")).slice(0, LIMIT);
    let done = 0;
    await pMap(data, 4, async (item) => {
      const units = lmeUnits(item);
      const vectors = await embedAll(embeddings, units.map((u) => u.text));
      const rows = units.map((u, i) => memoryRow({ ...u, vector: vectors[i], agentId: "bench-lme" }));
      const written = await writeStore(join(BENCH, "db/lme", item.question_id), rows);
      totalRows += written;
      manifest.push({ store: item.question_id, rows: rows.length, questions: 1 });
      if (++done % 25 === 0) console.log(`lme ${done}/${data.length}`);
    });
  } else {
    console.error("Usage: node ingest.mjs locomo|lme [--limit N]");
    process.exit(2);
  }

  writeFileSync(join(BENCH, `results/ingest-${which}.json`), JSON.stringify({ when: new Date().toISOString(), stores: manifest.length, rows: totalRows, manifest }, null, 2));
  console.log(`done: ${manifest.length} stores, ${totalRows} rows`);
  await embeddings.shutdown?.();
}

await main();
