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

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeTextAtomic } from "./atomic-file.js";
import { resolveInside } from "./sql-safety.js";

export const PERSONA_FILE = "persona-voice.md";
export const MARKER_BEGIN = "<!-- persona:begin -->";
export const MARKER_END = "<!-- persona:end -->";
const MAX_DIRECTIVE_CHARS = 400;
const IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "AGENT.md"];
// Matches a full ZWJ-composite emoji (e.g. \uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08, \uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67) plus skin-tone
// modifiers as ONE unit, not split into its constituent codepoints \u2014 a
// naive per-codepoint pattern splits '\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08' into ['\uD83C\uDFF3\uFE0F','\uD83C\uDF08'], which lets a
// single composite emoji masquerade as two entries and pass the \u22652-emoji
// palette heuristic below.
const EMOJI_PATTERN = /\p{Extended_Pictographic}\p{Emoji_Modifier}*(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}\p{Emoji_Modifier}*(?:\uFE0F)?)*/gu;

const directiveCache = new Map(); // path → { mtimeMs, directive }

function personaPath(workspaceDir) {
  return resolveInside(workspaceDir, PERSONA_FILE);
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

function findManagedEmojiPalette(managedBlock) {
  if (typeof managedBlock !== "string" || !managedBlock.trim()) return null;
  const lines = managedBlock
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
  for (const line of lines) {
    const body = line.slice(2).trim();
    const parts = body.split(":");
    if (parts.length < 2) continue;
    const label = parts.shift().trim();
    if (!/^(?:emoji\s*-\s*palette|emoji\s+palette|palette)$/i.test(label)) continue;
    const matches = parts.join(":").match(EMOJI_PATTERN);
    if (!matches || matches.length < 2) continue;
    return [...new Set(matches)].join(" ");
  }
  return null;
}

/**
 * Lädt eine Emoji-Palette ausschließlich aus dem Managed-Block.
 *
 * @param {string} workspaceDir - Workspace-Verzeichnis
 * @returns {string|null} Palette oder null, wenn keine offensichtliche Palette existiert
 */
export function loadPersonaEmojiPalette(workspaceDir) {
  try {
    const parsed = readPersonaFile(workspaceDir);
    return findManagedEmojiPalette(parsed?.managedBlock || null);
  } catch (_) {
    return null;
  }
}

function loadIdentityText(workspaceDir) {
  for (const identityFile of IDENTITY_FILES) {
    try {
      return readFileSync(resolveInside(workspaceDir, identityFile), "utf8").slice(0, 2000);
    } catch (_) { /* try next */ }
  }
  return "";
}

/**
 * Erzeugt beim Erststart fail-open ein Persona-Profil, falls noch keines existiert.
 *
 * @param {Object} params - Seed-Parameter
 * @param {string} params.workspaceDir - Workspace-Verzeichnis
 * @param {string} [params.agentId] - Agent-ID
 * @param {string} [params.lang] - Sprache
 * @param {Object|null} [params.llmCfg] - LLM-Konfiguration
 * @param {Function|null} [params.callLlm] - LLM-Aufrufer
 * @returns {Promise<boolean>} true nur wenn eine neue Persona-Datei geschrieben wurde
 */
export async function ensurePersonaVoiceSeed({ workspaceDir, agentId = "agent", lang = "de", llmCfg = null, callLlm = null } = {}) {
  try {
    if (!workspaceDir || !llmCfg || typeof callLlm !== "function" || hasPersonaVoice(workspaceDir)) return false;
    if (!statSync(workspaceDir).isDirectory()) return false;
    const seed = await generatePersonaSeed({
      agentId,
      lang,
      identityText: loadIdentityText(workspaceDir),
      llmCfg,
      callLlm,
    });
    if (!seed) return false;
    return writePersonaVoice(workspaceDir, seed);
  } catch (_) {
    return false;
  }
}

const PERSONA_SEED_BACKOFF_MS = 6 * 60 * 60 * 1000; // 6h

// Module-level state for the default (production) throttle. Tests inject
// their own Map/Set via the options param to avoid cross-test pollution.
const personaSeedLastAttempt = new Map(); // workspaceDir → ms of last failed attempt
const personaSeedInFlight = new Set(); // workspaceDir currently attempting

/**
 * Fire-and-forget wrapper around ensurePersonaVoiceSeed for the hot path
 * (before_prompt_build recall handler). The LLM call inside
 * ensurePersonaVoiceSeed has its own (potentially long, e.g. 30s) timeout,
 * which must never block prompt assembly running under a much shorter
 * recall timeout (e.g. 8s). This function:
 *   - never returns a promise the caller needs to await to stay non-blocking
 *     (a hanging callLlm never delays the caller's own return);
 *   - guards against concurrent in-flight attempts for the same workspaceDir
 *     (two messages arriving close together must not double-fire the LLM);
 *   - backs off for PERSONA_SEED_BACKOFF_MS after a failed attempt (no seed
 *     written), so a persistently failing LLM doesn't retry every message.
 *
 * @param {Object} params - same shape as ensurePersonaVoiceSeed's params
 * @param {Object} [opts] - test-injectable state
 * @param {number} [opts.now] - current time in ms (defaults to Date.now())
 * @param {Map<string, number>} [opts.attempts] - workspaceDir → last failed attempt ms
 * @param {Set<string>} [opts.inFlight] - workspaceDirs currently attempting
 * @returns {Promise<boolean>|undefined} settles once the (possibly skipped)
 *   attempt is done — callers on the hot path MUST NOT await this.
 */
export function scheduleEnsurePersonaVoiceSeed(params = {}, { now = Date.now(), attempts = personaSeedLastAttempt, inFlight = personaSeedInFlight } = {}) {
  const workspaceDir = params?.workspaceDir;
  if (!workspaceDir) return undefined;
  if (inFlight.has(workspaceDir)) return undefined;
  const last = attempts.get(workspaceDir);
  if (typeof last === "number" && now - last < PERSONA_SEED_BACKOFF_MS) return undefined;

  inFlight.add(workspaceDir);
  return ensurePersonaVoiceSeed(params)
    .then((wrote) => {
      if (wrote) attempts.delete(workspaceDir);
      else attempts.set(workspaceDir, now);
      return wrote;
    })
    .catch(() => {
      attempts.set(workspaceDir, now);
      return false;
    })
    .finally(() => {
      inFlight.delete(workspaceDir);
    });
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

// Auto-Apply lässt den Managed Block sonst unbegrenzt wachsen: max. 12
// Bullet-Zeilen, die ersten 3 (der Seed) bleiben immer erhalten. Beim
// Überschreiten der Kappe fliegt die älteste NACH dem Seed gelernte Zeile
// raus (Bullet-Index PERSONA_SEED_BULLETS, 0-basiert = die vierte Bullet-Zeile).
const PERSONA_MAX_BULLETS = 12;
const PERSONA_SEED_BULLETS = 3;

function capManagedBlockBullets(content, { maxBullets = PERSONA_MAX_BULLETS, seedCount = PERSONA_SEED_BULLETS } = {}) {
  const beginIdx = content.indexOf(MARKER_BEGIN);
  const endIdx = content.indexOf(MARKER_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return content;
  const blockStart = beginIdx + MARKER_BEGIN.length;
  const lines = content.slice(blockStart, endIdx).split("\n");
  let bulletIdx = lines.reduce((acc, line, i) => { if (line.trim().startsWith("- ")) acc.push(i); return acc; }, []);
  while (bulletIdx.length > maxBullets && bulletIdx.length > seedCount) {
    lines.splice(bulletIdx[seedCount], 1);
    bulletIdx = lines.reduce((acc, line, i) => { if (line.trim().startsWith("- ")) acc.push(i); return acc; }, []);
  }
  return `${content.slice(0, blockStart)}${lines.join("\n")}${content.slice(endIdx)}`;
}

export function appendMarkerToManagedBlock(workspaceDir, markerLine) {
  try {
    if (typeof markerLine !== "string" || !markerLine.trim().startsWith("- ")) return false;
    const path = personaPath(workspaceDir);
    const parsed = readPersonaFile(workspaceDir);
    if (!parsed || parsed.managedBlock == null) return false;
    const endIdx = parsed.content.indexOf(MARKER_END);
    let updated = `${parsed.content.slice(0, endIdx).trimEnd()}\n${markerLine.trim()}\n${parsed.content.slice(endIdx)}`;
    updated = capManagedBlockBullets(updated);
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

/**
 * Wöchentliche Persona-Evolution: wendet einen vom LLM vorgeschlagenen Marker
 * DIREKT im Managed Block an (Auto-Apply). Ein Mensch fragt nicht um
 * Erlaubnis, bevor er seinen Sprechstil weiterentwickelt — daher keine
 * Proposal-Sektion mehr, kein Warten auf `/plur1bus persona accept`.
 *
 * Bestehende (alte) Proposal-Sektionen aus früheren Läufen werden dabei NICHT
 * automatisch übernommen — sie bleiben unangetastet stehen, `accept` kann sie
 * weiterhin manuell übernehmen (Rückwärtskompatibilität, siehe
 * acceptPersonaProposal).
 */
export async function evolvePersonaVoice({ workspaceDir, outcomes = [], llmCfg = null, callLlm = null, now = Date.now() } = {}) {
  try {
    const parsed = readPersonaFile(workspaceDir);
    if (!parsed || parsed.managedBlock == null) return { evolved: false, reason: "no_persona_file" };
    if (!llmCfg || typeof callLlm !== "function") return { evolved: false, reason: "no_llm" };

    const recent = (Array.isArray(outcomes) ? outcomes : []).filter(
      (o) => Number.isFinite(o?.timestamp) && now - o.timestamp <= EVOLUTION_WINDOW_MS,
    );
    if (recent.length < EVOLUTION_MIN_OUTCOMES) return { evolved: false, reason: "too_few_outcomes" };
    const positive = recent.filter((o) => EVO_POSITIVE.has(o.outcome)).length;
    const negative = recent.filter((o) => EVO_NEGATIVE.has(o.outcome)).length;
    if (positive + negative === 0 || positive / (positive + negative) <= EVOLUTION_MIN_POSITIVE_RATE) {
      return { evolved: false, reason: "no_positive_trend" };
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
    if (!marker) return { evolved: false, reason: "llm_no_marker" };

    if (!appendMarkerToManagedBlock(workspaceDir, marker)) return { evolved: false, reason: "append_failed" };
    return { evolved: true, marker };
  } catch (_) {
    return { evolved: false, reason: "error" };
  }
}

// Rückwärtskompatibilität: alter Funktionsname bleibt als Alias importierbar.
export const proposePersonaEvolution = evolvePersonaVoice;

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
