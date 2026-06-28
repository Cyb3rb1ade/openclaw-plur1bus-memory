/**
 * memory-note-writer: Write vault mirror notes for LanceDB memory records.
 *
 * Creates/updates human-readable Obsidian notes at {reviewPath}/memories/{id}.md
 * for each LanceDB memory record. Uses content_hash frontmatter for idempotency.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { computeContentHash } from "./link-index.js";
import { atomicWriteText, resolveReviewPath, safeSlug } from "./safe-paths.js";

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

function firstNonEmpty(...values) {
  for (const value of values) {
    const sanitized = sanitizeYaml(value);
    if (sanitized) return sanitized;
  }
  return "";
}

function frontmatterField(rawFrontmatter, key) {
  const match = rawFrontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  return match ? match[1].trim() : null;
}

function insertFrontmatterLines(rawFrontmatter, linesToAdd) {
  const lines = rawFrontmatter.split(/\r?\n/);
  const anchor = lines.findIndex((line) => /^plur1bus_type:\s*memory\s*$/.test(line));
  const insertAt = anchor >= 0 ? anchor + 1 : Math.min(lines.length, 2);
  lines.splice(insertAt, 0, ...linesToAdd);
  return lines.join("\n");
}

/**
 * Add missing workspace scope fields to an existing memory note frontmatter.
 *
 * @param {string} content - Existing note content
 * @param {Object} scope
 * @param {string} scope.agentId - Expected agent id
 * @param {string} scope.workspaceId - Expected workspace id
 * @returns {{ content: string, changed: boolean, conflict: string|null, added: string[] }}
 */
export function addMemoryNoteScopeFrontmatter(content, { agentId, workspaceId } = {}) {
  const text = String(content || "");
  if (!text.startsWith("---\n")) return { content: text, changed: false, conflict: "missing_frontmatter", added: [] };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { content: text, changed: false, conflict: "malformed_frontmatter", added: [] };

  const rawFrontmatter = text.slice(4, end);
  if (!/^plur1bus_type:\s*memory\s*$/m.test(rawFrontmatter)) {
    return { content: text, changed: false, conflict: "not_memory_note", added: [] };
  }

  const expectedAgentId = sanitizeYaml(agentId);
  const expectedWorkspaceId = sanitizeYaml(workspaceId);
  const existingAgentId = frontmatterField(rawFrontmatter, "agent_id");
  const existingWorkspaceId = frontmatterField(rawFrontmatter, "workspace_id");
  if (existingAgentId && expectedAgentId && existingAgentId !== expectedAgentId) {
    return { content: text, changed: false, conflict: "agent_id_mismatch", added: [] };
  }
  if (existingWorkspaceId && expectedWorkspaceId && existingWorkspaceId !== expectedWorkspaceId) {
    return { content: text, changed: false, conflict: "workspace_id_mismatch", added: [] };
  }

  const additions = [];
  const added = [];
  if (!existingAgentId && expectedAgentId) {
    additions.push(`agent_id: ${expectedAgentId}`);
    added.push("agent_id");
  }
  if (!existingWorkspaceId && expectedWorkspaceId) {
    additions.push(`workspace_id: ${expectedWorkspaceId}`);
    added.push("workspace_id");
  }
  if (additions.length === 0) return { content: text, changed: false, conflict: null, added: [] };

  const nextFrontmatter = insertFrontmatterLines(rawFrontmatter, additions);
  return {
    content: `---\n${nextFrontmatter}${text.slice(end)}`,
    changed: true,
    conflict: null,
    added,
  };
}

/**
 * Render a memory note's markdown content.
 *
 * @param {Object} record - LanceDB memory record
 * @param {string} contentHash - Pre-computed content hash
 * @param {Object} rawConfig - Bridge config with workspace identity
 * @returns {string} Full markdown content
 */
function renderNote(record, contentHash, rawConfig = {}) {
  const title = record.summary
    ? String(record.summary).slice(0, 80)
    : String(record.text || "").slice(0, 80);
  const agentId = firstNonEmpty(record.agent_id, record.agentId, rawConfig.agent_id, rawConfig.agentId);
  const workspaceId = firstNonEmpty(
    record.workspace_id,
    record.workspaceId,
    record.workspaceKey,
    rawConfig.workspace_id,
    rawConfig.workspaceId,
    rawConfig.workspaceKey,
  );

  const lines = [
    "---",
    `memory_id: ${sanitizeYaml(record.id)}`,
    `plur1bus_type: memory`,
  ];
  if (agentId) lines.push(`agent_id: ${agentId}`);
  if (workspaceId) lines.push(`workspace_id: ${workspaceId}`);

  return [
    ...lines,
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
    // Slug the id before using it as a filename: a record id is not guaranteed
    // to be a UUID (e.g. shared-memory / import paths accept caller-supplied ids),
    // and a raw id with path segments ("../…") would escape the memories dir,
    // bypassing the safe-paths guard. UUIDs are unchanged by safeSlug.
    const filePath = join(memoriesDir, `${safeSlug(record.id)}.md`);

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
      atomicWriteText(filePath, renderNote(record, contentHash, rawConfig));
      written++;
    } catch (err) {
      logger?.warn?.(`plur1bus-memory-notes: failed to write ${record.id}: ${err?.message}`);
      errors++;
    }
  }

  return { written, skipped, errors };
}

/**
 * Backfill agent_id/workspace_id into existing memory mirror notes.
 *
 * @param {Object} rawConfig - Bridge config with vaultPath, reviewRoot, agentId, workspaceKey
 * @param {Object} options
 * @param {boolean} [options.dryRun=false] - If true, report changes without writing
 * @returns {{ updated: number, skipped: number, conflicts: number, errors: number, examples: Array }}
 */
export function backfillMemoryNoteScope(rawConfig, options = {}) {
  const { dryRun = false, maxExamples = 5, logger } = options;
  const { reviewPath } = resolveReviewPath(rawConfig, ".");
  const memoriesDir = join(reviewPath, "memories");
  const result = { updated: 0, skipped: 0, conflicts: 0, errors: 0, examples: [] };
  if (!existsSync(memoriesDir)) return result;

  const agentId = firstNonEmpty(rawConfig.agent_id, rawConfig.agentId);
  const workspaceId = firstNonEmpty(rawConfig.workspace_id, rawConfig.workspaceId, rawConfig.workspaceKey);

  for (const entry of readdirSync(memoriesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(memoriesDir, entry.name);
    try {
      const current = readFileSync(filePath, "utf8");
      const next = addMemoryNoteScopeFrontmatter(current, { agentId, workspaceId });
      if (next.conflict) {
        if (next.conflict === "not_memory_note") result.skipped++;
        else result.conflicts++;
        continue;
      }
      if (!next.changed) {
        result.skipped++;
        continue;
      }
      result.updated++;
      if (result.examples.length < maxExamples) {
        result.examples.push({ filePath, added: next.added, before: current, after: next.content });
      }
      if (!dryRun) atomicWriteText(filePath, next.content);
    } catch (err) {
      logger?.warn?.(`plur1bus-memory-notes: failed to backfill scope for ${entry.name}: ${err?.message}`);
      result.errors++;
    }
  }

  return result;
}
