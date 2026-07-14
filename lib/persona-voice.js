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

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
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
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, updated, "utf8");
    renameSync(tmp, path);
    return true;
  } catch (_) {
    return false;
  }
}
