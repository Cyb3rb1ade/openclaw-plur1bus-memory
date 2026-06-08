/**
 * memory-note-writer: Write vault mirror notes for LanceDB memory records.
 *
 * Creates/updates human-readable Obsidian notes at {reviewPath}/memories/{id}.md
 * for each LanceDB memory record. Uses content_hash frontmatter for idempotency.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeContentHash } from "./link-index.js";
import { atomicWriteText, resolveReviewPath } from "./safe-paths.js";

/**
 * Extract the stored content_hash from a memory note's frontmatter.
 * Uses a simple line-by-line match — no YAML library dependency.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function readFrontmatterHash(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    const match = text.match(/^content_hash: (.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Sanitize a value for use in YAML frontmatter by collapsing newlines.
 *
 * @param {*} v
 * @returns {string}
 */
function sanitizeYaml(v) {
  return String(v ?? "").replace(/[\r\n]+/g, " ").trim();
}

/**
 * Render a memory note's markdown content.
 *
 * @param {Object} record - LanceDB memory record
 * @param {string} contentHash - Pre-computed content hash
 * @returns {string} Full markdown content
 */
function renderNote(record, contentHash) {
  const title = record.summary
    ? String(record.summary).slice(0, 80)
    : String(record.text || "").slice(0, 80);

  return [
    "---",
    `memory_id: ${record.id}`,
    `plur1bus_type: memory`,
    `category: ${sanitizeYaml(record.category)}`,
    `importance: ${record.importance ?? 0.5}`,
    `scope: ${sanitizeYaml(record.scope)}`,
    `created_at: ${sanitizeYaml(record.createdAt)}`,
    `content_hash: ${contentHash}`,
    "---",
    "",
    `# ${sanitizeYaml(title)}`,
    "",
    record.text || "",
  ].join("\n");
}

/**
 * Write vault mirror notes for an array of LanceDB memory records.
 *
 * @param {Object} rawConfig - Bridge config containing obsidianBridge settings
 *   (vaultPath, reviewRoot, etc.)
 * @param {Array<Object>} records - LanceDB records with shape:
 *   { id, vector, text, summary, category, importance, createdAt, scope, status }
 * @param {Object} options
 * @param {number} [options.maxPerRun=200] - Max records to process per call
 * @param {Object} [options.logger] - Logger with .warn() method
 * @param {boolean} [options.dryRun=false] - If true, compute everything but write nothing
 * @returns {{ written: number, skipped: number, errors: number }}
 */
export function writeMemoryNotes(rawConfig, records, options = {}) {
  const { logger, maxPerRun = 200, dryRun = false } = options;

  const { reviewPath } = resolveReviewPath(rawConfig, ".");
  const memoriesDir = join(reviewPath, "memories");

  if (!dryRun && !existsSync(memoriesDir)) {
    mkdirSync(memoriesDir, { recursive: true });
  }

  let written = 0;
  let skipped = 0;
  let errors = 0;
  let runCount = 0;

  for (const record of records) {
    if (runCount >= maxPerRun) break;

    if (!record.id) {
      skipped++;
      continue;
    }

    runCount++;

    const contentHash = computeContentHash(record);
    const filePath = join(memoriesDir, `${record.id}.md`);

    // Check if unchanged
    if (!dryRun && existsSync(filePath)) {
      const storedHash = readFrontmatterHash(filePath);
      if (storedHash === contentHash) {
        skipped++;
        continue;
      }
    }

    if (dryRun) {
      // In dryRun mode: count as skipped (not written), no file I/O
      skipped++;
      continue;
    }

    try {
      atomicWriteText(filePath, renderNote(record, contentHash));
      written++;
    } catch (err) {
      logger?.warn?.(`plur1bus-memory-notes: failed to write ${record.id}: ${err?.message}`);
      errors++;
    }
  }

  return { written, skipped, errors };
}
