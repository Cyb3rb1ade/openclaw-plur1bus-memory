import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { resolveReviewPath } from "./safe-paths.js";
import { resolveInside } from "../sql-safety.js";
import { mutationAllowed } from "../obsidian-mutation-policy.js";

const ARCHIVE_EXTS = new Set([".json", ".md", ".txt"]);

function isArchiveFile(name) {
  const lower = String(name).toLowerCase();
  for (const ext of ARCHIVE_EXTS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Rotate (move or delete) old archive files in a directory.
 *
 * Safety rules:
 *   - Default dryRun: true. No file is changed unless explicitly opted in.
 *   - Default action when not dryRun: "move" into archiveDir/stale/.
 *   - action: "delete" only allowed when opts.allowDelete === true.
 *   - resolveInside() guards every path; path traversal is blocked.
 *   - Symlinks are skipped (lstatSync, no follow).
 *   - stale/ is never scanned recursively.
 *   - Only known archive extensions are touched: .json, .md, .txt.
 *
 * @param {string} archiveDir — absolute path to the archive directory
 * @param {object} opts
 * @param {boolean} [opts.dryRun=true]
 * @param {"move"|"delete"} [opts.action="move"]
 * @param {boolean} [opts.allowDelete=false]
 * @param {number|null} [opts.maxAgeDays]
 * @param {number|null} [opts.maxSizeMB]
 * @returns {{dryRun: boolean, action: string, moved: number, deleted: number, skipped: number, totalSizeMB: number, files: Array<{name: string, action: string, [key: string]: any}>}}
 */
export function rotateOldArchives(archiveDir, opts = {}) {
  const action = opts.action || "move";
  const requiredCapability = action === "delete" ? "archive_delete" : "archive_move";
  const dryRun = opts.dryRun !== false
    || !mutationAllowed(opts.mutationPolicy, requiredCapability);
  const allowDelete = opts.allowDelete === true;
  const maxAgeDays = opts.maxAgeDays ?? null;
  const maxSizeMB = opts.maxSizeMB ?? null;

  if (!archiveDir || typeof archiveDir !== "string") {
    throw new Error("rotateOldArchives: archiveDir must be a non-empty string");
  }

  if (!existsSync(archiveDir)) {
    return { dryRun, action: dryRun ? "report" : action, moved: 0, deleted: 0, skipped: 0, totalSizeMB: 0, files: [] };
  }

  // Ensure archiveDir itself is safe (resolve it)
  const safeArchiveDir = resolveInside(archiveDir);

  const files = [];
  for (const entry of readdirSync(safeArchiveDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name === "." || name === "..") continue;
    if (!isArchiveFile(name)) continue;

    const filePath = join(safeArchiveDir, name);

    // Do not follow symlinks
    let st;
    try {
      st = lstatSync(filePath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;

    const ageDays = Math.floor((Date.now() - st.mtimeMs) / 86400000);
    if (maxAgeDays !== null && ageDays < maxAgeDays) continue;

    // Extra path-safety: resolved path must still be inside archiveDir
    try {
      resolveInside(safeArchiveDir, name);
    } catch {
      continue;
    }

    files.push({ name, path: filePath, mtimeMs: st.mtimeMs, size: st.size, ageDays });
  }

  // Oldest first
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const totalSizeBytes = files.reduce((sum, f) => sum + f.size, 0);
  const totalSizeMB = totalSizeBytes / (1024 * 1024);

  // Determine target files based on criteria
  const targetFiles = [];
  if (maxSizeMB !== null && totalSizeMB > maxSizeMB) {
    let runningSize = totalSizeBytes;
    const limitBytes = maxSizeMB * 1024 * 1024;
    for (const f of files) {
      if (runningSize <= limitBytes) break;
      targetFiles.push(f);
      runningSize -= f.size;
    }
  } else if (maxAgeDays !== null) {
    for (const f of files) targetFiles.push(f);
  } else {
    // No criteria → nothing to do
    return { dryRun, action: dryRun ? "report" : action, moved: 0, deleted: 0, skipped: 0, totalSizeMB: Math.round(totalSizeMB * 100) / 100, files: [] };
  }

  let effectiveAction = dryRun ? "report" : action;
  if (effectiveAction === "delete" && !allowDelete) {
    effectiveAction = "move";
  }

  const result = {
    dryRun,
    action: effectiveAction,
    moved: 0,
    deleted: 0,
    skipped: 0,
    totalSizeMB: Math.round(totalSizeMB * 100) / 100,
    files: [],
  };

  const staleDir = join(safeArchiveDir, "stale");
  if (!dryRun && effectiveAction === "move") {
    try {
      resolveInside(safeArchiveDir, "stale");
    } catch {
      // If stale/ itself is blocked, fall back to dry-run behavior for safety
      effectiveAction = "report";
      result.action = "report";
    }
    if (effectiveAction === "move" && !existsSync(staleDir)) {
      mkdirSync(staleDir, { recursive: true });
    }
  }

  for (const f of targetFiles) {
    if (dryRun || effectiveAction === "report") {
      result.files.push({ name: f.name, action: "report", ageDays: f.ageDays, sizeBytes: f.size });
      continue;
    }

    if (effectiveAction === "move") {
      const dest = join(staleDir, f.name);
      try {
        resolveInside(safeArchiveDir, "stale", f.name);
        renameSync(f.path, dest);
        result.moved++;
        result.files.push({ name: f.name, action: "moved", dest: `stale/${f.name}` });
      } catch (e) {
        result.skipped++;
        result.files.push({ name: f.name, action: "skipped", reason: e?.message || String(e) });
      }
    } else if (effectiveAction === "delete") {
      try {
        unlinkSync(f.path);
        result.deleted++;
        result.files.push({ name: f.name, action: "deleted" });
      } catch (e) {
        result.skipped++;
        result.files.push({ name: f.name, action: "skipped", reason: e?.message || String(e) });
      }
    }
  }

  return result;
}

export function findArchiveCandidates(rawConfig, options = {}) {
  const days = Number(options.archiveAfterDays ?? rawConfig.deepMaintenance?.archiveAfterDays ?? 30);
  const cutoff = Date.now() - days * 86400000;
  const dirs = ["review-bundles", "conflicts", "weekly"];
  const candidates = [];
  const { reviewPath } = resolveReviewPath(rawConfig, ".");
  for (const dir of dirs) {
    const abs = join(reviewPath, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = join(abs, entry.name);
      const st = statSync(file);
      if (st.mtimeMs < cutoff) candidates.push({ path: `${dir}/${entry.name}`, ageDays: Math.floor((Date.now() - st.mtimeMs) / 86400000), action: "archive_proposal" });
    }
  }
  return candidates;
}
