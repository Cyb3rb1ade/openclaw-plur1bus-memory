/**
 * run-ab.mjs — A/B/A-Lauf für das Emotionskarten-Format.
 *
 * Drei Arme auf identischen Texten:
 *   full  — der Produktions-Prompt (alle acht Dimensionen verlangt)
 *   short — nur die tatsächlich mitschwingenden Dimensionen
 *   full2 — zweiter full-Lauf als Rauschboden; ohne ihn lässt sich nicht
 *           unterscheiden, ob eine Abweichung am Format oder an der
 *           Nichtdeterminiertheit des Modells liegt.
 *
 * Produktionscode wird importiert, nicht verändert: derselbe Parser bewertet
 * beide Formate. parseEncodingResponse füllt fehlende Dimensionen bereits mit
 * 0 — der kurze Prompt braucht deshalb keine Parser-Änderung.
 */
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const RELEASE = process.env.PLUR1BUS_RELEASE || "/root/.openclaw/plur1bus-release";
const LIB = `${RELEASE}/lib`;
const { buildEncodingPrompt, parseEncodingResponse } = await import(`${LIB}/encoding-llm.js`);
const { EMOTION_DIMENSIONS } = await import(`${LIB}/emotion.js`);

const SAMPLE = new URL("./sample.jsonl", import.meta.url).pathname;
const OUT = new URL("./results.jsonl", import.meta.url).pathname;

const MODEL = process.env.AB_MODEL || "kimi-for-coding-highspeed";
const MAX_TOKENS = Number(process.env.AB_MAX_TOKENS || 1500);
const CONCURRENCY = 3;

const KEY = execSync(
  "grep -oh 'sk-[A-Za-z0-9_-]*HwGIw' /root/.openclaw/workspace/.kimi-coding-key-final.txt /root/.openclaw/workspace/.kimi-coding-key.txt 2>/dev/null | sort -u | head -1",
  { encoding: "utf8" },
).trim();
if (!KEY) throw new Error("kein kimi-coding-Key gefunden");

const SYSTEM_PROMPT = "Du bewertest Erinnerungen eines persönlichen Assistenten. Antworte ausschließlich mit JSON.";

/** Der kurze Prompt: identisch bis auf die eine emotions-Zeile. */
function buildShortPrompt(text) {
  const full = buildEncodingPrompt(text);
  const lineStart = "  emotions: Objekt mit einem Wert";
  const lines = full.split("\n");
  const idx = lines.findIndex((l) => l.startsWith(lineStart));
  if (idx < 0) throw new Error("emotions-Zeile im Produktions-Prompt nicht gefunden");
  lines[idx] = `  emotions: Objekt mit NUR den Dimensionen, die tatsächlich mitschwingen, je mit einem Wert 0.0 bis 1.0 (mögliche Dimensionen: ${EMOTION_DIMENSIONS.join(", ")}). Nicht mitschwingende Dimensionen weglassen, nicht mit 0 auffüllen; bei neutraler Erinnerung ein leeres Objekt {}.`;
  return lines.join("\n");
}

async function callModel(prompt) {
  const started = Date.now();
  const res = await fetch("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
      "User-Agent": "gsd/2.77.0",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  const bodyText = await res.text();
  const latencyMs = Date.now() - started;
  if (!res.ok) return { ok: false, httpStatus: res.status, error: bodyText.slice(0, 300), latencyMs };
  let body;
  try { body = JSON.parse(bodyText); } catch { return { ok: false, error: "unparsbarer Rahmen", latencyMs }; }
  const choice = body?.choices?.[0];
  return {
    ok: true,
    content: choice?.message?.content || "",
    finishReason: choice?.finish_reason || null,
    usage: body?.usage || null,
    latencyMs,
  };
}

const ARMS = [
  { arm: "full", build: buildEncodingPrompt },
  { arm: "short", build: buildShortPrompt },
  { arm: "full2", build: buildEncodingPrompt },
];

let rows = readFileSync(SAMPLE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
if (process.env.AB_LIMIT) rows = rows.slice(0, Number(process.env.AB_LIMIT));

const done = new Set();
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, "utf8").trim().split("\n")) {
    if (!line) continue;
    try { const r = JSON.parse(line); done.add(`${r.arm}::${r.id}`); } catch {}
  }
}

const jobs = [];
for (const arm of ARMS) for (const row of rows) {
  if (!done.has(`${arm.arm}::${row.id}`)) jobs.push({ arm, row });
}
console.log(`${jobs.length} offene Calls (${rows.length} Texte x ${ARMS.length} Arme, ${done.size} bereits erledigt)`);

let idx = 0;
let completed = 0;
async function worker() {
  while (idx < jobs.length) {
    const { arm, row } = jobs[idx++];
    const prompt = arm.build(row.text);
    const call = await callModel(prompt);
    const parsed = call.ok ? parseEncodingResponse(call.content) : { ok: false };
    appendFileSync(OUT, JSON.stringify({
      arm: arm.arm,
      id: row.id,
      agentId: row.agentId,
      textLength: row.text.length,
      call: { ok: call.ok, httpStatus: call.httpStatus ?? 200, finishReason: call.finishReason, usage: call.usage, latencyMs: call.latencyMs, error: call.error },
      raw: call.content ?? null,
      parsed,
    }) + "\n");
    completed += 1;
    if (completed % 20 === 0) console.log(`  ${completed}/${jobs.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`fertig: ${completed} Calls -> ${OUT}`);
