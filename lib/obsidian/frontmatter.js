export function yamlScalar(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value).replace(/\r?\n/g, " ").slice(0, 2000);
  if (!text || /[:#{}\[\],&*?|\-<>=!%@`"']|\s$|^\s/.test(text)) return JSON.stringify(text);
  return text;
}

function entryLines(key, value, scalar) {
  if (Array.isArray(value)) return [`${key}:`, ...value.map((item) => `  - ${scalar(item)}`)];
  return [`${key}: ${scalar(value)}`];
}

export function formatFrontmatter(frontmatter = {}, body = "") {
  const lines = ["---"];
  for (const key of Object.keys(frontmatter).sort()) {
    lines.push(...entryLines(key, frontmatter[key], yamlScalar));
  }
  lines.push("---", "");
  return `${lines.join("\n")}${String(body || "").replace(/^\n+/, "")}`;
}

// A top-level key starts in column 0 with anything but whitespace, `#` or `-`
// (a column-0 `- item` continues the key above) and ends at the first colon
// that is followed by whitespace or the end of the line. Spaces, dots and
// non-ASCII are allowed in the key; the lossy parser below is not.
const TOP_LEVEL_KEY = /^(?![\s#-])(.+?):(?:\s|$)/;

/**
 * Update only the given top-level keys inside a raw front-matter block.
 *
 * Every other line — keys with spaces or dots, nested mappings, block scalars,
 * flow collections, comments — is kept byte for byte and in its place. A key
 * that is updated has its whole block (the key line plus its indented or
 * column-0 `-` continuation lines) replaced; comment and blank lines that trail
 * the block stay. Keys that are not present yet are appended. `parseFrontmatter`
 * cannot represent most of that, so rewriting from its result used to drop it.
 *
 * @param {string} rawFrontmatter Front matter without the `---` fences.
 * @param {Record<string, unknown>} updates Keys to set (arrays become lists).
 * @param {{scalar?: (value: unknown) => string, sortNewKeys?: boolean}} [opts]
 * @returns {string} Front matter without fences.
 */
export function mergeFrontmatterKeys(rawFrontmatter, updates = {}, opts = {}) {
  const scalar = opts.scalar || yamlScalar;
  const pending = new Map(Object.entries(updates));
  const blocks = [];
  for (const line of String(rawFrontmatter || "").split(/\r?\n/)) {
    const match = line.match(TOP_LEVEL_KEY);
    if (match) blocks.push({ key: match[1].trim(), lines: [line] });
    else if (blocks.length === 0) blocks.push({ key: null, lines: [line] });
    else blocks[blocks.length - 1].lines.push(line);
  }
  if (blocks.length === 1 && blocks[0].key === null && blocks[0].lines.every((l) => l === "")) blocks.length = 0;
  const out = [];
  const written = new Set();
  for (const block of blocks) {
    if (block.key === null || !pending.has(block.key)) {
      out.push(...block.lines);
      continue;
    }
    const keep = [];
    while (block.lines.length > 1) {
      const last = block.lines[block.lines.length - 1];
      if (last.trim() === "" || /^#/.test(last)) keep.unshift(block.lines.pop());
      else break;
    }
    if (!written.has(block.key)) {
      out.push(...entryLines(block.key, pending.get(block.key), scalar));
      written.add(block.key);
    }
    out.push(...keep);
  }
  const fresh = [...pending.keys()].filter((key) => !written.has(key));
  if (opts.sortNewKeys !== false) fresh.sort();
  for (const key of fresh) out.push(...entryLines(key, pending.get(key), scalar));
  return out.join("\n");
}

/**
 * `---` fenced front matter plus body, built with `mergeFrontmatterKeys`.
 * @param {string} rawFrontmatter
 * @param {Record<string, unknown>} updates
 * @param {string} body
 * @param {Parameters<typeof mergeFrontmatterKeys>[2]} [opts]
 * @returns {string}
 */
export function formatFrontmatterPreserving(rawFrontmatter, updates, body = "", opts = {}) {
  return `---\n${mergeFrontmatterKeys(rawFrontmatter, updates, opts)}\n---\n${String(body || "").replace(/^\n+/, "")}`;
}

export function parseYamlScalar(rawValue) {
  const value = String(rawValue || "").trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseFrontmatter(content) {
  const text = String(content || "");
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text, rawFrontmatter: "" };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, body: text, rawFrontmatter: "" };
  const rawFrontmatter = text.slice(4, end);
  const body = text.slice(end + 5);
  const frontmatter = {};
  let currentKey = null;
  for (const line of rawFrontmatter.split(/\r?\n/)) {
    const list = line.match(/^\s+-\s+(.+)$/);
    if (list && currentKey) {
      if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = [];
      frontmatter[currentKey].push(parseYamlScalar(list[1]));
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) {
      currentKey = null;
      continue;
    }
    const [, key, rawValue = ""] = match;
    frontmatter[key] = rawValue === "" ? [] : parseYamlScalar(rawValue);
    currentKey = key;
  }
  return { frontmatter, body, rawFrontmatter };
}

