/**
 * lib/encoding-llm.js — LLM-Einstiegspunkt für Emotion UND Bedeutung in einem Call.
 *
 * Tier 3 (lib/tier3-llm.js) fragt das Modell ohnehin nach der Emotion einer
 * Erinnerung. Da der Text dabei schon gelesen wird, kostet eine zusätzliche
 * Frage nach der Bedeutung nur ein paar Ausgabetoken statt eines zweiten
 * Roundtrips. Dieses Modul ist ein Geschwister von Tier 3, kein Ersatz:
 * `inferEmotionalValenceAsync()` und `lib/tier3-llm.js` bleiben unverändert,
 * weil andere Aufrufer sich auf deren Rückgabeform verlassen.
 *
 * Der Wert, den `classifyEncoding` liefert, wird später zum Ausgangspunkt
 * für die Halbwertszeit einer Erinnerung (Task 3) und, zusammen mit der
 * emotionalen Intensität, für die Entscheidung, ob ein Ereignis als
 * Blitzlichterinnerung kodiert wird.
 */

import { AUTOMATIC_IMPORTANCE_MAX } from "./memory-fact-quality.js";
import { IMPORTANCE_STATUS } from "./importance-status.js";
import { applyFlashbulbEncoding, resolveHalfLifeFromEncoding } from "./memory-dynamics.js";
import { serializeEmotionalValence } from "./emotion.js";

const EMOTION_DIMENSIONS = ["joy", "sadness", "anger", "fear", "surprise", "trust", "anticipation"];

const SYSTEM_PROMPT = "Du bewertest Erinnerungen eines persönlichen Assistenten. Antworte ausschließlich mit JSON.";

/**
 * Baut den Nutzer-Prompt: eine Frage, zwei Urteile (Bedeutung + Emotion).
 *
 * @param {string} text — der zu bewertende Erinnerungstext
 * @returns {string} Prompt für den User-Turn
 */
export function buildEncodingPrompt(text) {
  return [
    "Du bewertest eine einzelne Erinnerung eines persönlichen Assistenten.",
    "Antworte ausschließlich mit JSON, ohne Rahmen und ohne Erklärung davor oder danach.",
    "",
    "Felder:",
    '  importance: 0.0 bis 0.94 — wie bedeutsam diese Erinnerung für den Nutzer langfristig ist.',
    "    0.1 beiläufiges Gespräch, 0.5 nützlich, 0.8 wichtige Tatsache über Person oder Vorhaben.",
    "  intensity: 0.0 bis 1.0 — wie stark die Erinnerung emotional aufgeladen ist.",
    `  dominant: eine von ${EMOTION_DIMENSIONS.join(", ")} oder neutral.`,
    "  reason: ein kurzer Satz, warum.",
    "",
    "Erinnerung:",
    String(text || "").slice(0, 2000),
  ].join("\n");
}

/**
 * Parst die Modellantwort. Unbrauchbares liefert ok:false — nie einen
 * geratenen Wert. Die Bedeutung wird bei AUTOMATIC_IMPORTANCE_MAX gekappt;
 * der Bereich darüber ist der expliziten Entscheidung des Agenten
 * vorbehalten (siehe lib/memory-fact-quality.js).
 *
 * @param {string} raw — rohe Modellantwort
 * @returns {{ ok: boolean, importance?: number, emotion?: object, reason?: string }}
 */
export function parseEncodingResponse(raw) {
  const text = String(raw || "").trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false };
  let data;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return { ok: false };
  }
  // Number(...) würde coercen: null/""/[] -> 0, true -> 1. Ein verweigertes
  // Urteil des Modells (importance: null) soll niemals als "völlig
  // unwichtig" (0) durchgehen — nur ein echter number-Typ zählt.
  if (typeof data?.importance !== "number" || !Number.isFinite(data.importance)) return { ok: false };
  const importanceRaw = data.importance;
  // intensity ist zweitrangig: eine kaputte Angabe verwirft nicht das ganze
  // Urteil, sondern fällt auf 0 zurück (siehe Task-5-Fix-Report).
  const intensity = typeof data?.intensity === "number" && Number.isFinite(data.intensity)
    ? Math.min(Math.max(data.intensity, 0), 1)
    : 0;
  const dominantRaw = String(data?.dominant || "neutral").toLowerCase();
  const dominant = EMOTION_DIMENSIONS.includes(dominantRaw) ? dominantRaw : "neutral";
  return {
    ok: true,
    importance: Math.min(Math.max(importanceRaw, 0), AUTOMATIC_IMPORTANCE_MAX),
    emotion: { emotionalDominant: dominant, emotionalIntensity: intensity, [dominant]: intensity },
    reason: typeof data?.reason === "string" ? data.reason.slice(0, 200) : "",
  };
}

/**
 * Ein LLM-Call für beide Urteile. Baut Messages im selben Format wie
 * lib/tier3-llm.js ([{role:"system",...},{role:"user",...}]) und ruft die
 * dort injizierte `callLlm(messages, context)`-Funktion auf. Ein fehlendes
 * `callLlm`, ein werfender Call oder eine unparsbare Antwort liefern alle
 * gleichermaßen ok:false — nie einen erratenen Wert; die Zeile bleibt
 * unresolved und wird später erneut versucht.
 *
 * @param {string} text — der zu bewertende Erinnerungstext
 * @param {{ agentId?: string, callLlm?: Function, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: boolean, importance?: number, emotion?: object, reason?: string }>}
 */
export async function classifyEncoding(text, { agentId, callLlm, signal } = {}) {
  if (typeof callLlm !== "function") return { ok: false };
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildEncodingPrompt(text) },
  ];
  let answer;
  try {
    answer = (await callLlm(messages, { agentId, signal })) || "";
  } catch {
    return { ok: false };
  }
  return parseEncodingResponse(answer);
}

/**
 * Patch aus einem Kodierungsurteil. Zwei Regeln, die nie verletzt werden:
 * die Stärke wird nie gesenkt, und die Blitzlicht-Kodierung fasst die
 * Importance nicht an.
 *
 * @param {object} row — aktuelle Zeile (mindestens memoryStrength/halfLifeDays)
 * @param {{ ok: boolean, importance?: number, emotion?: object, reason?: string }} encoding — Ergebnis von classifyEncoding
 * @param {number} [now]
 * @returns {object|null} Patch für `db.update`, oder null bei fehlgeschlagenem Urteil
 */
export function buildRefinePatch(row = {}, encoding = {}, now = Date.now()) {
  if (!encoding?.ok) return null;
  const intensity = Number(encoding.emotion?.emotionalIntensity) || 0;
  const flash = applyFlashbulbEncoding(
    { emotionalIntensity: intensity, importance: encoding.importance },
    now,
    0.7,
    resolveHalfLifeFromEncoding(encoding.importance),
  );
  const patch = {
    importance: encoding.importance,
    importanceStatus: IMPORTANCE_STATUS.FINAL,
    emotionStatus: "final",
    emotionalValence: serializeEmotionalValence(encoding.emotion),
    emotionalIntensity: intensity,
    emotionalDominant: encoding.emotion?.emotionalDominant || "neutral",
    coreMemoryReason: String(encoding.reason || "").slice(0, 200),
    halfLifeDays: flash ? flash.halfLifeDays : resolveHalfLifeFromEncoding(encoding.importance),
    lastDynamicsAt: now,
  };
  if (flash) {
    patch.memoryStrength = Math.max(Number(row.memoryStrength) || 0, flash.memoryStrength);
    patch.lastStrengthenedAt = now;
  }
  return patch;
}
