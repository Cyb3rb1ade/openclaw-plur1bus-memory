/**
 * lib/persona-voice.js — Idiolekt pro Agent: Seed + Datei + Direktive.
 *
 * persona-voice.md im Workspace: Managed-Block zwischen Markern gehört dem
 * Plugin (Seed, akzeptierte Evolutions-Marker); alles außerhalb gehört dem
 * User und wird nie angefasst. Die Direktive wird NUR aus dem Managed-Block
 * gebaut (User-Notizen landen nicht im Prompt).
 *
 * Fail-open: keine Datei / kein LLM → null, Feature inert.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeTextAtomic } from "./atomic-file.js";

export const PERSONA_FILE = "persona-voice.md";
export const MARKER_BEGIN = "<!-- persona:begin -->";
export const MARKER_END = "<!-- persona:end -->";
const MAX_DIRECTIVE_CHARS = 400;

const directiveCache = new Map(); // path → { mtimeMs, directive }

function personaPath(workspaceDir) {
  return join(workspaceDir, PERSONA_FILE);
}

export function hasPersonaVoice(workspaceDir) {
  try { return existsSync(personaPath(workspaceDir)); } catch (_) { return false; }
}

export async function generatePersonaSeed({ agentId = "agent", lang = "de", identityText = "", llmCfg = null, callLlm = null } = {}) {
  try {
    if (!llmCfg || typeof callLlm !== "function") return null;
    const raw = await callLlm([
      {
        role: "system",
        content:
          `Du entwirfst die Grundstimme eines Chat-Agenten namens "${agentId}" (Sprache: ${lang}). ` +
          "Antworte NUR mit 5-8 Markdown-Bullet-Zeilen (jede beginnt mit \"- \"): Satzlängen-Neigung, 2-3 Lieblingswendungen, Emoji-Palette und -Frequenz, Anrede-Stil, genau eine harmlose Marotte. " +
          "Keine Rollenprosa, keine Überschriften, kein Text außerhalb der Bullets.",
      },
      { role: "user", content: identityText ? `Identitäts-Hinweise:\n${identityText.slice(0, 2000)}` : "Keine weiteren Hinweise — entwirf eine natürliche, unaufdringliche Stimme." },
    ], llmCfg);
    const lines = String(raw).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
    if (lines.length < 3) return null;
    return lines.slice(0, 8).join("\n");
  } catch (_) {
    return null;
  }
}

export function writePersonaVoice(workspaceDir, seedMarkdown) {
  try {
    if (!workspaceDir || typeof seedMarkdown !== "string" || !seedMarkdown.trim()) return false;
    const path = personaPath(workspaceDir);
    if (existsSync(path)) return false;
    mkdirSync(workspaceDir, { recursive: true });
    const content = [
      "# Persona-Voice",
      "",
      "Dieses Profil färbt die Grundstimme des Agenten. Der Block zwischen den",
      "Markern wird vom Plugin verwaltet; alles außerhalb gehört dir.",
      "",
      MARKER_BEGIN,
      seedMarkdown.trim(),
      MARKER_END,
      "",
    ].join("\n");
    writeTextAtomic(path, content);
    return true;
  } catch (_) {
    return false;
  }
}

export function readPersonaFile(workspaceDir) {
  try {
    const path = personaPath(workspaceDir);
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf8");
    const begin = content.indexOf(MARKER_BEGIN);
    const end = content.indexOf(MARKER_END);
    if (begin === -1 || end === -1 || end <= begin) return { content, managedBlock: null };
    const managedBlock = content.slice(begin + MARKER_BEGIN.length, end).trim();
    return { content, managedBlock };
  } catch (_) {
    return null;
  }
}

export function loadPersonaDirective(workspaceDir, { maxChars = MAX_DIRECTIVE_CHARS } = {}) {
  try {
    const path = personaPath(workspaceDir);
    if (!existsSync(path)) return null;
    const mtimeMs = statSync(path).mtimeMs;
    const cached = directiveCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) return cached.directive;

    const parsed = readPersonaFile(workspaceDir);
    if (!parsed?.managedBlock) {
      directiveCache.set(path, { mtimeMs, directive: null });
      return null;
    }
    const markers = parsed.managedBlock
      .split("\n").map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim().replace(/[.;\s]+$/, ""));
    if (markers.length === 0) {
      directiveCache.set(path, { mtimeMs, directive: null });
      return null;
    }
    let directive = `Deine Grundstimme (befolge sie, ohne sie zu benennen): ${markers.join("; ")}.`;
    if (directive.length > maxChars) directive = directive.slice(0, maxChars - 1).trimEnd() + "…";
    directiveCache.set(path, { mtimeMs, directive });
    return directive;
  } catch (_) {
    return null;
  }
}

export function appendMarkerToManagedBlock(workspaceDir, markerLine) {
  try {
    if (typeof markerLine !== "string" || !markerLine.trim().startsWith("- ")) return false;
    const path = personaPath(workspaceDir);
    const parsed = readPersonaFile(workspaceDir);
    if (!parsed || parsed.managedBlock == null) return false;
    const endIdx = parsed.content.indexOf(MARKER_END);
    const updated = `${parsed.content.slice(0, endIdx).trimEnd()}\n${markerLine.trim()}\n${parsed.content.slice(endIdx)}`;
    writeTextAtomic(path, updated);
    return true;
  } catch (_) {
    return false;
  }
}

export const PROPOSAL_HEADER = "## Vorschlag (nicht aktiv)";
const EVOLUTION_MIN_OUTCOMES = 10;
const EVOLUTION_WINDOW_MS = 7 * 86400000;
const EVOLUTION_MIN_POSITIVE_RATE = 0.5;
const EVO_POSITIVE = new Set(["confirmed_or_continued", "continued_topic", "acknowledged"]);
const EVO_NEGATIVE = new Set(["ignored_or_topic_shifted", "rejected", "corrected"]);

function replaceProposalSection(content, sectionText) {
  const idx = content.indexOf(PROPOSAL_HEADER);
  if (idx === -1) {
    const base = content.trimEnd();
    return sectionText ? `${base}\n\n${sectionText}\n` : `${base}\n`;
  }
  // Bound the proposal section: it ends at the next "## " heading after
  // PROPOSAL_HEADER, or at EOF if none. Everything before the header and
  // everything from that next heading onward belongs to the user and must
  // be preserved — the (possibly updated) proposal section is appended at
  // the end of the file.
  const searchFrom = idx + PROPOSAL_HEADER.length;
  const nextHeadingIdx = content.indexOf("\n## ", searchFrom);
  const before = content.slice(0, idx).trimEnd();
  const after = nextHeadingIdx === -1 ? "" : content.slice(nextHeadingIdx + 1).trimEnd();

  const parts = [before];
  if (after) parts.push(after);
  if (sectionText) parts.push(sectionText);
  return `${parts.join("\n\n")}\n`;
}

export async function proposePersonaEvolution({ workspaceDir, outcomes = [], llmCfg = null, callLlm = null, now = Date.now() } = {}) {
  try {
    const parsed = readPersonaFile(workspaceDir);
    if (!parsed || parsed.managedBlock == null) return { proposed: false, reason: "no_persona_file" };
    if (!llmCfg || typeof callLlm !== "function") return { proposed: false, reason: "no_llm" };

    const recent = (Array.isArray(outcomes) ? outcomes : []).filter(
      (o) => Number.isFinite(o?.timestamp) && now - o.timestamp <= EVOLUTION_WINDOW_MS,
    );
    if (recent.length < EVOLUTION_MIN_OUTCOMES) return { proposed: false, reason: "too_few_outcomes" };
    const positive = recent.filter((o) => EVO_POSITIVE.has(o.outcome)).length;
    const negative = recent.filter((o) => EVO_NEGATIVE.has(o.outcome)).length;
    if (positive + negative === 0 || positive / (positive + negative) <= EVOLUTION_MIN_POSITIVE_RATE) {
      return { proposed: false, reason: "no_positive_trend" };
    }

    const raw = await callLlm([
      {
        role: "system",
        content:
          "Hier ist das aktuelle Stimm-Profil eines Chat-Agenten. Schlage GENAU EINE kleine Änderung vor: einen neuen Marker, der die Stimme leicht schärft (Wendung, Marotte, Emoji-Nuance). Antworte NUR mit einer einzigen Markdown-Bullet-Zeile, beginnend mit \"- \".",
      },
      { role: "user", content: parsed.managedBlock.slice(0, 2000) },
    ], llmCfg);
    const marker = String(raw).split("\n").map((l) => l.trim()).find((l) => l.startsWith("- "));
    if (!marker) return { proposed: false, reason: "llm_no_marker" };

    const path = join(workspaceDir, PERSONA_FILE);
    const section = `${PROPOSAL_HEADER}\n\nÜbernehmen mit /plur1bus persona accept — oder diese Sektion einfach löschen.\n\n${marker}`;
    const updated = replaceProposalSection(parsed.content, section);
    writeTextAtomic(path, updated);
    return { proposed: true, marker };
  } catch (_) {
    return { proposed: false, reason: "error" };
  }
}

export function acceptPersonaProposal(workspaceDir) {
  try {
    const parsed = readPersonaFile(workspaceDir);
    if (!parsed || parsed.managedBlock == null) return { accepted: false };
    const idx = parsed.content.indexOf(PROPOSAL_HEADER);
    if (idx === -1) return { accepted: false };
    const section = parsed.content.slice(idx);
    const marker = section.split("\n").map((l) => l.trim()).find((l) => l.startsWith("- "));
    if (!marker) return { accepted: false };
    if (!appendMarkerToManagedBlock(workspaceDir, marker)) return { accepted: false };
    const after = readPersonaFile(workspaceDir);
    const path = join(workspaceDir, PERSONA_FILE);
    const cleaned = replaceProposalSection(after.content, null);
    writeTextAtomic(path, cleaned);
    return { accepted: true, marker };
  } catch (_) {
    return { accepted: false };
  }
}
