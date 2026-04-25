/**
 * lib/frontmatter.js — YAML-Frontmatter Parser/Builder für KNOWLEDGE.md.
 *
 * LLM bekommt nur den Body, Frontmatter wird programmatisch verwaltet.
 * Schützt strukturierte Metadaten (last_verified, source_memories, agent)
 * vor versehentlicher LLM-Mutation.
 */

/**
 * Trennt Frontmatter und Body. Wenn kein Frontmatter vorhanden:
 * frontmatter=null, body=ganzer content.
 */
export function stripFrontmatter(content) {
  if (!content.startsWith("---\n")) return { frontmatter: null, body: content };
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: null, body: content };
  return { frontmatter: content.slice(4, end), body: content.slice(end + 5) };
}

/**
 * Baut einen Frontmatter-Block aus Metadaten.
 * source_memories werden auf die letzten 50 begrenzt.
 */
export function buildFrontmatter({ agentId, sourceMemoryIds, today }) {
  const lines = ["---"];
  lines.push(`type: knowledge`);
  if (agentId) lines.push(`agent: ${agentId}`);
  lines.push(`last_verified: ${today}`);
  if (sourceMemoryIds && sourceMemoryIds.length > 0) {
    lines.push(`source_memories:`);
    for (const id of sourceMemoryIds.slice(-50)) lines.push(`  - ${id}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

/**
 * Hängt einen frischen Frontmatter-Block an einen Body — ersetzt einen
 * etwaigen vorhandenen Frontmatter komplett.
 */
export function withFrontmatter(content, fmMeta) {
  const { body } = stripFrontmatter(content);
  return buildFrontmatter(fmMeta) + body.replace(/^\n+/, "");
}

/**
 * Extrahiert source_memories-IDs aus einem Frontmatter-String. Toleriert
 * unvollständige YAML-Strukturen.
 */
export function parseSourceMemoryIds(frontmatter) {
  if (!frontmatter) return [];
  const m = frontmatter.match(/source_memories:\s*\n((?:\s+-\s+.+\n?)*)/);
  if (!m) return [];
  return m[1].split("\n").map(l => l.replace(/^\s+-\s+/, "").trim()).filter(Boolean);
}
