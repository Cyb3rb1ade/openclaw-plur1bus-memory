/**
 * lib/jobs/skill-miner/nudge-renderer.js
 *
 * Render a skill-proposal reminder nudge in the user's language and
 * the agent's tone (from SOUL.MD / IDENTITY.MD if available).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const GERMAN_WORDS = new Set([
  "der", "die", "das", "und", "ist", "zu", "den", "mit", "ich", "auf",
  "für", "sich", "dem", "nicht", "ein", "eine", "als", "auch", "es", "an",
  "werden", "aus", "er", "hat", "dass", "sie", "nach", "wird", "bei",
  "einer", "der", "um", "am", "sind", "noch", "wie", "einen", "so",
  "zur", "aber", "über", "dich", "dein", "deine", "dir", "mir", "mich",
  "mein", "meine", "wir", "uns", "unser", "euch", "euer", "ihr", "ihnen",
  "ja", "nein", "bitte", "danke", "gern", "hallo", "hi", "hej", "moin",
]);

function detectLanguage(messages = []) {
  const userTexts = messages
    .filter(m => m.role === "user" && typeof m.content === "string")
    .map(m => m.content)
    .slice(-3);
  if (userTexts.length === 0) return "en";
  const sample = userTexts.join(" ").toLowerCase();
  const germanHits = GERMAN_WORDS.size === 0 ? 0 :
    sample.split(/\s+/).filter(w => GERMAN_WORDS.has(w)).length;
  return germanHits >= 2 ? "de" : "en";
}

function readSoulTone(workspaceDir) {
  if (!workspaceDir) return null;
  const candidates = ["SOUL.MD", "SOUL.md", "soul.md", "IDENTITY.MD", "IDENTITY.md", "identity.md"];
  for (const name of candidates) {
    const path = join(workspaceDir, name);
    if (existsSync(path)) {
      try {
        const text = readFileSync(path, "utf8");
        // Extract tone/voice hints from common headings
        const toneMatch = text.match(/(?:Tone|Voice|Duktus|Stil|Personality| persona)[:\s]*([^\n]+)/i);
        if (toneMatch) return toneMatch[1].trim();
        // Fallback: first non-heading, non-comment line
        const firstLine = text.split("\n").find(l => l.trim() && !l.startsWith("#") && !l.startsWith("<!--"));
        if (firstLine) return firstLine.trim();
      } catch (_) {}
    }
  }
  return null;
}

const NUDGE_TEMPLATES = {
  de: {
    casual: `Ich habe mir unsere Gespräche angeschaut und ein wiederkehrendes Muster entdeckt: "{{description}}". Soll ich daraus einen Skill machen, damit ich es dir automatisch anbiete? Sag ja, nein oder schau dir alle Vorschläge mit \`/plur1bus skills review\` an.{{more}}`,
    formal: `Bei der Analyse unserer Gespräche ist ein wiederkehrendes Muster aufgefallen: "{{description}}". Soll dies in einen wiederverwendbaren Skill überführt werden? Bestätigen mit "ja", ablehnen mit "nein", oder alle Vorschläge mit \`/plur1bus skills review\` prüfen.{{more}}`,
    default: `Ich habe ein Muster in unseren Gesprächen entdeckt: "{{description}}". Soll ich daraus einen Skill erstellen? Du kannst ja, nein sagen oder \`/plur1bus skills review\` nutzen.{{more}}`,
  },
  en: {
    casual: `I've been reviewing our conversations and noticed a repeatable pattern: "{{description}}". Want me to turn this into a skill so I always act on it? Say yes, no, or review all suggestions with \`/plur1bus skills review\`.{{more}}`,
    formal: `Analysis of our conversations reveals a repeatable pattern: "{{description}}". Shall this be converted into a reusable skill? Confirm with "yes", decline with "no", or review all proposals via \`/plur1bus skills review\`.{{more}}`,
    default: `I noticed a pattern in our conversations: "{{description}}". Should I create a skill from this? You can say yes, no, or use \`/plur1bus skills review\`.{{more}}`,
  },
};

function pickTone(toneHint) {
  if (!toneHint) return "default";
  const t = toneHint.toLowerCase();
  if (t.includes("casual") || t.includes("friendly") || t.includes("warm") || t.includes("relaxed") || t.includes("locker")) return "casual";
  if (t.includes("formal") || t.includes("professional") || t.includes("strict") || t.includes("business") || t.includes("förmlich")) return "formal";
  return "default";
}

export function renderSkillProposalNudge(proposal, pendingCount, opts = {}) {
  const { workspaceDir, messages } = opts;
  const lang = detectLanguage(messages);
  const toneHint = readSoulTone(workspaceDir);
  const tone = pickTone(toneHint);

  const template = NUDGE_TEMPLATES[lang]?.[tone] || NUDGE_TEMPLATES.en.default;
  const more = pendingCount > 1 ? (lang === "de" ? ` (und ${pendingCount - 1} weitere)` : ` (and ${pendingCount - 1} more)`) : "";

  return template
    .replace("{{description}}", proposal.description || proposal.skillTitle || "")
    .replace("{{more}}", more);
}
