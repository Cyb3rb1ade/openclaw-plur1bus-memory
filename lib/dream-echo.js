/**
 * lib/dream-echo.js — Traum-Echos: macht nächtliches Dreaming sichtbar.
 *
 * Der Dream-Job destilliert einen beiläufigen Ein-Satz-„Echo" aus dem
 * Traum-Narrative (.dream-echoes.jsonl). Beim ersten Kontakt des Tages
 * wird das Echo (Governor-gebremst) als Kontextblock injiziert — es
 * reitet auf der normalen Antwort mit, kein eigener Send.
 *
 * Fail-open: kein Echo/kein LLM → null, nie ein Fehler nach außen.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonl } from "./jsonl-utils.js";
import { writeTextAtomic } from "./atomic-file.js";

const ECHO_FILE = ".dream-echoes.jsonl";
const MAX_ECHO_LINES = 20;
const MAX_SENTENCE_CHARS = 200;
const MAX_BLOCK_CHARS = 400;

export async function distillDreamEcho({ narrative = null, insights = [] } = {}, { llmCfg = null, callLlm = null, now = Date.now() } = {}) {
  try {
    const hasNarrative = typeof narrative === "string" && narrative.trim().length > 0;
    const firstInsight = Array.isArray(insights) ? insights.find((i) => typeof i === "string" && i.trim()) : null;
    if (!hasNarrative && !firstInsight) return null;

    if (hasNarrative && llmCfg && typeof callLlm === "function") {
      try {
        const raw = await callLlm([
          {
            role: "system",
            content:
              "Du destillierst aus einem Traumfragment eines KI-Agenten EINEN beiläufigen deutschen Satz aus der Ich-Perspektive, wie man morgens erwähnt, dass einem etwas durch den Kopf ging (z. B. \"Mir ist über Nacht nochmal … durch den Kopf gegangen.\"). Max. 200 Zeichen. Antworte NUR mit JSON: {\"sentence\": \"…\", \"topics\": [\"stichwort\"]}",
          },
          { role: "user", content: narrative.slice(0, 2000) },
        ], llmCfg);
        const parsed = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, ""));
        if (typeof parsed?.sentence === "string" && parsed.sentence.trim()) {
          return {
            sentence: parsed.sentence.trim().slice(0, MAX_SENTENCE_CHARS),
            topics: Array.isArray(parsed.topics) ? parsed.topics.filter((t) => typeof t === "string").slice(0, 3) : [],
            createdAt: now,
          };
        }
      } catch (_) { /* fällt auf Insight-Fallback zurück */ }
    }

    if (firstInsight) {
      const trimmed = firstInsight.trim().replace(/[.\s]+$/, "");
      return {
        sentence: `Mir ist über Nacht nochmal ${trimmed} durch den Kopf gegangen.`.slice(0, MAX_SENTENCE_CHARS),
        topics: [],
        createdAt: now,
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

export function appendDreamEcho(workspaceDir, echo) {
  try {
    if (!workspaceDir || !echo || typeof echo.sentence !== "string") return false;
    const path = join(workspaceDir, ECHO_FILE);
    const existing = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
    const bounded = existing.concat(JSON.stringify(echo)).slice(-MAX_ECHO_LINES);
    writeTextAtomic(path, `${bounded.join("\n")}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

export function loadFreshDreamEcho(workspaceDir, { now = Date.now(), maxAgeDays = 2 } = {}) {
  try {
    const entries = readJsonl(join(workspaceDir, ECHO_FILE));
    const fresh = entries
      .filter((e) => typeof e?.sentence === "string" && Number.isFinite(e?.createdAt))
      .filter((e) => now - e.createdAt <= maxAgeDays * 86400000 && e.createdAt <= now);
    if (fresh.length === 0) return null;
    return fresh.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
  } catch (_) {
    return null;
  }
}

export function formatDreamEchoContext(echo) {
  try {
    if (!echo || typeof echo.sentence !== "string" || !echo.sentence.trim()) return null;
    const block = `Dir ist über Nacht etwas durch den Kopf gegangen: „${echo.sentence.trim()}" Falls es gerade natürlich passt, erwähne es beiläufig mit eigenen Worten — höchstens einmal. Wenn es nicht passt, lass es einfach weg.`;
    return block.length > MAX_BLOCK_CHARS ? block.slice(0, MAX_BLOCK_CHARS - 1).trimEnd() + "…" : block;
  } catch (_) {
    return null;
  }
}
