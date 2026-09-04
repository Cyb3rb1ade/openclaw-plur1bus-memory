import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { loadOpenClawPluginSdkRuntime } from "../setup/feature-cron-plugin-runtime.js";

/**
 * Dream diary bridge.
 *
 * OpenClaw's Control UI (Settings → Memory → Dreams → Diary) shows one file:
 * `DREAMS.md` in the agent's workspace, read as a whole through the host's
 * `doctor.memory.dreamDiary` method. The host does not ask the memory plugin
 * for it. So the way for a PLUR1BUS dream to appear on that page is to write
 * it into that file, in the block and the entry shape the host itself uses:
 *
 *   # Dream Diary
 *   <!-- openclaw:dreaming:diary:start -->
 *   ---
 *   *September 4, 2026 at 3:06 AM GMT+2*
 *   <narrative>
 *   <!-- openclaw:dreaming:diary:end -->
 *
 * The host's own maintenance (dedupe, backfill strip, artifact repair) works
 * on fingerprints and on blocks it marked itself, so a foreign entry in this
 * shape survives it. That is read from the host source, not a contract.
 */
export const DREAM_DIARY_FILE_NAMES = Object.freeze(["DREAMS.md", "dreams.md"]);
export const DIARY_HEADING = "# Dream Diary";
export const DIARY_START_MARKER = "<!-- openclaw:dreaming:diary:start -->";
export const DIARY_END_MARKER = "<!-- openclaw:dreaming:diary:end -->";
export const DIARY_MAX_NARRATIVE_CHARS = 8_000;
const DIARY_MAX_FILE_BYTES = 8 * 1024 * 1024;
const MODE_LABELS = Object.freeze({ light: "light dream", rem: "REM dream" });

/** Same shape as the host's own diary timestamp, e.g. "September 4, 2026 at 3:06 AM GMT+2". */
export function formatDiaryDate(epochMs, timezone) {
  const options = {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  };
  if (typeof timezone === "string" && timezone.trim()) options.timeZone = timezone.trim();
  try {
    return new Intl.DateTimeFormat("en-US", options).format(new Date(epochMs));
  } catch {
    delete options.timeZone;
    return new Intl.DateTimeFormat("en-US", options).format(new Date(epochMs));
  }
}

function normalizeNarrative(narrative) {
  if (typeof narrative !== "string") return "";
  const text = narrative.replace(/\r\n?/g, "\n").trim();
  if (!text) return "";
  return text.length > DIARY_MAX_NARRATIVE_CHARS ? `${text.slice(0, DIARY_MAX_NARRATIVE_CHARS).trimEnd()}…` : text;
}

/** Stable identity of one narrative, used to keep a re-run from writing the same dream twice. */
export function narrativeFingerprint(narrative) {
  return createHash("sha256").update(normalizeNarrative(narrative).replace(/\s+/g, " ").toLowerCase()).digest("hex").slice(0, 16);
}

/** One diary entry in the host's shape, with a small source line so the reader can tell who dreamt. */
export function buildDiaryEntry({ narrative, mode = "rem", dateText }) {
  const text = normalizeNarrative(narrative);
  if (!text) throw new Error("dream diary entry needs a narrative");
  const label = MODE_LABELS[mode] || `${String(mode)} dream`;
  return `\n---\n\n*${dateText}*\n\n${text}\n\n<sub>PLUR1BUS · ${label} · ${narrativeFingerprint(text)}</sub>\n`;
}

/**
 * Insert an entry into the diary block of an existing file body.
 * @returns {{content: string, changed: boolean, reason?: string}}
 */
export function insertDiaryEntry(existing, entry, { narrative } = {}) {
  const original = typeof existing === "string" ? existing.replace(/\r\n?/g, "\n") : "";
  const fingerprint = narrativeFingerprint(narrative ?? entry);
  if (original.includes(fingerprint)) return { content: original, changed: false, reason: "already_present" };
  const startIdx = original.indexOf(DIARY_START_MARKER);
  const endIdx = original.lastIndexOf(DIARY_END_MARKER);
  if (startIdx >= 0 && endIdx > startIdx) {
    return { content: `${original.slice(0, endIdx)}${entry}${original.slice(endIdx)}`, changed: true };
  }
  // No diary block yet: put one at the top, the way the host does, and keep
  // whatever else the file already holds below it.
  const section = `${DIARY_HEADING}\n\n${DIARY_START_MARKER}${entry}\n${DIARY_END_MARKER}\n`;
  const rest = original.trim().length === 0 ? "" : `\n${original.replace(/^\n+/, "")}`;
  return { content: `${section}${rest}`, changed: true };
}

function resolveDiaryPath(workspaceDir) {
  const root = resolve(workspaceDir);
  for (const name of DREAM_DIARY_FILE_NAMES) {
    const candidate = join(root, name);
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("dream diary path is a symbolic link");
    if (!stat.isFile()) throw new Error("dream diary path is not a regular file");
    if (stat.size > DIARY_MAX_FILE_BYTES) throw new Error("dream diary file is too large to update");
    return { path: candidate, exists: true };
  }
  return { path: join(root, DREAM_DIARY_FILE_NAMES[0]), exists: false };
}

function writeAtomically(path, content) {
  const dir = dirname(path);
  const tmpDir = mkdtempSync(join(dir, `.${basename(path)}.tmp-`));
  const tmpFile = join(tmpDir, basename(path));
  try {
    writeFileSync(tmpFile, content, "utf8");
    renameSync(tmpFile, path);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Append one dream to the agent's diary file. Fail-open by contract: a dream
 * that cannot be written to the diary is still a dream, so this never throws
 * and reports what it did instead.
 * @returns {{written: boolean, path: string|null, reason?: string}}
 */
export function appendDreamDiaryEntry({
  workspaceDir,
  narrative,
  mode = "rem",
  timezone = null,
  now = Date.now,
  logger = null,
} = {}) {
  if (typeof workspaceDir !== "string" || !workspaceDir.trim()) return { written: false, path: null, reason: "no_workspace" };
  const text = normalizeNarrative(narrative);
  if (!text) return { written: false, path: null, reason: "empty_narrative" };
  try {
    const { path, exists } = resolveDiaryPath(workspaceDir);
    const existing = exists ? readFileSync(path, "utf8") : "";
    const entry = buildDiaryEntry({ narrative: text, mode, dateText: formatDiaryDate(now(), timezone) });
    const next = insertDiaryEntry(existing, entry, { narrative: text });
    if (!next.changed) return { written: false, path, reason: next.reason };
    writeAtomically(path, next.content);
    logger?.info?.(`dream-diary[${mode}]: entry appended to ${basename(path)}`);
    return { written: true, path };
  } catch (error) {
    logger?.warn?.(`dream-diary[${mode}]: diary not updated (fail-open): ${error?.message || error}`);
    return { written: false, path: null, reason: "write_failed" };
  }
}

/**
 * Tell the host a dream completed, through its public event log. The Dreams
 * page does not depend on it, but the host's own tooling reads that log, and
 * the shape is the one memory-core itself writes. Fail-open like the diary.
 */
export async function emitDreamCompletedEvent({
  workspaceDir,
  mode = "rem",
  narrative,
  now = Date.now,
  // A bare import of "openclaw/..." does not resolve from the extension
  // directory; the SDK loader finds the active host package first.
  importHostEvents = () => loadOpenClawPluginSdkRuntime("memory-host-events"),
  logger = null,
} = {}) {
  if (typeof workspaceDir !== "string" || !workspaceDir.trim()) return false;
  const phase = mode === "light" ? "light" : "rem";
  const lineCount = normalizeNarrative(narrative).split("\n").filter((line) => line.trim()).length;
  try {
    const host = await importHostEvents();
    if (typeof host?.appendMemoryHostEvent !== "function") return false;
    await host.appendMemoryHostEvent(workspaceDir, {
      type: "memory.dream.completed",
      timestamp: new Date(now()).toISOString(),
      phase,
      outcome: "completed",
      lineCount,
      storageMode: "inline",
    });
    return true;
  } catch (error) {
    logger?.warn?.(`dream-diary[${mode}]: host event not written (fail-open): ${error?.message || error}`);
    return false;
  }
}
