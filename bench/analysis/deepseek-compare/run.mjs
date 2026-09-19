/**
 * run.mjs — deepseek-flash gegen die bereits gespeicherten Kimi-Urteile.
 *
 * Die 691 heisenberg-Zeilen tragen seit dem Piloten das Kimi-Urteil in
 * importance/emotionalValence und ihren Vorzustand in updateEvidence. Der
 * Vergleich kostet deshalb nur DeepSeek-Aufrufe — Kimi wird nicht erneut
 * gefragt. Geschrieben wird nichts; die Datenbank wird nur gelesen.
 */
import { readFileSync, writeFileSync } from "node:fs";
const RELEASE = process.env.PLUR1BUS_RELEASE || "/root/.openclaw/plur1bus-release";
const LIB = `${RELEASE}/lib`;
const { buildEncodingPrompt, parseEncodingResponse } = await import(`${LIB}/encoding-llm.js`);
const { EMOTION_DIMENSIONS, serializeEmotionalValence } = await import(`${LIB}/emotion.js`);

const KEY = readFileSync("/tmp/claude-0/-root/7df64ac5-da5d-4940-b953-91fd1fd5fa7a/scratchpad/.deepseek-key", "utf8").trim();
const MODEL = "deepseek-flash";
const N = 20;

const lancedb = await import("/root/.openclaw/plur1bus-release/node_modules/@lancedb/lancedb/dist/index.js");
const db = await lancedb.connect("/root/.openclaw/memory/lancedb-namespaced/heisenberg");
const table = await db.openTable("memories");
const all = await table.query().limit(5000).toArray();
const judged = all.filter((r) => r.updateSource === "importance-v2" && String(r.text || "").length >= 20);

// Nach Länge sortiert, dann gleichmäßig durchgegriffen: deckt kurze, mittlere
// und die über der 2000-Zeichen-Kappung liegenden Texte gleichermaßen ab.
judged.sort((a, b) => String(a.text).length - String(b.text).length);
const step = Math.max(1, Math.floor(judged.length / N));
const sample = Array.from({ length: N }, (_, i) => judged[i * step]).filter(Boolean);

const vec = (e) => EMOTION_DIMENSIONS.map((d) => e?.[d] ?? 0);
// Kimis Vektor steht als "joy:0.40,trust:0.20" in der Zeile.
const parseValence = (s) => {
  const out = {};
  for (const part of String(s || "").split(",")) {
    const [k, v] = part.split(":");
    if (k && v) out[k.trim()] = Number(v);
  }
  return out;
};

const rows = [];
for (const row of sample) {
  const started = Date.now();
  let parsed = { ok: false };
  let usage = {};
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1500,
        messages: [
          { role: "system", content: "Du bewertest Erinnerungen eines persönlichen Assistenten. Antworte ausschließlich mit JSON." },
          { role: "user", content: buildEncodingPrompt(String(row.text)) },
        ],
      }),
    });
    const body = await res.json();
    if (!res.ok) { console.log("FEHLER:", JSON.stringify(body).slice(0, 300)); break; }
    usage = body?.usage || {};
    parsed = parseEncodingResponse(body?.choices?.[0]?.message?.content || "");
  } catch (err) {
    console.log("AUSNAHME:", err.message);
  }
  rows.push({
    id: row.id,
    len: String(row.text).length,
    kimi: { importance: row.importance, dominant: row.emotionalDominant, valence: row.emotionalValence },
    deepseek: parsed.ok
      ? { importance: parsed.importance, dominant: parsed.emotion.emotionalDominant, valence: serializeEmotionalValence(parsed.emotion) }
      : null,
    usage, latencyMs: Date.now() - started,
  });
}

writeFileSync(new URL("./results.json", import.meta.url).pathname, JSON.stringify(rows, null, 2));

const ok = rows.filter((r) => r.deepseek);
const mean = (f) => ok.reduce((s, r) => s + f(r), 0) / (ok.length || 1);
console.log(`n=${rows.length}, davon geparst ${ok.length}`);
console.log(`|dImportance| ${mean((r) => Math.abs(r.kimi.importance - r.deepseek.importance)).toFixed(3)}`
  + `  max ${Math.max(...ok.map((r) => Math.abs(r.kimi.importance - r.deepseek.importance))).toFixed(2)}`);
console.log(`dominant gleich ${(100 * ok.filter((r) => r.kimi.dominant === r.deepseek.dominant).length / ok.length).toFixed(1)} %`);
console.log(`L1(Vektor) ${mean((r) => { const a = vec(parseValence(r.kimi.valence)), b = vec(parseValence(r.deepseek.valence)); return a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0); }).toFixed(3)}`);
console.log(`Importance Kimi ${mean((r) => r.kimi.importance).toFixed(3)} vs DeepSeek ${mean((r) => r.deepseek.importance).toFixed(3)}`);
console.log(`Tokens rein ${mean((r) => r.usage.prompt_tokens || 0).toFixed(0)}  raus ${mean((r) => r.usage.completion_tokens || 0).toFixed(0)}`
  + `  davon Denken ${mean((r) => r.usage.completion_tokens_details?.reasoning_tokens || 0).toFixed(0)}`);
console.log(`Latenz ${mean((r) => r.latencyMs).toFixed(0)} ms`);
