/**
 * live-check.mjs — Durchstich durch den INSTALLIERTEN Code (nicht den Worktree):
 * echte Zeilen aus der Produktions-DB, deployter Prompt, deployter Parser,
 * deploytes Tokenbudget. Rein lesend — kein Schreibzugriff auf die Datenbank.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
const EXT = "/root/.openclaw/extensions/memory-lancedb-namespaced/lib";
const { buildEncodingPrompt, parseEncodingResponse } = await import(`${EXT}/encoding-llm.js`);
const { serializeEmotionalValence } = await import(`${EXT}/emotion.js`);

const KEY = execSync("grep -oh 'sk-[A-Za-z0-9_-]*HwGIw' /root/.openclaw/workspace/.kimi-coding-key-final.txt /root/.openclaw/workspace/.kimi-coding-key.txt 2>/dev/null | sort -u | head -1", { encoding: "utf8" }).trim();
const MAX_TOKENS = 1500; // wie EMOTION_REFINE_ENCODING_MAX_TOKENS_DEFAULT im installierten index.js

// Die längsten Texte der Stichprobe — dort brach das alte Budget ab.
const rows = readFileSync("./sample.jsonl", "utf8").trim().split("\n").map(JSON.parse)
  .sort((a, b) => b.text.length - a.text.length).slice(0, 6);

for (const row of rows) {
  const res = await fetch("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, "User-Agent": "gsd/2.77.0" },
    body: JSON.stringify({
      model: "kimi-for-coding-highspeed", max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: "Du bewertest Erinnerungen eines persönlichen Assistenten. Antworte ausschließlich mit JSON." },
        { role: "user", content: buildEncodingPrompt(row.text) },
      ],
    }),
  });
  const body = await res.json();
  const choice = body?.choices?.[0];
  if (!choice) { console.log("ANTWORT:", JSON.stringify(body).slice(0, 400)); break; }
  const parsed = parseEncodingResponse(choice?.message?.content || "");
  const u = body?.usage || {};
  console.log(
    `len=${String(row.textLength ?? row.text.length).padStart(5)} finish=${String(choice?.finish_reason).padEnd(6)}`
    + ` compl=${String(u.completion_tokens).padStart(4)} denk=${String(u.completion_tokens_details?.reasoning_tokens ?? 0).padStart(4)}`
    + ` parse=${parsed.ok ? "ok " : "FEHL"} imp=${parsed.ok ? parsed.importance.toFixed(2) : "-"}`
    + ` valenz="${parsed.ok ? serializeEmotionalValence(parsed.emotion) : ""}"`,
  );
}
